import { Prisma } from "@prisma/client";
import { PUBLIC_MEDIA, PUBLIC_REVIEW } from "./reviews.server";
import type { Tenant } from "./tenant.server";

export interface Aggregate {
  reviewCount: number;
  averageRating: number; // 2 decimals, 0 when there are no public reviews
  distribution: [number, number, number, number, number]; // 1★ … 5★
  photoReviewCount: number;
}

/**
 * THE rating aggregate of one product — the only place review counts, averages, star distribution and photo-review
 * counts are calculated. Eligibility is PUBLIC_REVIEW (published AND not held: never pending, rejected, hidden or
 * plan-limited). A photo review is a public review with at least one PUBLIC_MEDIA photo (storage-limited photos only
 * ever affect photoReviewCount, never count/average/distribution). Every eligible review counts; nothing is selected
 * by rating or content.
 */
export async function computeAggregate({ db, shopId }: Tenant, productId: string): Promise<Aggregate> {
  const [rows, photoReviewCount] = await Promise.all([
    db.review.groupBy({ by: ["rating"], where: { shopId, productId, ...PUBLIC_REVIEW }, _count: { _all: true } }),
    db.review.count({ where: { shopId, productId, ...PUBLIC_REVIEW, images: { some: PUBLIC_MEDIA } } }),
  ]);
  const distribution: Aggregate["distribution"] = [0, 0, 0, 0, 0];
  for (const r of rows) if (r.rating >= 1 && r.rating <= 5) distribution[r.rating - 1] = r._count._all;
  const reviewCount = distribution.reduce((a, b) => a + b, 0);
  const sum = distribution.reduce((a, n, i) => a + n * (i + 1), 0);
  const averageRating = reviewCount ? Math.round((sum / reviewCount) * 100) / 100 : 0;
  return { reviewCount, averageRating, distribution, photoReviewCount };
}

/**
 * Recomputes and stores one product's aggregate. Call after ANY change that can alter public eligibility (moderation,
 * plan-limit holds, media status, new/imported reviews). The first time a product has a public Proofly review it
 * becomes `proofly_managed`: from then on Proofly owns its Shopify rating metafields (app/lib/rating-cache.server.ts).
 */
export async function recomputeProduct(t: Tenant, productId: string) {
  const { db, shopId } = t;
  const a = await computeAggregate(t, productId);
  const [r1, r2, r3, r4, r5] = a.distribution;
  await db.product.updateMany({
    where: { shopId, id: productId },
    data: {
      reviewCount: a.reviewCount, averageRating: new Prisma.Decimal(a.averageRating),
      rating1: r1, rating2: r2, rating3: r3, rating4: r4, rating5: r5, photoReviewCount: a.photoReviewCount,
    },
  });
  if (a.reviewCount > 0) {
    await db.product.updateMany({ where: { shopId, id: productId, ratingOwnership: "unmanaged" }, data: { ratingOwnership: "proofly_managed", ratingManagedAt: new Date() } });
  }
  return a;
}

export async function recomputeAll(t: Tenant) {
  const products = await t.db.product.findMany({ where: { shopId: t.shopId }, select: { id: true } });
  for (const p of products) await recomputeProduct(t, p.id);
  return products.length;
}
