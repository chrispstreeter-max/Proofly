import type { ReviewStatus } from "@prisma/client";
import { recomputeProduct } from "./aggregates.server";
import { admitReviews, releaseEligibleReviews } from "./entitlements.server";
import type { Tenant } from "./tenant.server";

export const ACTIONS = {
  approve: "published",
  reject: "rejected",
  hide: "hidden",
  restore: "pending", // back into the moderation queue for a fresh decision
} as const satisfies Record<string, ReviewStatus>;
export type ModerationActionName = keyof typeof ACTIONS;

/**
 * Change status of this shop's reviews, record moderation history + audit, recompute aggregates.
 * Ids that do not belong to the shop are ignored (and indistinguishable from unknown ids).
 * Returns the number of reviews changed. Callers then call syncAfterRatingChange (rating-cache.server) outside the
 * transaction; a failed Shopify write never undoes the moderation.
 */
export async function moderate(t: Tenant, reviewIds: string[], action: ModerationActionName, actor: string) {
  const { db, shopId } = t;
  const status = ACTIONS[action];
  const reviews = await db.review.findMany({ where: { shopId, id: { in: reviewIds } }, select: { id: true, status: true, productId: true } });
  if (!reviews.length) return 0;
  const ids = reviews.map((r) => r.id);
  await db.review.updateMany({ where: { shopId, id: { in: ids } }, data: { status } });
  if (action === "approve") {
    // Approval ends a moderation hold; then the plan decides. Reviews that were not already public are admitted
    // oldest-first while the allowance has room — the rest stay approved but held (plan_limit), never rejected.
    await db.review.updateMany({ where: { shopId, id: { in: ids }, holdReason: "moderation" }, data: { holdReason: null } });
    const newlyPublic = reviews.filter((r) => r.status !== "published").map((r) => r.id);
    await admitReviews(t, newlyPublic, actor);
  }
  await db.moderationAction.createMany({
    data: reviews.map((r) => ({ shopId, reviewId: r.id, action, fromStatus: r.status, toStatus: status, actor })),
  });
  await db.auditLog.createMany({
    data: reviews.map((r) => ({ shopId, actor, action: `review.${action}`, entity: "review", entityId: r.id, details: { from: r.status, to: status } })),
  });
  for (const pid of new Set(reviews.map((r) => r.productId))) await recomputeProduct(t, pid);
  return reviews.length;
}

/**
 * Puts reviews on the plan-limit hold, or releases them — releasing goes through the plan allowance
 * (entitlements.server releaseEligibleReviews: oldest first, only while there is room). Plan-limited reviews are stored,
 * never deleted, never public. Releasing only clears plan_limit holds — a moderation hold or a rejected/hidden status
 * is untouched.
 */
export async function setPlanLimited(t: Tenant, reviewIds: string[], limited: boolean, actor: string) {
  const { db, shopId } = t;
  if (!limited) return (await releaseEligibleReviews(t, { reviewIds, actor })).released;
  const reviews = await db.review.findMany({ where: { shopId, id: { in: reviewIds } }, select: { id: true, productId: true } });
  if (!reviews.length) return 0;
  await db.review.updateMany({ where: { shopId, id: { in: reviews.map((r) => r.id) } }, data: { holdReason: "plan_limit" } });
  await db.auditLog.create({ data: { shopId, actor, action: "reviews.plan_limited", entity: "review", details: { count: reviews.length } } });
  for (const pid of new Set(reviews.map((r) => r.productId))) await recomputeProduct(t, pid);
  return reviews.length;
}

/** Save/remove the public reply on one of this shop's reviews. Returns false when the review is not this shop's. */
export async function saveReply({ db, shopId }: Tenant, reviewId: string, reply: string, actor: string) {
  const review = await db.review.findFirst({ where: { shopId, id: reviewId }, select: { id: true } });
  if (!review) return false;
  const text = reply.trim().slice(0, 5000);
  if (!text) {
    await db.reviewReply.deleteMany({ where: { shopId, reviewId } });
    await db.auditLog.create({ data: { shopId, actor, action: "reply.delete", entity: "review", entityId: reviewId } });
    return true;
  }
  await db.reviewReply.upsert({ where: { reviewId }, create: { shopId, reviewId, reply: text }, update: { reply: text } });
  await db.auditLog.create({ data: { shopId, actor, action: "reply.save", entity: "review", entityId: reviewId } });
  return true;
}

/** Moderation history of one of this shop's reviews (empty for unknown/other-shop ids). */
export function moderationHistory({ db, shopId }: Tenant, reviewId: string) {
  return db.moderationAction.findMany({ where: { shopId, reviewId }, orderBy: { createdAt: "desc" }, take: 50 });
}
