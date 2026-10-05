// Shared test helpers. Run with: npm test  (tsx --env-file=.env.test --test tests/*.test.ts)
// All data is fictional and created per test run in the separate proofly_test database.
import { createHmac, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { Session } from "@shopify/shopify-api";
import { sessionStorage } from "../app/shopify.server";
import { signProxyParams } from "../app/lib/devsign.server";
import { DEFAULT_PROXY_PATH } from "../app/lib/proxy-path.server";
import { bumpStats } from "../app/lib/entitlements.server";
import { createReview, ensureReviewDefinition, scanReviews, type ReviewInput, type ShopApi, type StoredReview } from "../app/lib/review-store.server";
import { registerShop, withTenant } from "../app/lib/tenant.server";

/** Schema-owner connection, used ONLY for test setup/teardown and FK checks that must bypass RLS. */
export const owner = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_DATABASE_URL } } });

export const DOMAIN_A = "proofly-test-a.myshopify.com";
export const DOMAIN_B = "proofly-test-b.myshopify.com";
export const DOMAIN_C = "proofly-test-c.myshopify.com"; // installed during the lifecycle tests
export const SAME_PRODUCT_ID = 9_000_000_000_001n; // deliberately identical in both shops
export const SAME_SOURCE_REVIEW_ID = "fixture-review-1"; // deliberately identical in both shops
export const SAME_HANDLE = "fixture-product"; // deliberately identical in both shops

export async function resetDb() {
  stores.clear(); // every test shop's in-memory Shopify store too
  await owner.$executeRawUnsafe(`TRUNCATE TABLE shops, "Session", rate_limits, shop_deletions RESTART IDENTITY CASCADE`);
}

/** Fictional custom storefront host of a fixture merchant. */
export const storefrontHost = (label: string) => `store-${label.toLowerCase()}.example.com`;

export interface Merchant {
  shopId: string;
  reviewBody: string;
  domain: string;
  productId: string;
  /** The fixture review's id: its metaobject GID in the shop's (fake) Shopify store. */
  reviewId: string;
  importJobId: string;
  /** This shop's review store (its own fake Shopify Admin API). */
  api: ShopApi;
}

/** Installs a fictional merchant: shop row + encrypted offline session + a fresh fake Shopify store holding one product
 *  (cached) and one published review with a reply, plus an import job and a moderation audit entry. */
export async function installMerchant(domain: string, label: string): Promise<Merchant> {
  stores.set(domain, new FakeShopify({ myshopifyDomain: domain, id: 9_300_000_000_000n + BigInt(stores.size), name: `Fixture Store ${label}`, host: storefrontHost(label) }));
  const shop = await registerShop({
    shopDomain: domain, shopifyShopId: BigInt(9_100_000_000_000 + Math.floor(Math.random() * 1e6)), shopName: `Fixture Store ${label}`,
    storefrontHosts: [storefrontHost(label)],
  });
  await storeOfflineSession(domain, label);
  const api = apiOf(domain, shop.id);
  await ensureReviewDefinition(api);
  const { product, job } = await withTenant(shop.id, async ({ db, shopId }) => ({
    product: await db.product.create({
      data: { shopId, shopifyProductId: SAME_PRODUCT_ID, handle: SAME_HANDLE, title: `Fixture Product ${label}`, reviewCount: 1, averageRating: 5, rating5: 1 },
    }),
    job: await db.importJob.create({ data: { shopId, source: "csv", status: "finished" } }),
  }));
  const review = await seedReview(api, {
    productId: SAME_PRODUCT_ID, source: "csv", sourceReviewId: SAME_SOURCE_REVIEW_ID, rating: 5, title: `Title ${label}`,
    body: `Fictional review body for store ${label}.`, reviewerName: `Reviewer ${label} Example`, reviewDate: new Date("2026-01-01T00:00:00Z"),
    status: "published", held: false, reply: `Reply from store ${label}`, replyDate: new Date("2026-01-02T00:00:00Z"),
  });
  await withTenant(shop.id, ({ db, shopId }) => db.auditLog.create({ data: { shopId, actor: "fixture", action: "review.approve", entity: "review", entityId: review.id, details: { from: "pending", to: "published" } } }));
  return { shopId: shop.id, reviewBody: review.body, domain, productId: product.id, reviewId: review.id, importJobId: job.id, api };
}

/** Every test shop's in-memory Shopify store, by myshopify domain. */
export const stores = new Map<string, FakeShopify>();
export const storeOf = (domain: string) => {
  if (!stores.has(domain)) stores.set(domain, new FakeShopify({ myshopifyDomain: domain, id: 9_400_000_000_000n + BigInt(stores.size), name: domain, host: domain }));
  return stores.get(domain)!;
};
/** The review store of a test shop: its own fake Admin API (never another shop's). */
export const apiOf = (domain: string, shopId: string): ShopApi => ({ shopId, graphql: storeOf(domain).graphql });
// The app's real Admin API clients (authenticate.admin / appProxy / unauthenticated) reach the same fake store.
// Shopify's staged-upload storage (bulk mutation inputs and results) of a test shop: https://fake-shopify-storage.test/<shop>/…
(globalThis as { __prooflyFakeStorage?: (url: URL, init?: RequestInit) => Promise<Response> }).__prooflyFakeStorage = (url, init) => storeOf(url.pathname.split("/")[1]).storage(url, init);
(globalThis as { __prooflyFakeAdmin?: (url: URL, init?: RequestInit) => Promise<Response> }).__prooflyFakeAdmin = async (url, init) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: Record<string, unknown> };
  return storeOf(url.hostname).graphql(body.query, { variables: body.variables });
};

/** Creates a review in a shop's store and counts it (what Proofly's own write paths do). */
export async function seedReview(api: ShopApi, input: Partial<ReviewInput> & Pick<ReviewInput, "productId">) {
  const r = await createReview(api, {
    source: "csv", sourceReviewId: `seed-${randomUUID()}`, rating: 5, title: "", body: "Fictional body.", reviewerName: "Fixture Example",
    reviewDate: new Date("2026-01-01T00:00:00Z"), status: "published", held: false, ...input,
  });
  if (!r) throw new Error("seedReview: duplicate review");
  await bumpStats(api.shopId, null, r);
  return r;
}

/** Empties a shop's review store and its cached counts (tests that need to start from zero reviews). */
export async function clearReviews(m: { domain: string; shopId: string }) {
  storeOf(m.domain).metaobjects.clear();
  storeOf(m.domain).indexed.clear();
  await owner.shopSettings.update({ where: { shopId: m.shopId }, data: { reviewStats: {} } });
}

/** All reviews in a shop's store (any state). */
export async function reviewsIn(api: ShopApi) {
  const out: StoredReview[] = [];
  for await (const r of scanReviews(api, {})) out.push(r);
  return out;
}

/** Stores the offline session a successful token exchange would store (encrypted, via the app's session storage). */
export const storeOfflineSession = (domain: string, label: string) =>
  sessionStorage.storeSession(
    new Session({ id: `offline_${domain}`, shop: domain, state: "", isOnline: false, scope: process.env.SCOPES, accessToken: `fixture-token-${label}` }),
  );

type Identity = { myshopifyDomain: string; id: bigint; name: string; host: string };
type FailKind = "throw" | "throttle" | "userError";

/**
 * In-memory Shopify Admin API for offline tests (no network): shop identity, app installation, catalogue pages and
 * product/app metafields. Records every call; failures can be injected per operation.
 */
export class FakeShopify {
  metafields = new Map<string, string>(); // `${ownerId}|${namespace}.${key}` → value
  metafieldDefinitions = new Map<string, unknown>(); // `${namespace}.${key}` → definition input
  /** What Shopify does to app-owned data when the app is uninstalled: app-data and $app metafields are gone. */
  uninstallApp() {
    for (const k of [...this.metafields.keys()]) if (k.startsWith("gid://shopify/AppInstallation/") || k.includes("|$app")) this.metafields.delete(k);
  }
  /** The storefront projection of a product (parsed), or null when none was published. */
  projection(productId: bigint | number) {
    const v = this.metafields.get(`gid://shopify/Product/${productId}|$app:proofly.reviews`);
    return v ? (JSON.parse(v) as { summary: { count: number; average: number; distribution: number[] }; complete: boolean; reviews: { rating: number; title: string; body: string; name: string; date: string; verified: boolean; reply: { body: string; date: string } | null }[] }) : null;
  }
  calls: { op: string; variables?: Record<string, unknown> }[] = [];
  // Bulk mutations: staged input files and operations. Each line runs through this fake's own mutation handling.
  staged = new Map<string, string>(); // staged upload key → JSONL
  bulkOps = new Map<string, { status: string; result: string; pollsLeft: number; lines: number }>();
  /** Polls that report RUNNING before an operation completes (heartbeat / resume tests). */
  bulkPolls = 0;
  /** Bulk input line numbers whose mutation reports a (non-TAKEN) error. */
  bulkFailLines = new Set<number>();
  /** Storage host of staged uploads and result files (tests/no-network.ts routes it here). */
  async storage(url: URL, init?: RequestInit) {
    const [, , kind, key] = url.pathname.split("/");
    if (kind === "upload" && init?.method === "POST") {
      const form = await new Request(url, init).formData();
      this.staged.set(String(form.get("key")), await (form.get("file") as Blob).text());
      return new Response(null, { status: 204 });
    }
    if (kind === "results") return new Response(this.bulkOps.get(decodeURIComponent(key))?.result ?? "", { status: 200 });
    return new Response("not found", { status: 404 });
  }
  products: { legacyResourceId: string; handle: string; title: string; status: string; updatedAt: string }[] = [];
  missingProducts = new Set<string>(); // product gids Shopify no longer has
  /** Variant SKUs of this shop's Shopify catalogue: sku → Shopify product ids. */
  skus = new Map<string, bigint[]>();
  /** App Pricing subscriptions as Shopify reports them (newest last). Empty = no subscription (Free). */
  subscriptions: { id: string; name: string; status: string; planHandle: string | null; interval?: "EVERY_30_DAYS" | "ANNUAL"; amount?: string; test?: boolean; createdAt?: string }[] = [];
  pageSize = 2;
  /** Metaobject definitions and entries of THIS store (ids are unique across all fake stores, as in Shopify). */
  definitions = new Map<string, { id: string; type: string; access: { admin: string; storefront: string }; fields: { key: string; type: string; filterable: boolean }[] }>();
  metaobjects = new Map<string, { id: string; type: string; handle: string; updatedAt: string; fields: Map<string, string> }>();
  /**
   * What metaobject SEARCH sees. Real Shopify indexes writes only seconds later (verified live); with `searchLag` on,
   * writes stay invisible to `metaobjects(query:)` until flushIndex(), while reads by id are always current.
   */
  indexed = new Map<string, FakeMetaobject>();
  searchLag = false;
  flushIndex() { this.indexed = new Map([...this.metaobjects].map(([id, m]) => [id, { ...m, fields: new Map(m.fields) }])); }
  private indexWrite(m: FakeMetaobject) { if (!this.searchLag) this.indexed.set(m.id, { ...m, fields: new Map(m.fields) }); }
  static nextId = 1;
  private failures: { op: string; kind: FailKind; times: number }[] = [];
  constructor(public identity?: Identity) {}

  /** An AppSubscription exactly as the Admin API returns it for ProoflySubscriptionState. */
  /** What Shopify keeps of a field value: `date_time` fields are stored to the second (verified on a real store). */
  static stored(key: string, value: string) {
    return (key === "review_date" || key === "reply_date") && value ? new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z") : value;
  }
  static subscriptionNode(x: FakeShopify["subscriptions"][number]) {
    return {
      id: x.id, name: x.name, status: x.status, test: x.test ?? false, trialDays: 0, createdAt: x.createdAt ?? "2026-10-01T00:00:00Z", currentPeriodEnd: null,
      lineItems: [{ plan: { pricingDetails: { __typename: "AppRecurringPricing", planHandle: x.planHandle, interval: x.interval ?? "EVERY_30_DAYS", price: { amount: x.amount ?? "0.0", currencyCode: "USD" } } } }],
    };
  }

  static node(m: FakeMetaobject) {
    return { id: m.id, handle: m.handle, updatedAt: m.updatedAt, fields: [...m.fields].map(([key, value]) => ({ key, value })) };
  }
  /** Edits an entry the way a merchant (or another app) can in Shopify admin — bypassing Proofly. */
  editOutside(id: string, fields: Record<string, string>) {
    const m = this.metaobjects.get(id)!;
    for (const [k, val] of Object.entries(fields)) m.fields.set(k, val);
    this.indexWrite(m);
  }

  failNext(op: string, kind: FailKind, times = 1) { this.failures.push({ op, kind, times }); }
  ops(op?: string) { return this.calls.filter((c) => !op || c.op === op); }
  rating(productId: bigint) {
    const owner = `gid://shopify/Product/${productId}`;
    const r = this.metafields.get(`${owner}|reviews.rating`);
    const c = this.metafields.get(`${owner}|reviews.rating_count`);
    return { average: r ? JSON.parse(r).value as string : null, count: c === undefined ? null : Number(c) };
  }
  setRating(productId: bigint, average: string | null, count: number | null) {
    const owner = `gid://shopify/Product/${productId}`;
    if (average === null) this.metafields.delete(`${owner}|reviews.rating`);
    else this.metafields.set(`${owner}|reviews.rating`, JSON.stringify({ value: average, scale_min: "1.0", scale_max: "5.0" }));
    if (count === null) this.metafields.delete(`${owner}|reviews.rating_count`);
    else this.metafields.set(`${owner}|reviews.rating_count`, String(count));
  }

  graphql = async (query: string, o: { variables?: Record<string, unknown> } = {}) => {
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
    const v = o.variables ?? {};
    this.calls.push({ op, variables: v });
    const f = this.failures.find((x) => x.op === op && x.times > 0);
    if (f) {
      f.times--;
      if (f.kind === "throw") throw new Error("network error (injected)");
      if (f.kind === "throttle") return Response.json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] });
      return Response.json({ data: { metafieldsSet: { metafields: [], userErrors: [{ field: ["value"], message: "injected", code: "INVALID" }] } } });
    }
    switch (op) {
      case "ProoflyShopIdentity": {
        const s = this.identity!;
        return Response.json({ data: { shop: { id: `gid://shopify/Shop/${s.id}`, name: s.name, myshopifyDomain: s.myshopifyDomain, primaryDomain: { host: s.host } } } });
      }
      case "ProoflyCurrentAppInstallation":
        return Response.json({ data: { currentAppInstallation: { id: "gid://shopify/AppInstallation/1" } } });
      case "ProoflySetAppMetafield":
      case "ProoflyPublishProjection":
      case "ProoflySetRatings": {
        const mfs = v.metafields as { ownerId: string; namespace: string; key: string; value: string }[];
        for (const m of mfs) this.metafields.set(`${m.ownerId}|${m.namespace}.${m.key}`, m.value);
        return Response.json({ data: { metafieldsSet: { metafields: mfs.map(() => ({ id: "gid://shopify/Metafield/1" })), userErrors: [] } } });
      }
      case "ProoflyDeleteRatings": {
        const mfs = v.metafields as { ownerId: string; namespace: string; key: string }[];
        for (const m of mfs) this.metafields.delete(`${m.ownerId}|${m.namespace}.${m.key}`);
        return Response.json({ data: { metafieldsDelete: { deletedMetafields: mfs, userErrors: [] } } });
      }
      case "ProoflyReadRatings": {
        const nodes = (v.ids as string[]).map((id) => {
          if (this.missingProducts.has(id)) return null;
          const r = this.metafields.get(`${id}|reviews.rating`);
          const c = this.metafields.get(`${id}|reviews.rating_count`);
          return { id, rating: r ? { value: r } : null, ratingCount: c !== undefined ? { value: c } : null };
        });
        return Response.json({ data: { nodes } });
      }
      case "ProoflyProductsPage": {
        const start = v.after ? Number(v.after) : 0;
        const nodes = this.products.slice(start, start + this.pageSize);
        const next = start + this.pageSize;
        return Response.json({
          data: { products: { pageInfo: { hasNextPage: next < this.products.length, endCursor: String(next) }, nodes } },
          extensions: { cost: { requestedQueryCost: 52, throttleStatus: { currentlyAvailable: 1900, restoreRate: 100 } } },
        });
      }
      case "ProoflySubscriptionState": {
        const node = FakeShopify.subscriptionNode;
        return Response.json({ data: { currentAppInstallation: {
          activeSubscriptions: this.subscriptions.filter((x) => ["ACTIVE", "FROZEN"].includes(x.status)).map(node),
          allSubscriptions: { nodes: [...this.subscriptions].reverse().map(node) },
        } } });
      }
      case "ProoflySkuLookup": {
        const wanted = [...String(v.query).matchAll(/sku:"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
        const nodes = wanted.flatMap((sku) => (this.skus.get(sku) ?? []).map((id) => ({ sku, product: { legacyResourceId: String(id) } })));
        return Response.json({ data: { productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });
      }
      case "ProoflyReviewDefinition": {
        const d = this.definitions.get(String(v.type));
        return Response.json({ data: { metaobjectDefinitionByType: d ? { id: d.id, fieldDefinitions: d.fields.map((f) => ({ key: f.key, capabilities: { adminFilterable: { enabled: f.filterable } } })) } : null } });
      }
      case "ProoflyCreateReviewDefinition": {
        const d = v.d as { type: string; access: { storefront: string }; fieldDefinitions: { key: string; type: string; capabilities?: { adminFilterable?: { enabled: boolean } } }[] };
        if (this.definitions.has(d.type)) return Response.json({ data: { metaobjectDefinitionCreate: { userErrors: [{ message: "Type has already been taken" }] } } });
        this.definitions.set(d.type, { id: `gid://shopify/MetaobjectDefinition/${FakeShopify.nextId++}`, type: d.type, access: { admin: "PUBLIC_READ_WRITE", storefront: d.access.storefront },
          fields: d.fieldDefinitions.map((f) => ({ key: f.key, type: f.type, filterable: !!f.capabilities?.adminFilterable?.enabled })) });
        return Response.json({ data: { metaobjectDefinitionCreate: { userErrors: [] } } });
      }
      case "ProoflyUpdateReviewDefinition": {
        const d = [...this.definitions.values()].find((x) => x.id === v.id)!;
        for (const c of (v.d as { fieldDefinitions: { create?: { key: string; type: string; capabilities?: { adminFilterable?: { enabled: boolean } } }; update?: { key: string; capabilities: { adminFilterable: { enabled: boolean } } } }[] }).fieldDefinitions) {
          if (c.create) d.fields.push({ key: c.create.key, type: c.create.type, filterable: !!c.create.capabilities?.adminFilterable?.enabled });
          if (c.update) d.fields.find((f) => f.key === c.update!.key)!.filterable = c.update.capabilities.adminFilterable.enabled;
        }
        return Response.json({ data: { metaobjectDefinitionUpdate: { userErrors: [] } } });
      }
      case "ProoflyReviews": {
        const def = this.definitions.get(String(v.type));
        let match: (m: FakeMetaobject) => boolean;
        try { match = v.query ? compileQuery(String(v.query), def?.fields ?? []) : () => true; } catch (e) {
          return Response.json({ errors: [{ message: (e as Error).message, extensions: { code: "definition-not-admin-filterable" } }] });
        }
        const all = [...this.indexed.values()].filter((m) => m.type === v.type && match(m) && this.metaobjects.has(m.id))
          .sort((a, b) => (a.fields.get("sort_key") ?? "").localeCompare(b.fields.get("sort_key") ?? "") * (v.reverse ? -1 : 1));
        const start = v.after ? Number(v.after) : 0;
        const nodes = all.slice(start, start + Number(v.first));
        return Response.json({ data: { metaobjects: { nodes: nodes.map(FakeShopify.node), pageInfo: { hasNextPage: start + nodes.length < all.length, endCursor: String(start + nodes.length) } } } });
      }
      case "ProoflyReview": {
        const m = this.metaobjects.get(String(v.id));
        return Response.json({ data: { metaobject: m ? { type: m.type, ...FakeShopify.node(m) } : null } });
      }
      case "ProoflyCreateReview": {
        const m = v.m as { type: string; handle: string; fields: { key: string; value: string }[] };
        if ([...this.metaobjects.values()].some((x) => x.type === m.type && x.handle === m.handle)) {
          return Response.json({ data: { metaobjectCreate: { metaobject: null, userErrors: [{ message: "Handle has already been taken", code: "TAKEN" }] } } });
        }
        const created = { id: `gid://shopify/Metaobject/${FakeShopify.nextId++}`, type: m.type, handle: m.handle, updatedAt: new Date().toISOString(), fields: new Map(m.fields.map((f) => [f.key, FakeShopify.stored(f.key, f.value)])) };
        this.metaobjects.set(created.id, created);
        this.indexWrite(created);
        return Response.json({ data: { metaobjectCreate: { metaobject: FakeShopify.node(created), userErrors: [] } } });
      }
      case "ProoflyUpdateReview": {
        const m = this.metaobjects.get(String(v.id));
        if (!m) return Response.json({ data: { metaobjectUpdate: { metaobject: null, userErrors: [{ message: "Metaobject not found" }] } } });
        for (const f of (v.m as { fields: { key: string; value: string }[] }).fields) m.fields.set(f.key, FakeShopify.stored(f.key, f.value));
        m.updatedAt = new Date().toISOString();
        this.indexWrite(m);
        return Response.json({ data: { metaobjectUpdate: { metaobject: FakeShopify.node(m), userErrors: [] } } });
      }
      case "ProoflyEnableRatingDefinition":
        return Response.json({ data: { standardMetafieldDefinitionEnable: { userErrors: [] } } });
      case "ProoflyStageBulkInput": {
        const key = `tmp/bulk/${randomUUID()}/proofly_bulk.jsonl`;
        const url = `https://fake-shopify-storage.test/${this.identity?.myshopifyDomain ?? "shop"}/upload`;
        return Response.json({ data: { stagedUploadsCreate: { stagedTargets: [{ url, resourceUrl: null, parameters: [{ name: "key", value: key }, { name: "Content-Type", value: "text/jsonl" }] }], userErrors: [] } } });
      }
      case "ProoflyRunBulk": {
        const input = this.staged.get(v.path as string);
        if (input === undefined) return Response.json({ data: { bulkOperationRunMutation: { bulkOperation: null, userErrors: [{ field: ["stagedUploadPath"], message: "file not found", code: "NO_SUCH_FILE" }] } } });
        const lines = input.split("\n").filter(Boolean);
        const out: string[] = [];
        for (const [i, line] of lines.entries()) {
          const res = this.bulkFailLines.has(i)
            ? { data: { metaobjectCreate: { metaobject: null, userErrors: [{ message: "Value is invalid (injected)", code: "INVALID" }] } } }
            : await (await this.graphql(v.mutation as string, { variables: JSON.parse(line) })).json();
          out.push(JSON.stringify({ ...res, __lineNumber: i }));
        }
        const id = `gid://shopify/BulkOperation/${FakeShopify.nextId++}`;
        this.bulkOps.set(id, { status: "COMPLETED", result: out.reverse().join("\n"), pollsLeft: this.bulkPolls, lines: lines.length }); // not in input order
        return Response.json({ data: { bulkOperationRunMutation: { bulkOperation: { id, status: "CREATED" }, userErrors: [] } } });
      }
      case "ProoflyBulkStatus": {
        const op = this.bulkOps.get(v.id as string);
        if (!op) return Response.json({ data: { bulkOperation: null } });
        const running = op.pollsLeft-- > 0;
        const url = running ? null : `https://fake-shopify-storage.test/${this.identity?.myshopifyDomain ?? "shop"}/results/${encodeURIComponent(v.id as string)}`;
        return Response.json({ data: { bulkOperation: { id: v.id, status: running ? "RUNNING" : op.status, errorCode: null, objectCount: String(op.lines), url, partialDataUrl: null } } });
      }
      case "ProoflyCreateProjectionDefinition": {
        const d = v.d as { namespace: string; key: string };
        const taken = this.metafieldDefinitions.has(`${d.namespace}.${d.key}`);
        this.metafieldDefinitions.set(`${d.namespace}.${d.key}`, v.d);
        return Response.json({ data: { metafieldDefinitionCreate: { createdDefinition: taken ? null : { id: "gid://shopify/MetafieldDefinition/1" }, userErrors: taken ? [{ code: "TAKEN", message: "Key is in use" }] : [] } } });
      }
      default:
        throw new Error(`FakeShopify: unexpected operation ${op}`);
    }
  };
}

/** Stand-in for the Admin API client of an authenticated session (identity, app installation, metafields). */
export const fakeAdmin = (shop: Identity) => new FakeShopify(shop);

/** A webhook exactly as Shopify sends it for `domain` (HMAC-SHA256 of the raw body with the app secret). */
export function webhookRequest(domain: string, topic: string, path: string, payload: unknown = {}) {
  const body = JSON.stringify(payload);
  return new Request(`${process.env.SHOPIFY_APP_URL}${path}`, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": createHmac("sha256", process.env.SHOPIFY_API_SECRET!).update(body).digest("base64"),
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": domain,
      "X-Shopify-API-Version": "2026-10",
      "X-Shopify-Webhook-Id": randomUUID(),
    },
  });
}

/** A storefront request exactly as Shopify's app proxy would send it for `domain` via `pathPrefix` (HMAC-signed). */
export function proxyRequest(domain: string, path: string, extra: Record<string, string> = {}, init: RequestInit = {}, pathPrefix = DEFAULT_PROXY_PATH) {
  const params = new URLSearchParams({ ...extra, shop: domain, path_prefix: pathPrefix, timestamp: String(Math.floor(Date.now() / 1000)), logged_in_customer_id: "" });
  signProxyParams(params, process.env.SHOPIFY_API_SECRET!);
  return new Request(`${process.env.SHOPIFY_APP_URL}/proxy/${path}?${params}`, init);
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** A valid Shopify session token (App Bridge JWT) for `domain`, signed with the app secret. */
export function sessionToken(domain: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: `https://${domain}/admin`, dest: `https://${domain}`, aud: process.env.SHOPIFY_API_KEY,
    sub: "42", exp: now + 60, nbf: now - 5, iat: now - 5, jti: randomUUID(), sid: randomUUID(),
  }));
  const sig = createHmac("sha256", process.env.SHOPIFY_API_SECRET!).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

/** An embedded-admin request authenticated as `domain`. */
export function adminRequest(domain: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${sessionToken(domain)}`);
  return new Request(`${process.env.SHOPIFY_APP_URL}${path}`, { ...init, headers });
}

/** Runs a loader/action and returns either its data or the thrown Response (React Router semantics). */
export async function run<T>(fn: () => Promise<T>): Promise<{ data?: T; response?: Response }> {
  try {
    const out = await fn();
    return out instanceof Response ? { response: out } : { data: out };
  } catch (e) {
    if (e instanceof Response) return { response: e };
    throw e;
  }
}

export const args = <T>(request: Request, params: Record<string, string> = {}) => ({ request, params, context: {} }) as unknown as T;

type FakeMetaobject = { id: string; type: string; handle: string; updatedAt: string; fields: Map<string, string> };
/**
 * Shopify metaobject search syntax, as far as Proofly uses it (verified against a real store in Phase 0):
 * `fields.<key>:<value>` on admin-filterable fields only (else Shopify's error), `handle:`, quoted values, a trailing
 * `*` prefix, `>= > <= <` ranges (numbers, dates), `AND` binding tighter than `OR`, parentheses.
 */
export function compileQuery(query: string, fields: { key: string; type: string; filterable: boolean }[]): (m: FakeMetaobject) => boolean {
  const tokens = query.match(/\(|\)|\bAND\b|\bOR\b|[\w.]+:(?:"(?:[^"\\]|\\.)*"|(?:\\ |[^\s()])+)/g) ?? [];
  let i = 0;
  const term = (t: string): ((m: FakeMetaobject) => boolean) => {
    const [, key, raw] = /^([\w.]+):(.*)$/.exec(t)!;
    let op = "=", val = raw;
    const r = /^(>=|<=|>|<)(.*)$/.exec(raw);
    if (r) { op = r[1]; val = r[2]; }
    val = val.startsWith('"') ? JSON.parse(val) : val.replace(/\\ /g, " ");
    const prefix = val.endsWith("*") ? val.slice(0, -1).toLowerCase() : null;
    const get = (m: FakeMetaobject) => (key === "handle" ? m.handle : m.fields.get(key.replace(/^fields\./, "")) ?? "");
    if (key.startsWith("fields.")) {
      const f = fields.find((x) => x.key === key.slice(7));
      if (!f?.filterable) throw new Error(`Invalid metafield query: definition with namespace 'proofly_review' and key '${key.slice(7)}' is not admin filterable`);
      if (f.type === "number_integer" || f.type === "date_time") {
        const num = (x: string) => (f.type === "number_integer" ? Number(x) : Date.parse(x));
        return (m) => { const a = num(get(m)), b = num(val); return op === ">=" ? a >= b : op === "<=" ? a <= b : op === ">" ? a > b : op === "<" ? a < b : a === b; };
      }
    }
    return (m) => (prefix !== null ? get(m).toLowerCase().startsWith(prefix) : get(m).toLowerCase() === val.toLowerCase());
  };
  const primary = (): ((m: FakeMetaobject) => boolean) => {
    if (tokens[i] === "(") { i++; const e = or(); i++; return e; }
    return term(tokens[i++]);
  };
  const and = () => { const parts = [primary()]; while (tokens[i] === "AND") { i++; parts.push(primary()); } return (m: FakeMetaobject) => parts.every((p) => p(m)); };
  const or = (): ((m: FakeMetaobject) => boolean) => { const parts = [and()]; while (tokens[i] === "OR") { i++; parts.push(and()); } return (m) => parts.some((p) => p(m)); };
  return or();
}
