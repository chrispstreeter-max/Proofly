import type { ReviewStatus } from "@prisma/client";
import prisma from "../db.server";
import { recomputeProduct, syncMetafields } from "./aggregates.server";

type Graphql = Parameters<typeof syncMetafields>[0];

export const ACTIONS = {
  approve: "published",
  reject: "rejected",
  hide: "hidden",
  restore: "pending", // back into the moderation queue for a fresh decision
} as const satisfies Record<string, ReviewStatus>;
export type ModerationAction = keyof typeof ACTIONS;

/** Change status, recompute that product's aggregates and mirror them to Shopify. Audited. */
export async function moderate(reviewIds: string[], action: ModerationAction, actor: string, graphql?: Graphql) {
  const status = ACTIONS[action];
  const reviews = await prisma.review.findMany({ where: { id: { in: reviewIds } }, select: { id: true, status: true, shopifyProductId: true } });
  await prisma.$transaction([
    prisma.review.updateMany({ where: { id: { in: reviews.map((r) => r.id) } }, data: { status } }),
    ...reviews.map((r) =>
      prisma.auditLog.create({
        data: { actor, action: `review.${action}`, entity: "review", entityId: r.id, details: { from: r.status, to: status } },
      }),
    ),
  ]);
  for (const pid of new Set(reviews.map((r) => r.shopifyProductId))) await recomputeProduct(pid);
  if (graphql) await syncMetafields(graphql);
  return reviews.length;
}

export async function saveReply(reviewId: string, reply: string, actor: string) {
  const text = reply.trim().slice(0, 5000);
  if (!text) {
    await prisma.reviewReply.deleteMany({ where: { reviewId } });
    await prisma.auditLog.create({ data: { actor, action: "reply.delete", entity: "review", entityId: reviewId } });
    return;
  }
  await prisma.reviewReply.upsert({ where: { reviewId }, create: { reviewId, reply: text }, update: { reply: text } });
  await prisma.auditLog.create({ data: { actor, action: "reply.save", entity: "review", entityId: reviewId } });
}
