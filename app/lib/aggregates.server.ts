import { Prisma } from "@prisma/client";
import { newestFirst, publishProjection, staleProjectionProducts } from "./projection.server";
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
 *
 * Shopify's metaobject search is EVENTUALLY consistent (verified on a real store: a just-written entry appears in
 * filtered searches only seconds later). `known` = reviews this request just wrote, in their current state: they
 * override whatever the search index still returns for them, so the aggregate is right immediately.
 */
export async function computeAggregate(api: ShopApi, shopifyProductId: bigint, known: StoredReview[] = []) {
  return aggregateOf(await publicReviewsOf(api, shopifyProductId, known));
}

/** One product's public reviews, newest first, with `known` overriding the search index (see computeAggregate). */
export async function publicReviewsOf(api: ShopApi, shopifyProductId: bigint, known: StoredReview[] = []) {
  const byId = new Map<string, StoredReview>();
  for await (const r of scanReviews(api, { productIds: [shopifyProductId], isPublic: true })) byId.set(r.id, r);
  for (const k of known) if (String(k.productId) === String(shopifyProductId)) byId.set(k.id, k);
  return [...byId.values()].filter((r) => r.isPublic).sort(newestFirst);
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
    // The storefront projection must follow; cleared once it is confirmed written (app/lib/projection.server.ts).
    await db.product.updateMany({ where: { shopId, shopifyProductId, projectionStaleSince: null }, data: { projectionStaleSince: new Date() } });
  });
}

/** Recomputes and stores one product's aggregate and publishes its storefront projection. Call after ANY change to
 *  a public review or its eligibility, passing the reviews just written as `known` (see computeAggregate). */
export async function recomputeProduct(api: ShopApi, shopifyProductId: bigint, known: StoredReview[] = []) {
  const reviews = await publicReviewsOf(api, shopifyProductId, known);
  const a = aggregateOf(reviews);
  await store(api.shopId, shopifyProductId, a);
  await publishProjection(api, shopifyProductId, reviews, a);
  return a;
}

export async function recomputeProducts(api: ShopApi, shopifyProductIds: Iterable<bigint>, known: StoredReview[] = []) {
  for (const id of new Set([...shopifyProductIds].map(String))) await recomputeProduct(api, BigInt(id), known);
}

/** Every product of the shop in one pass over its public reviews. */
export async function recomputeAll(api: ShopApi) {
  const byProduct = new Map<string, StoredReview[]>();
  for await (const r of scanReviews(api, { isPublic: true })) byProduct.set(String(r.productId), [...(byProduct.get(String(r.productId)) ?? []), r]);
  const products = await withTenant(api.shopId, ({ db, shopId }) => db.product.findMany({ where: { shopId }, select: { shopifyProductId: true } }));
  for (const p of products) {
    const reviews = (byProduct.get(String(p.shopifyProductId)) ?? []).filter((r) => r.isPublic).sort(newestFirst);
    const a = aggregateOf(reviews);
    await store(api.shopId, p.shopifyProductId, a);
    await publishProjection(api, p.shopifyProductId, reviews, a);
  }
  return products.length;
}

/** Retries projections whose write failed. Safe to call any time; returns how many products were republished. */
export async function retryStaleProjections(api: ShopApi, now = new Date()) {
  const stale = await staleProjectionProducts(api.shopId, now);
  for (const p of stale) await recomputeProduct(api, p.shopifyProductId);
  return stale.length;
}
