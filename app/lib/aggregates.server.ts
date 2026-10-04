import { Prisma } from "@prisma/client";
import { scanReviews, type ShopApi, type StoredReview } from "./review-store.server";
import { withTenant } from "./tenant.server";

export interface Aggregate {
  reviewCount: number;
  averageRating: number; // 2 decimals, 0 when there are no public reviews
  distribution: [number, number, number, number, number]; // 1★ … 5★
}

/** Aggregate of a set of reviews — only the public ones count (published, not held, not edited outside Proofly). */
export function aggregateOf(reviews: Iterable<Pick<StoredReview, "rating" | "isPublic">>): Aggregate {
  const distribution: Aggregate["distribution"] = [0, 0, 0, 0, 0];
  for (const r of reviews) if (r.isPublic && r.rating >= 1 && r.rating <= 5) distribution[r.rating - 1]++;
  const reviewCount = distribution.reduce((a, b) => a + b, 0);
  const sum = distribution.reduce((a, n, i) => a + n * (i + 1), 0);
  return { reviewCount, averageRating: reviewCount ? Math.round((sum / reviewCount) * 100) / 100 : 0, distribution };
}

/**
 * THE rating aggregate of one product — the only place review counts, averages and star distribution are calculated.
 * Reads the product's public reviews from Shopify (app/lib/review-store.server.ts). Every eligible review counts;
 * nothing is selected by rating or content.
 */
export async function computeAggregate(api: ShopApi, shopifyProductId: bigint) {
  const reviews: StoredReview[] = [];
  for await (const r of scanReviews(api, { productIds: [shopifyProductId], isPublic: true })) reviews.push(r);
  return aggregateOf(reviews);
}

/** Stores one product's aggregate in Proofly's product cache (the source for Shopify's rating metafields). */
async function store(shopId: string, shopifyProductId: bigint, a: Aggregate) {
  const [r1, r2, r3, r4, r5] = a.distribution;
  await withTenant(shopId, async ({ db }) => {
    await db.product.updateMany({
      where: { shopId, shopifyProductId },
      data: { reviewCount: a.reviewCount, averageRating: new Prisma.Decimal(a.averageRating), rating1: r1, rating2: r2, rating3: r3, rating4: r4, rating5: r5 },
    });
    // The first time a product has a public Proofly review it becomes proofly_managed: from then on Proofly owns its
    // Shopify rating metafields (app/lib/rating-cache.server.ts).
    if (a.reviewCount > 0) await db.product.updateMany({ where: { shopId, shopifyProductId, ratingOwnership: "unmanaged" }, data: { ratingOwnership: "proofly_managed", ratingManagedAt: new Date() } });
  });
}

/** Recomputes and stores one product's aggregate. Call after ANY change that can alter public eligibility. */
export async function recomputeProduct(api: ShopApi, shopifyProductId: bigint) {
  const a = await computeAggregate(api, shopifyProductId);
  await store(api.shopId, shopifyProductId, a);
  return a;
}

export async function recomputeProducts(api: ShopApi, shopifyProductIds: Iterable<bigint>) {
  for (const id of new Set([...shopifyProductIds].map(String))) await recomputeProduct(api, BigInt(id));
}

/** Every product of the shop in one pass over its public reviews. */
export async function recomputeAll(api: ShopApi) {
  const byProduct = new Map<string, StoredReview[]>();
  for await (const r of scanReviews(api, { isPublic: true })) byProduct.set(String(r.productId), [...(byProduct.get(String(r.productId)) ?? []), r]);
  const products = await withTenant(api.shopId, ({ db, shopId }) => db.product.findMany({ where: { shopId }, select: { shopifyProductId: true } }));
  for (const p of products) await store(api.shopId, p.shopifyProductId, aggregateOf(byProduct.get(String(p.shopifyProductId)) ?? []));
  return products.length;
}
