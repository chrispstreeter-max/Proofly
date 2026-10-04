import { recomputeProduct, recomputeProducts } from "./aggregates.server";
import { admitReviews, bumpStats } from "./entitlements.server";
import { getReview, updateReview, type ReviewStatus, type ShopApi, type StoredReview } from "./review-store.server";
import { withTenant, type Tenant } from "./tenant.server";

export const ACTIONS = {
  approve: "published",
  reject: "rejected",
  hide: "hidden",
  restore: "pending", // back into the moderation queue for a fresh decision
} as const satisfies Record<string, ReviewStatus>;
export type ModerationActionName = keyof typeof ACTIONS;

/** Admin URLs carry the numeric part of the review's metaobject id; anything else is not a review id. */
export const reviewGid = (raw: string | undefined) => (raw && /^\d{1,20}$/.test(raw) ? `gid://shopify/Metaobject/${raw}` : null);
export const reviewParam = (id: string) => id.split("/").pop()!;

/**
 * Changes the status of this shop's reviews, records history in the audit log and recomputes aggregates.
 * Ids that are not reviews of this shop are ignored (the shop's Admin API cannot see another shop's entries, so they
 * are indistinguishable from unknown ids). Approving re-signs the entry (a review edited outside Proofly becomes
 * eligible again only through approval) and goes through the plan allowance: what doesn't fit stays approved and held.
 * Returns the reviews changed. Callers then call syncAfterRatingChange (rating-cache.server).
 */
export async function moderate(api: ShopApi, reviewIds: string[], action: ModerationActionName, actor: string) {
  const status = ACTIONS[action];
  const changed: { before: StoredReview; after: StoredReview }[] = [];
  for (const id of reviewIds) {
    const before = await getReview(api, id);
    if (!before) continue;
    const wasPublic = before.isPublic;
    // A newly approved review enters held; admission below decides (oldest first) whether it fits the plan.
    let after = await updateReview(api, before, { status, held: action === "approve" ? (wasPublic ? false : true) : before.held });
    await bumpStats(api.shopId, before, after);
    if (action === "approve" && !wasPublic) {
      await admitReviews(api, [after], actor);
      after = (await getReview(api, id)) ?? after;
    }
    changed.push({ before, after });
  }
  if (!changed.length) return [];
  await withTenant(api.shopId, ({ db, shopId }) => db.auditLog.createMany({
    data: changed.map(({ before, after }) => ({ shopId, actor, action: `review.${action}`, entity: "review", entityId: after.id, details: { from: before.status, to: after.status, held: after.held } })),
  }));
  // The reviews just written override Shopify's (lagging) search index in the aggregates.
  await recomputeProducts(api, changed.map((c) => c.after.productId), changed.map((c) => c.after));
  return changed.map((c) => c.after);
}

/** Saves/removes the public reply on one of this shop's reviews. Returns false when it is not this shop's review. */
export async function saveReply(api: ShopApi, reviewId: string, reply: string, actor: string) {
  const review = await getReview(api, reviewId);
  if (!review) return false;
  const text = reply.trim().slice(0, 5000);
  const after = await updateReview(api, review, text ? { reply: text, replyDate: review.replyDate ?? new Date() } : { reply: null, replyDate: null });
  await withTenant(api.shopId, ({ db, shopId }) => db.auditLog.create({ data: { shopId, actor, action: text ? "reply.save" : "reply.delete", entity: "review", entityId: review.id } }));
  if (review.isPublic || after.isPublic) await recomputeProduct(api, after.productId, [after]); // the storefront projection shows replies
  return true;
}

/** Moderation history of one review (Proofly's audit log — merchant edits in Shopify admin cannot alter it). */
export function moderationHistory({ db, shopId }: Tenant, reviewId: string) {
  return db.auditLog.findMany({ where: { shopId, entity: "review", entityId: reviewId, action: { startsWith: "review." } }, orderBy: { createdAt: "desc" }, take: 50 });
}
