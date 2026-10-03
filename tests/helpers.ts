// Shared test helpers. Run with: npm test  (tsx --env-file=.env.test --test tests/*.test.ts)
// All data is fictional and created per test run in the separate proofly_test database.
import { createHmac, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { Session } from "@shopify/shopify-api";
import { sessionStorage } from "../app/shopify.server";
import { signProxyParams } from "../app/lib/devsign.server";
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

/** Stand-in for the Admin API client of an authenticated session: answers the `shop` identity query. */
export const fakeAdmin = (shop: { myshopifyDomain: string; id: bigint; name: string; host: string }) => ({
  graphql: async () =>
    Response.json({ data: { shop: { id: `gid://shopify/Shop/${shop.id}`, name: shop.name, myshopifyDomain: shop.myshopifyDomain, primaryDomain: { host: shop.host } } } }),
});

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

/** A storefront request exactly as Shopify's app proxy would send it for `domain` (HMAC-signed). */
export function proxyRequest(domain: string, path: string, extra: Record<string, string> = {}, init: RequestInit = {}) {
  const params = new URLSearchParams({ ...extra, shop: domain, path_prefix: "/apps/proofly", timestamp: String(Math.floor(Date.now() / 1000)), logged_in_customer_id: "" });
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
