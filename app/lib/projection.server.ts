import type { Aggregate } from "./aggregates.server";
import { can } from "./entitlements.server";
import { call } from "./rating-cache.server";
import { PROJECTION, type ShopApi, type StoredReview } from "./review-store.server";
import { serializeReview } from "./reviews.server";
import { withTenant } from "./tenant.server";

/**
 * Storefront projection — the ONLY module that writes the product metafield the Review widget renders from
 * (docs/SHOPIFY-DATA.md, Phase 2). Shopify serves it with the product page, so the widget's summary and first pages
 * need no request to Proofly. Further pages, and filters/sorts when not every review fits, go through the app proxy.
 *
 *   { summary: { count, average, distribution }, complete, reviews: [serializeReview(…) newest first] }
 *
 * Only PUBLIC reviews (published, not held by the plan, not edited outside Proofly), only the public allow-listed
 * fields (serializeReview), replies only when the shop's current plan includes them. Capped below Shopify's
 * 131,072-byte JSON limit; `complete` says whether every public review fits.
 *
 * Written whenever a product's public reviews are recomputed (aggregates.server). Only products Proofly manages (they
 * have had a public Proofly review) carry one. A failed write leaves products.projection_stale_since set and is retried
 * by retryStaleProjections once Shopify's search index has caught up.
 */
export const PROJECTION_MAX_BYTES = 120_000;
export const PROJECTION_MAX_REVIEWS = 300;
/** Shopify's metaobject search lags writes by seconds: a retry rebuilds from search, so it waits until it is current. */
export const PROJECTION_RETRY_AFTER_MS = 120_000;

export const PUBLISH_PROJECTION_MUTATION = `#graphql
  mutation ProoflyPublishProjection($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message code } }
  }`;

/** Newest first — the proxy's "recent" order (display name "date|handle", descending). */
export const newestFirst = (a: Pick<StoredReview, "reviewDate" | "handle">, b: Pick<StoredReview, "reviewDate" | "handle">) =>
  +b.reviewDate - +a.reviewDate || (a.handle < b.handle ? 1 : a.handle > b.handle ? -1 : 0);

/** `reviews`: the product's public reviews, newest first. Anything not public is skipped regardless. */
export function buildProjection(reviews: StoredReview[], a: Aggregate, visibility: { replies: boolean }) {
  const out = { summary: { count: a.reviewCount, average: a.averageRating, distribution: a.distribution }, complete: false, reviews: [] as ReturnType<typeof serializeReview>[] };
  let bytes = Buffer.byteLength(JSON.stringify(out));
  const eligible = reviews.filter((r) => r.isPublic);
  for (const r of eligible) {
    const s = serializeReview(r, visibility);
    const n = Buffer.byteLength(JSON.stringify(s)) + 1;
    if (out.reviews.length >= PROJECTION_MAX_REVIEWS || bytes + n > PROJECTION_MAX_BYTES) break;
    out.reviews.push(s);
    bytes += n;
  }
  out.complete = out.reviews.length === eligible.length;
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Best effort: Shopify being unavailable never affects the canonical change; the product stays stale for a retry. */
export async function publishProjection(api: ShopApi, shopifyProductId: bigint, reviews: StoredReview[], a: Aggregate) {
  const { shopId } = api;
  const { product, replies } = await withTenant(shopId, async (t) => ({
    product: await t.db.product.findFirst({ where: { shopId, shopifyProductId, deletedAt: null }, select: { id: true, ratingOwnership: true } }),
    replies: await can(t, "replies"),
  }));
  const done = () => withTenant(shopId, ({ db }) => db.product.updateMany({ where: { shopId, shopifyProductId }, data: { projectionStaleSince: null } }));
  if (!product || product.ratingOwnership !== "proofly_managed") return void (await done()); // nothing to show, nothing published
  try {
    const value = JSON.stringify(buildProjection(reviews, a, { replies }));
    const data = await call(api.graphql, PUBLISH_PROJECTION_MUTATION, { metafields: [{ ownerId: `gid://shopify/Product/${shopifyProductId}`, ...PROJECTION, value }] }, sleep);
    const errs = (data.metafieldsSet as { userErrors: unknown[] } | undefined)?.userErrors;
    if (!errs || errs.length) throw new Error(`metafieldsSet: ${JSON.stringify(errs ?? data).slice(0, 300)}`);
    // ponytail: a concurrent recompute whose write fails just before this clears loses its retry until the product's
    // next change; add a per-product version if that window ever matters.
    await done();
    return true;
  } catch (e) {
    console.warn("storefront projection deferred", shopId, String(shopifyProductId), e);
    await withTenant(shopId, ({ db }) => db.product.updateMany({ where: { shopId, shopifyProductId, projectionStaleSince: null }, data: { projectionStaleSince: new Date() } }));
    return false;
  }
}

/** Products whose projection write failed (or never ran) long enough ago that search is current again. */
export function staleProjectionProducts(shopId: string, now = new Date()) {
  return withTenant(shopId, ({ db }) => db.product.findMany({
    where: { shopId, deletedAt: null, projectionStaleSince: { lt: new Date(+now - PROJECTION_RETRY_AFTER_MS) } },
    select: { shopifyProductId: true },
  }));
}
