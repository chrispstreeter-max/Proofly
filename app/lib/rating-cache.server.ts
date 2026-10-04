import type { Product } from "@prisma/client";
import { withTenant } from "./tenant.server";

/**
 * Shopify rating cache — the ONLY module that writes Shopify rating metafields.
 *
 *   Postgres reviews (canonical) → computeAggregate (aggregates.server) → products.review_count / average_rating
 *     → THIS module → Shopify standard product metafields (derived cache)
 *
 * Verified Shopify definitions (shopify.dev "standard metafield definitions" + Admin API 2026-10 schema):
 *   reviews.rating        type `rating`          value JSON {"value":"4.33","scale_min":"1.0","scale_max":"5.0"} (strings)
 *   reviews.rating_count  type `number_integer`  value "12"
 *   Owner type PRODUCT. "Product rating apps should write to this standard metafield"; themes read it.
 *
 * Ownership: Proofly writes ONLY to products whose rating_ownership is `proofly_managed` (set by recomputeProduct when
 * a product first has a public Proofly review). Unmanaged products — possibly rated by another app — are never read,
 * written, deleted or "reconciled". Once managed, a product with 0 public reviews gets rating_count 0 and its
 * reviews.rating removed (Proofly resets only its own values). Product deletion never touches Shopify.
 *
 * A failed Shopify write never changes canonical data: the product stays "dirty" (synced_* ≠ aggregate) with
 * rating_sync_error set, and the next sync or reconciliation retries it. Writes are idempotent (metafieldsSet).
 */
export const RATING = { namespace: "reviews", key: "rating", type: "rating", scaleMin: "1.0", scaleMax: "5.0" } as const;
export const RATING_COUNT = { namespace: "reviews", key: "rating_count", type: "number_integer" } as const;

type Graphql = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
type Sleep = (ms: number) => Promise<void>;
export interface CacheOptions { sleep?: Sleep }

const productGid = (id: bigint) => `gid://shopify/Product/${id}`;
const BATCH = 12; // ≤ 2 metafields per product; metafieldsSet accepts at most 25

export const SET_RATINGS_MUTATION = `#graphql
  mutation ProoflySetRatings($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message code } }
  }`;
export const DELETE_RATINGS_MUTATION = `#graphql
  mutation ProoflyDeleteRatings($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) { deletedMetafields { ownerId namespace key } userErrors { field message } }
  }`;
export const READ_RATINGS_QUERY = `#graphql
  query ProoflyReadRatings($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        rating: metafield(namespace: "reviews", key: "rating") { value }
        ratingCount: metafield(namespace: "reviews", key: "rating_count") { value }
      }
    }
  }`;
export const ENABLE_DEFINITION_MUTATION = `#graphql
  mutation ProoflyEnableRatingDefinition($ownerType: MetafieldOwnerType!, $namespace: String!, $key: String!) {
    standardMetafieldDefinitionEnable(ownerType: $ownerType, namespace: $namespace, key: $key, pin: false) {
      userErrors { code message }
    }
  }`;

/** What Shopify should hold for a product, from Proofly's aggregate. */
export function shopifyRatingFor(p: Pick<Product, "shopifyProductId" | "reviewCount" | "averageRating">) {
  const ownerId = productGid(p.shopifyProductId);
  const count = { ownerId, ...RATING_COUNT, value: String(p.reviewCount) };
  if (p.reviewCount > 0) {
    const value = JSON.stringify({ value: Number(p.averageRating).toFixed(2), scale_min: RATING.scaleMin, scale_max: RATING.scaleMax });
    return { set: [{ ownerId, namespace: RATING.namespace, key: RATING.key, type: RATING.type, value }, count], remove: [] as { ownerId: string; namespace: string; key: string }[] };
  }
  return { set: [count], remove: [{ ownerId, namespace: RATING.namespace, key: RATING.key }] };
}

class ShopifyWriteError extends Error {}

/** One Admin API call with retries for throttling / transient failures (not for userErrors). */
export async function call(graphql: Graphql, query: string, variables: Record<string, unknown>, sleep: Sleep, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      const body = (await (await graphql(query, { variables })).json()) as { data?: Record<string, unknown>; errors?: { extensions?: { code?: string } }[] };
      const throttled = body.errors?.some((e) => e.extensions?.code === "THROTTLED");
      if (!throttled && body.errors) throw new ShopifyWriteError(`GraphQL error: ${JSON.stringify(body.errors).slice(0, 300)}`);
      if (!throttled) return body.data ?? {};
      if (i >= attempts) throw new ShopifyWriteError("Shopify API throttled");
    } catch (e) {
      if (e instanceof ShopifyWriteError || i >= attempts) throw e; // GraphQL/user errors are not transient
    }
    await sleep(500 * 2 ** (i - 1));
  }
}

const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Writes Proofly's values for these (managed) products; marks them synced on success, records the error on failure. */
async function write(shopId: string, graphql: Graphql, products: Product[], sleep: Sleep) {
  let written = 0;
  let failed = 0;
  for (let i = 0; i < products.length; i += BATCH) {
    const batch = products.slice(i, i + BATCH);
    const plan = batch.map(shopifyRatingFor);
    try {
      const set = plan.flatMap((x) => x.set);
      const data = await call(graphql, SET_RATINGS_MUTATION, { metafields: set }, sleep);
      const errs = (data.metafieldsSet as { userErrors: unknown[] } | undefined)?.userErrors;
      if (!errs || errs.length) throw new ShopifyWriteError(`metafieldsSet: ${JSON.stringify(errs ?? data).slice(0, 300)}`);
      const remove = plan.flatMap((x) => x.remove);
      if (remove.length) {
        const del = await call(graphql, DELETE_RATINGS_MUTATION, { metafields: remove }, sleep);
        const dErrs = (del.metafieldsDelete as { userErrors: unknown[] } | undefined)?.userErrors;
        if (!dErrs || dErrs.length) throw new ShopifyWriteError(`metafieldsDelete: ${JSON.stringify(dErrs ?? del).slice(0, 300)}`);
      }
      await withTenant(shopId, async ({ db }) => {
        for (const p of batch) {
          await db.product.updateMany({ where: { shopId, id: p.id }, data: { syncedCount: p.reviewCount, syncedAverage: p.averageRating, ratingSyncedAt: new Date(), ratingSyncError: null } });
        }
      });
      written += batch.length;
    } catch (e) {
      failed += batch.length;
      const msg = String(e instanceof Error ? e.message : e).slice(0, 500);
      await withTenant(shopId, ({ db }) => db.product.updateMany({ where: { shopId, id: { in: batch.map((p) => p.id) } }, data: { ratingSyncError: msg } }));
    }
  }
  return { written, failed };
}

const managed = (shopId: string, productIds?: string[]) =>
  withTenant(shopId, ({ db }) => db.product.findMany({
    where: { shopId, ratingOwnership: "proofly_managed", deletedAt: null, ...(productIds ? { id: { in: productIds } } : {}) },
    orderBy: { id: "asc" },
  }));

const isDirty = (p: Product) => p.syncedCount !== p.reviewCount || !p.syncedAverage || !p.syncedAverage.equals(p.averageRating);

/**
 * Pushes changed aggregates of this shop's Proofly-managed products to Shopify. Safe to call any time (idempotent):
 * only products whose last confirmed write differs from the current aggregate are written.
 */
export async function syncRatingCache(shopId: string, graphql: Graphql, opts: CacheOptions & { productIds?: string[] } = {}) {
  const dirty = (await managed(shopId, opts.productIds)).filter(isDirty);
  return write(shopId, graphql, dirty, opts.sleep ?? realSleep);
}

/** After a review state change: best-effort sync. Shopify being down never affects the canonical change. */
export async function syncAfterRatingChange(shopId: string, graphql: Graphql) {
  try {
    return await syncRatingCache(shopId, graphql);
  } catch (e) {
    console.warn("rating cache sync deferred", shopId, e);
    return null;
  }
}

export interface ReconcileReport {
  checked: number; ok: number; missing: number; incorrect: number; notInShopify: number; repaired: number; failed: number;
  mismatches: { shopifyProductId: string; proofly: { count: number; average: string | null }; shopify: { count: number | null; average: string | null } }[];
}

/**
 * Compares what Shopify ACTUALLY holds with Proofly's aggregate for this shop's Proofly-managed products only, and
 * rewrites the ones that differ (missing, wrong, stale). Reads and writes nothing for unmanaged products, never
 * changes reviews or aggregates.
 */
export async function reconcileRatingCache(shopId: string, graphql: Graphql, opts: CacheOptions = {}): Promise<ReconcileReport> {
  const sleep = opts.sleep ?? realSleep;
  const products = await managed(shopId);
  const report: ReconcileReport = { checked: 0, ok: 0, missing: 0, incorrect: 0, notInShopify: 0, repaired: 0, failed: 0, mismatches: [] };
  const repair: Product[] = [];
  const inSync: Product[] = [];
  for (let i = 0; i < products.length; i += 50) {
    const chunk = products.slice(i, i + 50);
    const data = await call(graphql, READ_RATINGS_QUERY, { ids: chunk.map((p) => productGid(p.shopifyProductId)) }, sleep);
    const nodes = (data.nodes ?? []) as ({ id: string; rating: { value: string } | null; ratingCount: { value: string } | null } | null)[];
    const byId = new Map(nodes.filter(Boolean).map((n) => [n!.id, n!]));
    for (const p of chunk) {
      report.checked++;
      const node = byId.get(productGid(p.shopifyProductId));
      if (!node) { report.notInShopify++; continue; } // deleted in Shopify: catalogue sync / webhook marks it deleted
      const expAvg = p.reviewCount > 0 ? Number(p.averageRating).toFixed(2) : null;
      const actCount = node.ratingCount ? Number(node.ratingCount.value) : null;
      let actAvg: string | null = null;
      try { actAvg = node.rating ? Number(JSON.parse(node.rating.value).value).toFixed(2) : null; } catch { actAvg = "invalid"; }
      const missing = actCount === null || (expAvg !== null && actAvg === null);
      const wrong = !missing && (actCount !== p.reviewCount || actAvg !== expAvg);
      if (!missing && !wrong) { report.ok++; if (isDirty(p)) inSync.push(p); continue; }
      if (missing) report.missing++; else report.incorrect++;
      if (report.mismatches.length < 50) {
        report.mismatches.push({ shopifyProductId: String(p.shopifyProductId), proofly: { count: p.reviewCount, average: expAvg }, shopify: { count: actCount, average: actAvg } });
      }
      repair.push(p);
    }
  }
  // Shopify already matches: just record that (no write).
  if (inSync.length) {
    await withTenant(shopId, async ({ db }) => {
      for (const p of inSync) await db.product.updateMany({ where: { shopId, id: p.id }, data: { syncedCount: p.reviewCount, syncedAverage: p.averageRating, ratingSyncedAt: new Date(), ratingSyncError: null } });
    });
  }
  const w = await write(shopId, graphql, repair, sleep);
  report.repaired = w.written;
  report.failed = w.failed;
  return report;
}

/** Enables Shopify's standard rating definitions on the shop (idempotent; TAKEN = already enabled). */
export async function ensureRatingDefinitions(graphql: Graphql, opts: CacheOptions = {}) {
  for (const key of [RATING.key, RATING_COUNT.key]) {
    const data = await call(graphql, ENABLE_DEFINITION_MUTATION, { ownerType: "PRODUCT", namespace: "reviews", key }, opts.sleep ?? realSleep);
    const errs = ((data.standardMetafieldDefinitionEnable as { userErrors: { code: string }[] } | undefined)?.userErrors ?? []).filter((e) => e.code !== "TAKEN");
    if (errs.length) throw new Error(`metafield definition ${key}: ${JSON.stringify(errs)}`);
  }
}
