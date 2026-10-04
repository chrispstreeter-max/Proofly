import { recomputeProduct } from "./aggregates.server";
import { DEFAULT_PLAN, PLANS, planHasFeature, type Feature, type Plan, type PlanKey } from "./plans";
import { PUBLIC_REVIEW } from "./reviews.server";
import type { Tenant } from "./tenant.server";

/**
 * Entitlements — the single application interface for what a merchant's plan allows.
 *
 * Plans limit what is PUBLIC, never what the merchant owns: nothing here deletes a review or a photo.
 *  - Published-review usage = reviews currently public (published AND not held), from every source.
 *  - Public-media usage = bytes of optimised derivatives with media_status = published (servable photos).
 *  - Grandfathering: reviews/photos already public stay public whatever the plan; limits apply only to what becomes
 *    public next. Everything that is about to become public is first HELD (plan_limit / storage_limited) and then
 *    released here, oldest first, while there is room.
 *  - Fairness: which reviews/photos fit is decided by date order ONLY (REVIEW_ADMISSION_ORDER / MEDIA_ADMISSION_ORDER).
 *    Never rating, sentiment, text, name, photos, verification or product.
 */

/** The ONLY orderings allowed when an allowance decides what becomes public. Chronological, oldest first. */
export const REVIEW_ADMISSION_ORDER = Object.freeze([{ reviewDate: "asc" }, { createdAt: "asc" }, { id: "asc" }] as const);
export const MEDIA_ADMISSION_ORDER = Object.freeze([{ review: { reviewDate: "asc" } }, { createdAt: "asc" }, { position: "asc" }, { id: "asc" }] as const);

export async function getBillingState({ db, shopId }: Tenant) {
  return (await db.billingState.findUnique({ where: { shopId } })) ?? db.billingState.create({ data: { shopId, plan: DEFAULT_PLAN } });
}

export async function getCurrentPlan(t: Tenant): Promise<Plan> {
  return PLANS[(await getBillingState(t)).plan];
}

export const getReviewAllowance = async (t: Tenant) => (await getCurrentPlan(t)).publishedReviewAllowance;
export const getPublicMediaAllowance = async (t: Tenant) => (await getCurrentPlan(t)).publicMediaBytes;

/** Feature available = shipped (FEATURES.released) AND included in the shop's current plan. */
export async function can(t: Tenant, feature: Feature) {
  return planHasFeature((await getBillingState(t)).plan as PlanKey, feature);
}

export interface Usage {
  publishedReviews: number;
  awaitingModeration: number;
  planLimitedReviews: number; // approved, held by the plan allowance (eligible to publish once there is room)
  storageLimitedPhotos: number;
  publicMediaBytes: number;
  rejected: number;
  hidden: number;
}

export async function getUsage({ db, shopId }: Tenant): Promise<Usage> {
  const [publishedReviews, awaitingModeration, planLimitedReviews, rejected, hidden, storageLimitedPhotos, media] = await Promise.all([
    db.review.count({ where: { shopId, ...PUBLIC_REVIEW } }),
    db.review.count({ where: { shopId, status: "pending" } }),
    db.review.count({ where: { shopId, status: "published", holdReason: "plan_limit" } }),
    db.review.count({ where: { shopId, status: "rejected" } }),
    db.review.count({ where: { shopId, status: "hidden" } }),
    db.reviewImage.count({ where: { shopId, mediaStatus: "storage_limited" } }),
    db.reviewImage.aggregate({ where: { shopId, mediaStatus: "published" }, _sum: { publicBytes: true } }),
  ]);
  return { publishedReviews, awaitingModeration, planLimitedReviews, storageLimitedPhotos, publicMediaBytes: media._sum.publicBytes ?? 0, rejected, hidden };
}

/** Plan status for the admin: allowance vs usage, including grandfathered overage (usage may exceed allowance). */
export async function getPlanStatus(t: Tenant) {
  const [state, usage] = await Promise.all([getBillingState(t), getUsage(t)]);
  const plan = PLANS[state.plan];
  return {
    plan, state, usage,
    reviewRoom: Math.max(0, plan.publishedReviewAllowance - usage.publishedReviews),
    mediaRoom: Math.max(0, plan.publicMediaBytes - usage.publicMediaBytes),
    overReviewAllowance: usage.publishedReviews > plan.publishedReviewAllowance,
    overMediaAllowance: usage.publicMediaBytes > plan.publicMediaBytes,
  };
}

export async function canPublishReview(t: Tenant) {
  return (await getPlanStatus(t)).reviewRoom > 0;
}
export async function canPublishPhoto(t: Tenant, bytes: number) {
  return (await getPlanStatus(t)).mediaRoom >= bytes;
}

/** Serialises allowance decisions per shop (two concurrent approvals can't both take the last slot). */
const lockShop = (t: Tenant) => t.db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`entitlements:${t.shopId}`}))`;

/**
 * Releases plan-limited reviews (status published, hold plan_limit) into public view, OLDEST FIRST, while the plan has
 * room. `reviewIds` limits the candidates (e.g. just-approved or just-imported reviews); without it every eligible
 * held review is a candidate ("Publish eligible reviews"). Reviews that don't fit simply stay held — never rejected,
 * never deleted. Grandfathered public reviews are never touched.
 */
export async function releaseEligibleReviews(t: Tenant, opts: { reviewIds?: string[]; actor?: string } = {}) {
  const { db, shopId } = t;
  await lockShop(t);
  const where = { shopId, status: "published" as const, holdReason: "plan_limit" as const, ...(opts.reviewIds ? { id: { in: opts.reviewIds } } : {}) };
  const candidates = await db.review.count({ where });
  const { reviewRoom } = await getPlanStatus(t);
  if (!candidates) return { released: 0, stillHeld: 0 };
  const toRelease = reviewRoom > 0
    ? await db.review.findMany({ where, orderBy: [...REVIEW_ADMISSION_ORDER], take: reviewRoom, select: { id: true, productId: true } })
    : [];
  if (toRelease.length) {
    await db.review.updateMany({ where: { shopId, id: { in: toRelease.map((r) => r.id) } }, data: { holdReason: null } });
    for (const pid of new Set(toRelease.map((r) => r.productId))) await recomputeProduct(t, pid);
  }
  const stillHeld = candidates - toRelease.length;
  if (opts.actor && (toRelease.length || stillHeld)) {
    await db.auditLog.create({ data: { shopId, actor: opts.actor, action: "plan.reviews_released", entity: "reviews", details: { released: toRelease.length, stillHeld } } });
  }
  return { released: toRelease.length, stillHeld };
}

/**
 * Releases storage-limited photos into public view, oldest first, while the public-media allowance has room. Strict date
 * order: the first photo that does not fit stops the release (a later, smaller photo never jumps the queue). Photos that
 * don't fit stay storage-limited: original kept privately, never served, never deleted.
 */
export async function releaseEligibleMedia(t: Tenant, opts: { imageIds?: string[]; actor?: string } = {}) {
  const { db, shopId } = t;
  await lockShop(t);
  const where = { shopId, mediaStatus: "storage_limited" as const, ...(opts.imageIds ? { id: { in: opts.imageIds } } : {}) };
  const candidates = await db.reviewImage.findMany({ where, orderBy: [...MEDIA_ADMISSION_ORDER], select: { id: true, publicBytes: true, review: { select: { productId: true } } } });
  let { mediaRoom } = await getPlanStatus(t);
  const fit: typeof candidates = [];
  for (const c of candidates) {
    if (c.publicBytes > mediaRoom) break;
    mediaRoom -= c.publicBytes;
    fit.push(c);
  }
  if (fit.length) {
    await db.reviewImage.updateMany({ where: { shopId, id: { in: fit.map((c) => c.id) } }, data: { mediaStatus: "published" } });
    for (const pid of new Set(fit.map((c) => c.review.productId))) await recomputeProduct(t, pid); // photo-review count
  }
  const stillLimited = candidates.length - fit.length;
  if (opts.actor && (fit.length || stillLimited)) {
    await db.auditLog.create({ data: { shopId, actor: opts.actor, action: "plan.media_released", entity: "review_images", details: { released: fit.length, stillLimited } } });
  }
  return { released: fit.length, stillLimited };
}

/**
 * Makes reviews public subject to the allowance: they are held first, then released oldest-first while there is room.
 * Used by approval, auto-published submissions and imports.
 */
export async function admitReviews(t: Tenant, reviewIds: string[], actor?: string) {
  if (!reviewIds.length) return { released: 0, stillHeld: 0 };
  await t.db.review.updateMany({ where: { shopId: t.shopId, id: { in: reviewIds }, status: "published", holdReason: null }, data: { holdReason: "plan_limit" } });
  return releaseEligibleReviews(t, { reviewIds, actor });
}

/** Makes newly stored photos public subject to the media allowance (held as storage_limited first). */
export async function admitMedia(t: Tenant, imageIds: string[], actor?: string) {
  if (!imageIds.length) return { released: 0, stillLimited: 0 };
  await t.db.reviewImage.updateMany({ where: { shopId: t.shopId, id: { in: imageIds }, mediaStatus: "published" }, data: { mediaStatus: "storage_limited" } });
  return releaseEligibleMedia(t, { imageIds, actor });
}
