import { recomputeProducts } from "./aggregates.server";
import { DEFAULT_PLAN, PLANS, planHasFeature, type Feature, type Plan, type PlanKey } from "./plans";
import { bucketOf, bulkRelease, getReview, scanReviews, updateReview, type ShopApi, type StoredReview } from "./review-store.server";
import { withTenant, type Tenant } from "./tenant.server";

/**
 * Entitlements — the single application interface for what a merchant's plan allows.
 *
 * Plans limit what is PUBLIC, never what the merchant owns: nothing here deletes a review.
 *  - Published-review usage = reviews currently public (published AND not held), from every source.
 *  - Grandfathering: reviews already public stay public whatever the plan; limits apply only to what becomes public
 *    next. Everything that is about to become public is first HELD and then released here, oldest first, while there
 *    is room.
 *  - Fairness: which reviews fit is decided by date order ONLY (REVIEW_ADMISSION_ORDER). Never rating, sentiment,
 *    text, name, verification or product.
 */

/**
 * The ONLY ordering allowed when an allowance decides what becomes public: review date, oldest first; equal dates by
 * the review's stable handle (a hash of source + source review id — deterministic, not a quality signal), so the
 * outcome never depends on the order rows arrived in. Matches the store's display-name sort ("date | handle").
 */
export const REVIEW_ADMISSION_ORDER = Object.freeze(["reviewDate", "handle"] as const);
export const byAdmissionOrder = (a: Pick<StoredReview, "reviewDate" | "handle">, b: Pick<StoredReview, "reviewDate" | "handle">) =>
  +a.reviewDate - +b.reviewDate || (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0);

export async function getBillingState({ db, shopId }: Tenant) {
  return (await db.billingState.findUnique({ where: { shopId } })) ?? db.billingState.create({ data: { shopId, plan: DEFAULT_PLAN } });
}

export async function getCurrentPlan(t: Tenant): Promise<Plan> {
  return PLANS[(await getBillingState(t)).plan];
}

export const getReviewAllowance = async (t: Tenant) => (await getCurrentPlan(t)).publishedReviewAllowance;

/** Feature available = shipped (FEATURES.released) AND included in the shop's current plan. */
export async function can(t: Tenant, feature: Feature) {
  return planHasFeature((await getBillingState(t)).plan as PlanKey, feature);
}

// ---------------------------------------------------------------------------------------------------------------
// Review counts (cache in shop_settings.review_stats; reviews themselves live in Shopify).
export type Bucket = "published" | "planLimited" | "pending" | "rejected" | "hidden";
export interface Stats { published: number; planLimited: number; pending: number; rejected: number; hidden: number; flagged: number; total: number }
const EMPTY: Stats = { published: 0, planLimited: 0, pending: 0, rejected: 0, hidden: 0, flagged: 0, total: 0 };

export async function readStats({ db, shopId }: Tenant): Promise<Stats> {
  const s = await db.shopSettings.findUnique({ where: { shopId }, select: { reviewStats: true } });
  return { ...EMPTY, ...((s?.reviewStats ?? {}) as Partial<Stats>) };
}

/** The bucket a review counts in: an entry edited outside Proofly is never public, so it counts as held. */
const statBucket = (r: StoredReview): Bucket => (r.editedOutside && bucketOf(r) === "published" ? "planLimited" : (bucketOf(r) as Bucket));

/** Applies one review's change (null = didn't exist / no longer exists) to the cached counts. Row-locked. */
export const bumpStats = (shopId: string, before: StoredReview | null, after: StoredReview | null) => bumpStatsMany(shopId, [[before, after]]);

/** Applies many reviews' changes in one row-locked update (imports, bulk releases). */
export async function bumpStatsMany(shopId: string, changes: [StoredReview | null, StoredReview | null][]) {
  const same = (a: StoredReview, b: StoredReview) => statBucket(a) === statBucket(b) && (a.flags.length > 0) === (b.flags.length > 0);
  const real = changes.filter(([b, a]) => !(b && a && same(b, a)));
  if (!real.length) return;
  await withTenant(shopId, async (t) => {
    await t.db.$executeRaw`SELECT 1 FROM shop_settings WHERE shop_id = ${shopId}::uuid FOR UPDATE`;
    const s = await readStats(t);
    const apply = (r: StoredReview, d: 1 | -1) => { s[statBucket(r)] += d; s.total += d; if (r.flags.length) s.flagged += d; };
    for (const [before, after] of real) { if (before) apply(before, -1); if (after) apply(after, 1); }
    await t.db.shopSettings.update({ where: { shopId }, data: { reviewStats: s as object } });
  });
}

/** Recounts every review of the shop from Shopify (maintenance; repairs drift from edits made outside Proofly). */
export async function recountStats(api: ShopApi) {
  const s = { ...EMPTY };
  for await (const r of scanReviews(api, {})) {
    // A review edited outside Proofly is never public: it counts as held until approved again in Proofly.
    s[statBucket(r)]++;
    s.total++;
    if (r.flags.length) s.flagged++;
  }
  await withTenant(api.shopId, ({ db, shopId }) => db.shopSettings.update({ where: { shopId }, data: { reviewStats: s as object } }));
  return s;
}

export interface Usage { publishedReviews: number; awaitingModeration: number; planLimitedReviews: number; rejected: number; hidden: number }

export async function getUsage(t: Tenant): Promise<Usage> {
  const s = await readStats(t);
  return { publishedReviews: s.published, awaitingModeration: s.pending, planLimitedReviews: s.planLimited, rejected: s.rejected, hidden: s.hidden };
}

/** Plan status for the admin: allowance vs usage, including grandfathered overage (usage may exceed allowance). */
export async function getPlanStatus(t: Tenant) {
  const [state, usage] = await Promise.all([getBillingState(t), getUsage(t)]);
  const plan = PLANS[state.plan];
  return {
    plan, state, usage,
    reviewRoom: Math.max(0, plan.publishedReviewAllowance - usage.publishedReviews),
    overReviewAllowance: usage.publishedReviews > plan.publishedReviewAllowance,
  };
}

/**
 * Runs an allowance decision with the shop's entitlement lock held (two concurrent approvals can't both take the last
 * slot). The lock is a Postgres advisory lock held for the duration, Shopify writes included.
 */
async function withEntitlementLock<T>(shopId: string, fn: (t: Tenant) => Promise<T>) {
  return withTenant(shopId, async (t) => {
    await t.db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`entitlements:${shopId}`}))`;
    return fn(t);
  }, { timeoutMs: 300_000 });
}

/** Up to this many reviews are released one by one under the lock; more go through one Shopify bulk operation. */
export const BULK_RELEASE_MIN = 100;

/**
 * Releases plan-limited reviews (published + held) into public view, OLDEST FIRST, while the plan has room.
 * Candidates: the given reviews, the reviews of one import, or (no filter) every held review ("Publish eligible
 * reviews"). Reviews that don't fit simply stay held — never rejected, never deleted. Public reviews are never touched.
 * Pass reviews just written as `reviews` (not `importJobId`) where possible: Shopify's search index lags writes by
 * seconds, so a search right after writing can miss them. `known` = other just-written reviews for the aggregates.
 */
export async function releaseEligibleReviews(api: ShopApi, opts: { reviews?: StoredReview[]; importJobId?: string; actor?: string; known?: StoredReview[]; sleep?: (ms: number) => Promise<void> } = {}) {
  const decided = await withEntitlementLock(api.shopId, async (t) => {
    let candidates: StoredReview[] = [];
    if (opts.reviews && opts.reviews.length <= BULK_RELEASE_MIN) {
      // Re-read under the lock: never act on a stale copy.
      for (const r of opts.reviews) { const fresh = await getReview(api, r.id); if (fresh) candidates.push(fresh); }
    } else if (opts.reviews) {
      // ponytail: too many to re-read one by one (a large import). A stale copy is harmless: bulkRelease writes only the
      // release fields, so an entry that changed meanwhile fails its signature and stays private.
      candidates = opts.reviews;
    } else {
      for await (const r of scanReviews(api, { status: "published", held: true, ...(opts.importJobId ? { importJobId: opts.importJobId } : {}) }, { oldestFirst: true })) candidates.push(r);
    }
    // An entry edited outside Proofly is never released: only re-approval (which re-signs it) can make it public.
    candidates = candidates.filter((r) => r.status === "published" && r.held && !r.editedOutside).sort(byAdmissionOrder);
    const { reviewRoom } = await getPlanStatus(t);
    const fit = candidates.slice(0, reviewRoom);
    const stillHeld = candidates.length - fit.length;
    if (opts.actor && (fit.length || stillHeld)) {
      await t.db.auditLog.create({ data: { shopId: api.shopId, actor: opts.actor, action: "plan.reviews_released", entity: "reviews", details: { released: fit.length, stillHeld } } });
    }
    if (fit.length <= BULK_RELEASE_MIN) {
      const released: StoredReview[] = [];
      for (const r of fit) { const next = await updateReview(api, r, { held: false }); await bumpStats(api.shopId, r, next); released.push(next); }
      return { fit, stillHeld, released, bulk: false };
    }
    // Large release: take the room now (counted as published) so concurrent decisions see it gone; Shopify's bulk
    // write runs after the lock (it can take minutes).
    await bumpStatsMany(api.shopId, fit.map((r) => [r, { ...r, held: false }]));
    return { fit, stillHeld, released: [] as StoredReview[], bulk: true };
  });
  let released = decided.released;
  if (decided.bulk) {
    const now = await bulkRelease(api, decided.fit, { sleep: opts.sleep });
    released = [];
    const correction: [StoredReview, StoredReview][] = [];
    for (const r of decided.fit) {
      const after = now.get(r.id);
      if (after?.isPublic) { correction.push([{ ...r, held: false }, after]); released.push(after); continue; }
      // Not public: undo the reservation. If the entry changed after the decision (e.g. a moderation), our partial
      // write left its signature stale — it stays private and the admin shows it as edited outside Proofly until it is
      // re-approved; either way it counts where it counted before (statBucket).
      // ponytail: rare race (a moderation during the bulk write); re-sign only if it ever needs to look clean.
      correction.push([{ ...r, held: false }, r]);
    }
    await bumpStatsMany(api.shopId, correction);
  }
  if (released.length) await recomputeProducts(api, released.map((r) => r.productId), [...(opts.known ?? []), ...released]);
  return { released: released.length, stillHeld: decided.stillHeld + decided.fit.length - released.length, reviews: released };
}

/**
 * Makes reviews public subject to the allowance: published reviews that are not public yet are held first, then
 * released oldest-first while there is room. Used by approval, auto-published submissions and imports.
 */
export async function admitReviews(api: ShopApi, reviews: StoredReview[], actor?: string) {
  const held: StoredReview[] = [];
  for (const r of reviews) {
    if (r.status !== "published") continue;
    if (r.held) { held.push(r); continue; }
    const next = await updateReview(api, r, { held: true });
    await bumpStats(api.shopId, r, next);
    held.push(next);
  }
  if (!held.length) return { released: 0, stillHeld: 0, reviews: [] as StoredReview[] };
  return releaseEligibleReviews(api, { reviews: held, actor });
}
