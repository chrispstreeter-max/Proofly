// Shared test helpers. Run with: npm test  (tsx --env-file=.env.test --test tests/*.test.ts)
// All data is fictional and created per test run in the separate proofly_test database.
import { createHmac, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { Session } from "@shopify/shopify-api";
import { sessionStorage } from "../app/shopify.server";
import { signProxyParams } from "../app/lib/devsign.server";
import { DEFAULT_PROXY_PATH } from "../app/lib/proxy-path.server";
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
  await owner.$executeRawUnsafe(`TRUNCATE TABLE shops, "Session" RESTART IDENTITY CASCADE`);
}

/** Fictional custom storefront host of a fixture merchant. */
export const storefrontHost = (label: string) => `store-${label.toLowerCase()}.example.com`;

export interface Merchant {
  shopId: string;
  reviewBody: string;
  domain: string;
  productId: string;
  reviewId: string;
  imageId: string;
  importJobId: string;
  moderationActionId: string;
}

/** Installs a fictional merchant: shop row + encrypted offline session + one product/review/image/reply/etc. */
export async function installMerchant(domain: string, label: string): Promise<Merchant> {
  const shop = await registerShop({
    shopDomain: domain, shopifyShopId: BigInt(9_100_000_000_000 + Math.floor(Math.random() * 1e6)), shopName: `Fixture Store ${label}`,
    storefrontHosts: [storefrontHost(label)],
  });
  await storeOfflineSession(domain, label);
  return withTenant(shop.id, async ({ db, shopId }) => {
    const product = await db.product.create({
      data: { shopId, shopifyProductId: SAME_PRODUCT_ID, handle: SAME_HANDLE, title: `Fixture Product ${label}`, reviewCount: 1, averageRating: 5, rating5: 1 },
    });
    const review = await db.review.create({
      data: {
        shopId, productId: product.id, source: "csv", sourceReviewId: SAME_SOURCE_REVIEW_ID, rating: 5, title: `Title ${label}`,
        body: `Fictional review body for store ${label}.`, reviewerName: `Reviewer ${label} Example`, reviewDate: new Date("2026-01-01T00:00:00Z"), status: "published",
      },
    });
    const image = await db.reviewImage.create({
      data: {
        shopId, reviewId: review.id, originalFilename: "fixture.jpg", storageKey: `s/${shopId}/originals/${review.id}/x.jpg`,
        thumbKey: `s/${shopId}/r/${review.id}/x-320.webp`, largeKey: `s/${shopId}/r/${review.id}/x-1600.webp`,
        contentType: "image/jpeg", fileSize: 1234, sha256: "0".repeat(64),
      },
    });
    await db.reviewReply.create({ data: { shopId, reviewId: review.id, reply: `Reply from store ${label}` } });
    const job = await db.importJob.create({ data: { shopId, source: "csv", status: "finished" } });
    const action = await db.moderationAction.create({ data: { shopId, reviewId: review.id, action: "approve", fromStatus: "pending", toStatus: "published", actor: "fixture" } });
    return { shopId, reviewBody: review.body, domain, productId: product.id, reviewId: review.id, imageId: image.id, importJobId: job.id, moderationActionId: action.id };
  });
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
  calls: { op: string; variables?: Record<string, unknown> }[] = [];
  products: { legacyResourceId: string; handle: string; title: string; status: string; updatedAt: string }[] = [];
  missingProducts = new Set<string>(); // product gids Shopify no longer has
  /** App Pricing subscriptions as Shopify reports them (newest last). Empty = no subscription (Free). */
  subscriptions: { id: string; name: string; status: string; planHandle: string | null; interval?: "EVERY_30_DAYS" | "ANNUAL"; amount?: string; test?: boolean; createdAt?: string }[] = [];
  pageSize = 2;
  private failures: { op: string; kind: FailKind; times: number }[] = [];
  constructor(public identity?: Identity) {}

  /** An AppSubscription exactly as the Admin API returns it for ProoflySubscriptionState. */
  static subscriptionNode(x: FakeShopify["subscriptions"][number]) {
    return {
      id: x.id, name: x.name, status: x.status, test: x.test ?? false, trialDays: 0, createdAt: x.createdAt ?? "2026-10-01T00:00:00Z", currentPeriodEnd: null,
      lineItems: [{ plan: { pricingDetails: { __typename: "AppRecurringPricing", planHandle: x.planHandle, interval: x.interval ?? "EVERY_30_DAYS", price: { amount: x.amount ?? "0.0", currencyCode: "USD" } } } }],
    };
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
      case "ProoflyEnableRatingDefinition":
        return Response.json({ data: { standardMetafieldDefinitionEnable: { userErrors: [] } } });
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
