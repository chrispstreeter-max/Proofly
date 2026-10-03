import { withTenant, type Tenant } from "./tenant.server";

/**
 * Shopify product catalogue → Proofly `products` (one catalogue per merchant, RLS-scoped).
 *
 * Identity: the immutable Shopify product id (shop_id, shopify_product_id). Handle/title are mutable attributes and are
 * NEVER used to re-attach reviews. A deleted product keeps its row (deleted_at) and all its reviews; a new product that
 * reuses the handle is a different row with no reviews.
 * Fields kept (minimum needed): id, handle, title, status, updatedAt. Scope: read_products only.
 * Nothing here writes to Shopify, and nothing here touches rating metafields (ownership: rating-cache.server).
 */
export type ProductStatus = "active" | "draft" | "archived" | "unlisted";
const STATUSES = new Set<ProductStatus>(["active", "draft", "archived", "unlisted"]);

export interface ProductSnapshot { shopifyProductId: bigint; handle: string; title: string; status: ProductStatus; updatedAt: Date }

type Graphql = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Inserts or updates one product from Shopify. Out-of-order deliveries are harmless: an update older than what is
 * stored is ignored (atomic guard on shopify_updated_at), and a deleted product is never resurrected.
 */
export async function upsertProduct({ db, shopId }: Tenant, p: ProductSnapshot): Promise<"created" | "updated" | "stale" | "deleted"> {
  const now = new Date();
  const data = { handle: p.handle, title: p.title, status: p.status, shopifyUpdatedAt: p.updatedAt, lastSeenAt: now };
  const updated = await db.product.updateMany({
    where: { shopId, shopifyProductId: p.shopifyProductId, deletedAt: null, OR: [{ shopifyUpdatedAt: null }, { shopifyUpdatedAt: { lte: p.updatedAt } }] },
    data,
  });
  if (updated.count) return "updated";
  const existing = await db.product.findUnique({ where: { shopId_shopifyProductId: { shopId, shopifyProductId: p.shopifyProductId } }, select: { deletedAt: true } });
  if (existing?.deletedAt) return "deleted";
  if (existing) {
    await db.product.updateMany({ where: { shopId, shopifyProductId: p.shopifyProductId }, data: { lastSeenAt: now } }); // still exists
    return "stale";
  }
  // Concurrent create of the same product: the unique (shop_id, shopify_product_id) makes the second insert a no-op.
  const created = await db.product.createMany({ data: [{ shopId, shopifyProductId: p.shopifyProductId, ...data }], skipDuplicates: true });
  return created.count ? "created" : "stale";
}

/** products/delete or a full-sync sweep: mark deleted, keep reviews, touch nothing in Shopify. Idempotent. */
export async function markProductDeleted({ db, shopId }: Tenant, shopifyProductId: bigint) {
  const r = await db.product.updateMany({ where: { shopId, shopifyProductId, deletedAt: null }, data: { deletedAt: new Date() } });
  return r.count > 0;
}

/** Validates a products/* webhook payload (Shopify REST product shape). Returns null if it is unusable. */
export function parseProductPayload(payload: unknown): ProductSnapshot | { shopifyProductId: bigint } | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const rawId = typeof p.id === "number" || typeof p.id === "string" ? String(p.id) : "";
  if (!/^\d{1,20}$/.test(rawId)) return null;
  const shopifyProductId = BigInt(rawId);
  if (!("handle" in p) && !("title" in p)) return { shopifyProductId }; // delete payloads carry only the id
  const status = String(p.status ?? "").toLowerCase() as ProductStatus;
  const updatedAt = new Date(String(p.updated_at ?? ""));
  if (typeof p.handle !== "string" || !p.handle || typeof p.title !== "string" || !STATUSES.has(status) || Number.isNaN(+updatedAt)) return null;
  return { shopifyProductId, handle: p.handle.toLowerCase(), title: p.title.slice(0, 255), status, updatedAt };
}

export type WebhookResult = "created" | "updated" | "stale" | "deleted" | "ignored-malformed";

/** products/create | products/update | products/delete for an already verified, active shop. */
export async function handleProductWebhook(shopId: string, topic: string, payload: unknown): Promise<WebhookResult> {
  const p = parseProductPayload(payload);
  if (!p) return "ignored-malformed";
  if (topic === "PRODUCTS_DELETE") {
    await withTenant(shopId, (t) => markProductDeleted(t, p.shopifyProductId));
    return "deleted";
  }
  if (!("handle" in p)) return "ignored-malformed";
  return withTenant(shopId, (t) => upsertProduct(t, p));
}

// --- Initial / full catalogue sync -----------------------------------------------------------------------------

export const PRODUCTS_PAGE_QUERY = `#graphql
  query ProoflyProductsPage($after: String) {
    products(first: 100, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes { legacyResourceId handle title status updatedAt }
    }
  }`;

interface Page {
  data?: { products?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { legacyResourceId: string; handle: string; title: string; status: string; updatedAt: string }[] } };
  errors?: { message?: string; extensions?: { code?: string } }[];
  extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable: number; restoreRate: number } } };
}

/** One page with throttle awareness: waits when Shopify's bucket is low, retries THROTTLED and transient errors. */
async function fetchPage(graphql: Graphql, after: string | null, sleep: Sleep, attempts = 5): Promise<NonNullable<NonNullable<Page["data"]>["products"]>> {
  for (let i = 1; ; i++) {
    let body: Page | null = null;
    try { body = (await (await graphql(PRODUCTS_PAGE_QUERY, { variables: { after } })).json()) as Page; } catch (e) { if (i >= attempts) throw e; }
    if (body) {
      if (body.errors?.length && !body.errors.some((e) => e.extensions?.code === "THROTTLED")) throw new Error(`products query: ${JSON.stringify(body.errors).slice(0, 300)}`);
      const products = body.data?.products;
      if (products) {
        const t = body.extensions?.cost?.throttleStatus;
        const cost = body.extensions?.cost?.requestedQueryCost ?? 0;
        if (t && t.currentlyAvailable < cost * 2 && t.restoreRate > 0) await sleep(Math.ceil(((cost * 2 - t.currentlyAvailable) / t.restoreRate) * 1000));
        return products;
      }
      if (i >= attempts) throw new Error("products query throttled");
    }
    await sleep(1000 * 2 ** (i - 1));
  }
}

const STALE_RUN_MS = 30 * 60_000;

/**
 * Full catalogue sync for one shop through ITS OWN Admin API client. Resumable: the cursor is saved after every page,
 * so a failed or interrupted run continues where it stopped. At the end of a complete run, products that Shopify no
 * longer returned are marked deleted (reviews kept). Only one run per shop at a time.
 */
export async function syncCatalog(shopId: string, graphql: Graphql, opts: { sleep?: Sleep } = {}) {
  const sleep = opts.sleep ?? realSleep;
  const now = new Date();
  // Claim the run (or resume a failed/stale one) atomically.
  const claim = await withTenant(shopId, async ({ db }) => {
    const s = await db.shopSettings.findUniqueOrThrow({ where: { shopId } });
    const resume = s.catalogSyncCursor && s.catalogSyncStartedAt && s.catalogSyncStatus !== "completed";
    const claimed = await db.shopSettings.updateMany({
      where: { shopId, OR: [{ catalogSyncStatus: { not: "running" } }, { catalogSyncStartedAt: { lt: new Date(+now - STALE_RUN_MS) } }] },
      data: { catalogSyncStatus: "running", catalogSyncError: null, ...(resume ? {} : { catalogSyncStartedAt: now, catalogSyncCursor: null, catalogSyncCount: 0 }) },
    });
    return claimed.count ? { cursor: resume ? s.catalogSyncCursor : null, startedAt: resume ? s.catalogSyncStartedAt! : now, count: resume ? s.catalogSyncCount : 0 } : null;
  });
  if (!claim) return { status: "skipped" as const };

  let { cursor, count } = claim;
  try {
    do {
      const page = await fetchPage(graphql, cursor, sleep);
      await withTenant(shopId, async (t) => {
        for (const n of page.nodes) {
          const status = n.status.toLowerCase() as ProductStatus;
          if (!STATUSES.has(status)) continue;
          await upsertProduct(t, { shopifyProductId: BigInt(n.legacyResourceId), handle: n.handle.toLowerCase(), title: n.title, status, updatedAt: new Date(n.updatedAt) });
        }
        count += page.nodes.length;
        cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
        await t.db.shopSettings.update({ where: { shopId }, data: { catalogSyncCursor: cursor, catalogSyncCount: count } });
      });
    } while (cursor);
    // Complete run: whatever Shopify no longer has is deleted there. Reviews stay; nothing is written to Shopify.
    const swept = await withTenant(shopId, async ({ db }) => {
      const r = await db.product.updateMany({
        where: { shopId, deletedAt: null, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: claim.startedAt } }] },
        data: { deletedAt: new Date() },
      });
      await db.shopSettings.update({ where: { shopId }, data: { catalogSyncStatus: "completed", catalogSyncFinishedAt: new Date(), catalogSyncCursor: null } });
      return r.count;
    });
    return { status: "completed" as const, count, markedDeleted: swept };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 500);
    await withTenant(shopId, ({ db }) => db.shopSettings.update({ where: { shopId }, data: { catalogSyncStatus: "failed", catalogSyncError: msg } }));
    return { status: "failed" as const, count, error: msg };
  }
}
