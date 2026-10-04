// Checkpoint 4: product sync, product webhooks, canonical aggregation, rating-cache ownership,
// metafield sync + reconciliation, per-merchant proxy paths, API version.
// Shopify is the in-memory FakeShopify (tests/helpers.ts) — no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import { recomputeProduct, recomputeProducts } from "../app/lib/aggregates.server";
import { moderate } from "../app/lib/moderation.server";
import { bumpStats, releaseEligibleReviews } from "../app/lib/entitlements.server";
import { getReview, updateReview, type ShopApi, type StoredReview } from "../app/lib/review-store.server";
import { syncCatalog } from "../app/lib/products.server";
import { DEFAULT_PROXY_PATH, parseProxyPath, setProxyPath } from "../app/lib/proxy-path.server";
import { reconcileRatingCache, syncRatingCache } from "../app/lib/rating-cache.server";
import { ratingsByHandle } from "../app/lib/reviews.server";
import { markUninstalled, publishShopProxyPath, withTenant, type Tenant } from "../app/lib/tenant.server";
import { loader as proxyList } from "../app/routes/proxy.products.$id.reviews";
import { loader as proxyRatings } from "../app/routes/proxy.ratings";
import { action as productsWebhook } from "../app/routes/webhooks.products";
import { API_VERSION } from "../app/shopify-api-version";
import { renderBlock, liquidProduct } from "../scripts/lib/extension-liquid";
import {
  args, DOMAIN_A, DOMAIN_B, DOMAIN_C, FakeShopify, installMerchant, owner, proxyRequest, resetDb, reviewsIn, run, SAME_HANDLE, SAME_PRODUCT_ID,
  seedReview, webhookRequest, type Merchant,
} from "./helpers";

const noSleep = async () => {};
let A: Merchant, B: Merchant;
before(async () => {
  await resetDb();
  A = await installMerchant(DOMAIN_A, "A");
  B = await installMerchant(DOMAIN_B, "B");
});
after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

const asA = <T>(fn: (t: Tenant) => Promise<T>) => withTenant(A.shopId, fn);
const asB = <T>(fn: (t: Tenant) => Promise<T>) => withTenant(B.shopId, fn);
let seq = 0;

async function product(t: Tenant, shopifyProductId: bigint, handle: string) {
  return t.db.product.create({ data: { shopId: t.shopId, shopifyProductId, handle, title: handle, status: "active", lastSeenAt: new Date() } });
}
const apiFor = (shopId: string) => (shopId === A.shopId ? A.api : B.api);
/** A review (in the shop's Shopify store) for the cached product row `productId`. */
async function review(t: Tenant, productId: string, rating: number, o: { status?: "published" | "pending" | "hidden" | "rejected"; hold?: "plan_limit" | "moderation" } = {}) {
  const p = await t.db.product.findFirstOrThrow({ where: { id: productId } });
  return seedReview(apiFor(t.shopId), { productId: p.shopifyProductId, sourceReviewId: `s4-${++seq}`, rating, body: `body ${seq}`, reviewerName: "Fixture", reviewDate: new Date(Date.UTC(2026, 0, 1 + seq)), status: o.status ?? "published", held: o.hold === "plan_limit" });
}
async function recompute(t: Tenant, productId: string) {
  const p = await t.db.product.findFirstOrThrow({ where: { id: productId } });
  return recomputeProduct(apiFor(t.shopId), p.shopifyProductId);
}
/** Puts reviews on the plan-limit hold, or releases them through the allowance (oldest first). */
async function setHeld(api: ShopApi, ids: string[], held: boolean) {
  const reviews = (await Promise.all(ids.map((id) => getReview(api, id)))).filter((r): r is StoredReview => !!r);
  if (!held) return releaseEligibleReviews(api, { reviews });
  for (const r of reviews) await bumpStats(api.shopId, r, await updateReview(api, r, { held: true }));
  await recomputeProducts(api, reviews.map((r) => r.productId));
}
const reviewsOfProduct = async (api: ShopApi, shopifyProductId: bigint) => (await reviewsIn(api)).filter((r) => r.productId === shopifyProductId);
const list = async (domain: string, id: bigint, q: Record<string, string> = {}) =>
  (await proxyList(args<LoaderFunctionArgs>(proxyRequest(domain, `products/${id}/reviews`, q), { id: String(id) }))).json();
const productWebhook = (domain: string, topic: string, payload: unknown) =>
  run(() => productsWebhook(args<ActionFunctionArgs>(webhookRequest(domain, topic, "/webhooks/products", payload))));
const rowA = (id: bigint) => owner.product.findUnique({ where: { shopId_shopifyProductId: { shopId: A.shopId, shopifyProductId: id } } });

// ---------------------------------------------------------------------------------------------------------------
describe("Configuration: one API version, V1 scopes, product webhooks", () => {
  test("Admin API, codegen and webhooks all use the same API version (2026-10)", () => {
    assert.equal(API_VERSION, "2026-10");
    const toml = readFileSync("shopify.app.toml", "utf8");
    assert.match(toml, new RegExp(`^api_version = "${API_VERSION}"$`, "m"));
    assert.match(readFileSync("app/shopify.server.ts", "utf8"), /apiVersion: API_VERSION/);
    assert.match(readFileSync(".graphqlrc.ts", "utf8"), /apiVersion: API_VERSION/);
    assert.doesNotMatch(readFileSync("app/shopify.server.ts", "utf8") + readFileSync(".graphqlrc.ts", "utf8"), /ApiVersion\.\w+/);
  });
  test("products/create|update|delete subscribed with minimal fields; scopes unchanged", () => {
    const toml = readFileSync("shopify.app.toml", "utf8");
    assert.match(toml, /topics = \["products\/create", "products\/update", "products\/delete"\]\n\s+uri = "\/webhooks\/products"\n\s+include_fields = \["id", "handle", "title", "status", "updated_at"\]/);
    assert.match(toml, /^scopes = "read_products,write_products,read_metaobject_definitions,write_metaobject_definitions,read_metaobjects,write_metaobjects"$/m);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Initial catalogue sync", () => {
  const P = (n: number, status = "ACTIVE", updatedAt = "2026-09-01T00:00:00Z") =>
    ({ legacyResourceId: String(9_300_000_000_000 + n), handle: `Cat-${n}`, title: `Catalogue ${n}`, status, updatedAt });

  test("syncs every status (ACTIVE, DRAFT, ARCHIVED, UNLISTED), resumes after a failure, sweeps products Shopify no longer has", async () => {
    // A product Proofly knew about that is gone from Shopify, with a review that must survive.
    const gone = await asA((t) => product(t, 9_300_000_000_099n, "gone-product"));
    await asA((t) => review(t, gone.id, 5));
    const shopify = new FakeShopify();
    shopify.products = [P(1), P(2, "DRAFT"), P(3, "ARCHIVED"), P(4, "UNLISTED"), P(5)];
    // First run: the second page fails (connection reset).
    const first = new FakeShopify();
    first.products = shopify.products;
    let n = 0;
    const failingSecondPage = async (q: string, o?: { variables?: Record<string, unknown> }) => {
      if (/ProoflyProductsPage/.test(q) && ++n >= 2) throw new Error("connection reset");
      return first.graphql(q, o);
    };
    const r1 = await syncCatalog(A.shopId, failingSecondPage, { sleep: noSleep });
    assert.equal(r1.status, "failed");
    const s1 = await owner.shopSettings.findUniqueOrThrow({ where: { shopId: A.shopId } });
    assert.equal(s1.catalogSyncStatus, "failed");
    assert.equal(s1.catalogSyncCursor, "2"); // page 1 stored, cursor saved
    assert.equal(await owner.product.count({ where: { shopId: A.shopId, handle: { startsWith: "cat-" } } }), 2);

    // Resume: continues from the saved cursor (no restart), finishes, sweeps.
    const second = new FakeShopify();
    second.products = shopify.products;
    const r2 = await syncCatalog(A.shopId, second.graphql, { sleep: noSleep });
    assert.equal(r2.status, "completed");
    assert.equal(second.ops("ProoflyProductsPage")[0].variables!.after, "2");
    const rows = await owner.product.findMany({ where: { shopId: A.shopId, handle: { startsWith: "cat-" } }, orderBy: { shopifyProductId: "asc" } });
    assert.deepEqual(rows.map((r) => [r.handle, r.status]), [["cat-1", "active"], ["cat-2", "draft"], ["cat-3", "archived"], ["cat-4", "unlisted"], ["cat-5", "active"]]);
    // Sweep: not in Shopify → deleted, reviews kept. The fixture product (never seen either) is swept too.
    const goneRow = await owner.product.findUniqueOrThrow({ where: { id: gone.id } });
    assert.ok(goneRow.deletedAt);
    assert.equal((await reviewsOfProduct(A.api, goneRow.shopifyProductId)).length, 1);
    // Catalogue sync never touches rating metafields.
    assert.equal(second.calls.filter((c) => c.op !== "ProoflyProductsPage").length, 0);
    // Restore the fixture product for later tests (it exists in "Shopify" for the isolation suites).
    await owner.product.updateMany({ where: { shopId: A.shopId, shopifyProductId: SAME_PRODUCT_ID }, data: { deletedAt: null } });
  });

  test("throttling: THROTTLED responses are retried after waiting; only one run per shop at a time", async () => {
    const shopify = new FakeShopify();
    shopify.products = [P(1)];
    shopify.failNext("ProoflyProductsPage", "throttle", 2);
    const waits: number[] = [];
    const r = await syncCatalog(B.shopId, shopify.graphql, { sleep: async (ms) => { waits.push(ms); } });
    assert.equal(r.status, "completed");
    assert.equal(shopify.ops("ProoflyProductsPage").length, 3);
    assert.ok(waits.length >= 2);
    await owner.shopSettings.update({ where: { shopId: B.shopId }, data: { catalogSyncStatus: "running", catalogSyncStartedAt: new Date() } });
    assert.equal((await syncCatalog(B.shopId, shopify.graphql, { sleep: noSleep })).status, "skipped");
    await owner.shopSettings.update({ where: { shopId: B.shopId }, data: { catalogSyncStatus: "completed" } });
    await owner.product.updateMany({ where: { shopId: B.shopId, shopifyProductId: SAME_PRODUCT_ID }, data: { deletedAt: null } });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Product webhooks", () => {
  const ID = 9_400_000_000_001n;
  const payload = (o: Record<string, unknown> = {}) => ({ id: Number(ID), handle: "webhook-product", title: "Webhook Product", status: "active", updated_at: "2026-09-10T10:00:00Z", ...o });

  test("valid create, newer update, stale update ignored, duplicate delivery idempotent", async () => {
    assert.equal((await productWebhook(DOMAIN_A, "products/create", payload())).response?.status, 200);
    assert.equal((await rowA(ID))!.title, "Webhook Product");
    await productWebhook(DOMAIN_A, "products/update", payload({ title: "Renamed", status: "unlisted", updated_at: "2026-09-11T10:00:00Z" }));
    await productWebhook(DOMAIN_A, "products/update", payload({ title: "Old title", updated_at: "2026-09-10T12:00:00Z" })); // arrives late
    const row = (await rowA(ID))!;
    assert.equal(row.title, "Renamed");
    assert.equal(row.status, "unlisted");
    for (let i = 0; i < 2; i++) await productWebhook(DOMAIN_A, "products/update", payload({ title: "Renamed", status: "unlisted", updated_at: "2026-09-11T10:00:00Z" }));
    assert.equal(await owner.product.count({ where: { shopId: A.shopId, shopifyProductId: ID } }), 1);
  });

  test("invalid HMAC → rejected, nothing written", async () => {
    const req = webhookRequest(DOMAIN_A, "products/create", "/webhooks/products", payload({ id: 9_400_000_000_777 }));
    const forged = new Request(req.url, { method: "POST", body: JSON.stringify(payload({ id: 9_400_000_000_777 })), headers: { ...Object.fromEntries(req.headers), "x-shopify-hmac-sha256": "AAAA" } });
    const r = await run(() => productsWebhook(args<ActionFunctionArgs>(forged)));
    assert.ok(r.response && r.response.status >= 400);
    assert.equal(await owner.product.count({ where: { shopifyProductId: 9_400_000_000_777n } }), 0);
  });

  test("unknown shop, uninstalled shop and malformed payload → acknowledged (200), nothing written", async () => {
    assert.equal((await productWebhook(DOMAIN_C, "products/create", payload({ id: 9_400_000_000_002 }))).response?.status, 200);
    await installMerchant("proofly-test-gone.myshopify.com", "Gone");
    await markUninstalled("proofly-test-gone.myshopify.com");
    assert.equal((await productWebhook("proofly-test-gone.myshopify.com", "products/create", payload({ id: 9_400_000_000_003 }))).response?.status, 200);
    for (const bad of [{}, { id: "abc" }, payload({ id: 9_400_000_000_004, status: "weird" }), payload({ id: 9_400_000_000_004, updated_at: "not a date" }), payload({ id: 9_400_000_000_004, handle: 5 })]) {
      assert.equal((await productWebhook(DOMAIN_A, "products/update", bad)).response?.status, 200);
    }
    assert.equal(await owner.product.count({ where: { shopifyProductId: { in: [9_400_000_000_002n, 9_400_000_000_003n, 9_400_000_000_004n] } } }), 0);
  });

  test("cross-tenant attempt: a webhook signed for A naming B's product (and B's shop in the body) changes only A's catalogue", async () => {
    const before = await owner.product.findFirstOrThrow({ where: { shopId: B.shopId, shopifyProductId: SAME_PRODUCT_ID } });
    await productWebhook(DOMAIN_A, "products/update", { id: Number(SAME_PRODUCT_ID), handle: "hijack", title: "Hijack", status: "draft", updated_at: "2030-01-01T00:00:00Z", shop_id: B.shopId, domain: DOMAIN_B, myshopify_domain: DOMAIN_B });
    assert.deepEqual(await owner.product.findFirstOrThrow({ where: { shopId: B.shopId, shopifyProductId: SAME_PRODUCT_ID } }), before);
    assert.equal((await rowA(SAME_PRODUCT_ID))!.title, "Hijack"); // A's own product with that id
    await owner.product.updateMany({ where: { shopId: A.shopId, shopifyProductId: SAME_PRODUCT_ID }, data: { handle: SAME_HANDLE, title: "Fixture Product A", status: "active" } });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Canonical aggregation — every public review counts; held, pending and hidden never do", () => {
  const PID = 9_500_000_000_001n;
  let p: { id: string };
  const r: Record<string, Awaited<ReturnType<typeof review>>> = {};
  before(async () => {
    p = await asA((t) => product(t, PID, "agg-product"));
    await asA(async (t) => {
      r.five = await review(t, p.id, 5);
      r.four = await review(t, p.id, 4);
      r.three = await review(t, p.id, 3);
      r.planLimited = await review(t, p.id, 1, { hold: "plan_limit" });
      r.hidden = await review(t, p.id, 1, { status: "hidden" });
      r.pending = await review(t, p.id, 2, { status: "pending", hold: "moderation" });
      r.fourB = await review(t, p.id, 4);
      await recompute(t, p.id);
    });
  });

  test("aggregate and storefront: count/average/distribution over public reviews only", async () => {
    const row = (await rowA(PID))!;
    assert.deepEqual([row.reviewCount, Number(row.averageRating), [row.rating1, row.rating2, row.rating3, row.rating4, row.rating5]], [4, 4, [0, 0, 1, 2, 1]]);
    const body = await list(DOMAIN_A, PID, { summary: "1" });
    assert.deepEqual(body.reviews.map((x: { body: string }) => x.body).sort(), [r.five.body, r.four.body, r.three.body, r.fourB.body].sort());
    assert.deepEqual(body.summary, { count: 4, average: 4, distribution: [0, 0, 1, 2, 1] });
  });

  test("Shopify rating metafields follow the same aggregate", async () => {
    const shopify = new FakeShopify();
    await syncRatingCache(A.shopId, shopify.graphql, { productIds: [p.id], sleep: noSleep });
    assert.deepEqual(shopify.rating(PID), { average: "4.00", count: 4 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Rating-cache ownership, sync and reconciliation", () => {
  const P2 = 9_600_000_000_002n; // gets Proofly reviews later
  const P3 = 9_600_000_000_003n; // never gets Proofly reviews (another app's rating)
  const shopify = new FakeShopify();
  let p2: { id: string };
  let first: Awaited<ReturnType<typeof review>>;
  before(async () => {
    p2 = await asA((t) => product(t, P2, "owned-later"));
    await asA((t) => product(t, P3, "third-party"));
    shopify.setRating(P2, "4.80", 120); // another review app's values
    shopify.setRating(P3, "4.41", 68);
  });
  const gidsRead = () => shopify.ops("ProoflyReadRatings").flatMap((c) => c.variables!.ids as string[]);
  const gidsWritten = () => shopify.ops("ProoflySetRatings").flatMap((c) => (c.variables!.metafields as { ownerId: string }[]).map((m) => m.ownerId));

  test("1. product with a third-party rating and no Proofly reviews → untouched by sync AND reconciliation", async () => {
    await asA((t) => recompute(t, p2.id));
    assert.equal((await owner.product.findUniqueOrThrow({ where: { id: p2.id } })).ratingOwnership, "unmanaged");
    await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    const report = await reconcileRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.deepEqual(shopify.rating(P2), { average: "4.80", count: 120 });
    assert.deepEqual(shopify.rating(P3), { average: "4.41", count: 68 });
    for (const gid of [`gid://shopify/Product/${P2}`, `gid://shopify/Product/${P3}`]) {
      assert.ok(!gidsRead().includes(gid) && !gidsWritten().includes(gid));
    }
    assert.equal(shopify.ops("ProoflyDeleteRatings").length, 0);
    assert.ok(report.checked >= 0);
  });

  test("2. first public Proofly review → product becomes Proofly-managed and Proofly's rating is written", async () => {
    first = await asA((t) => review(t, p2.id, 5));
    await asA((t) => review(t, p2.id, 2, { status: "pending" })); // not public: never counted
    await asA((t) => recompute(t, p2.id));
    const row = await owner.product.findUniqueOrThrow({ where: { id: p2.id } });
    assert.equal(row.ratingOwnership, "proofly_managed");
    assert.ok(row.ratingManagedAt);
    const r = await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.ok(r.written >= 1);
    assert.deepEqual(shopify.rating(P2), { average: "5.00", count: 1 });
  });

  test("3. Proofly-managed rating updates on review changes; re-syncing an unchanged aggregate writes nothing", async () => {
    await asA(async (t) => { await review(t, p2.id, 3); await recompute(t, p2.id); });
    await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.deepEqual(shopify.rating(P2), { average: "4.00", count: 2 });
    const before = shopify.ops("ProoflySetRatings").length;
    await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.equal(shopify.ops("ProoflySetRatings").length, before); // idempotent: nothing dirty
  });

  test("moderation and plan limits change the aggregate through the same pathway", async () => {
    await moderate(A.api, [first.id], "hide", "test");
    await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.deepEqual(shopify.rating(P2), { average: "3.00", count: 1 });
    await moderate(A.api, [first.id], "approve", "test"); // restore → publish again
    const others = (await reviewsOfProduct(A.api, P2)).filter((x) => x.status === "published" && x.rating === 3);
    await setHeld(A.api, others.map((x) => x.id), true);
    await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.deepEqual(shopify.rating(P2), { average: "5.00", count: 1 });
    await setHeld(A.api, others.map((x) => x.id), false); // made publishable again
    await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.deepEqual(shopify.rating(P2), { average: "4.00", count: 2 });
  });

  test("a Proofly-managed product with no public reviews left: count 0 and Proofly's own rating removed", async () => {
    const ids = (await reviewsOfProduct(A.api, P2)).filter((x) => x.status === "published").map((x) => x.id);
    await moderate(A.api, ids, "hide", "test");
    await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.deepEqual(shopify.rating(P2), { average: null, count: 0 });
    await moderate(A.api, ids, "approve", "test");
    await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.deepEqual(shopify.rating(P2), { average: "4.00", count: 2 });
  });

  test("4. reconciliation repairs wrong, stale and missing Proofly-owned values — and never touches reviews", async () => {
    const reviewsBefore = await reviewsIn(A.api);
    const aggBefore = await owner.product.findUniqueOrThrow({ where: { id: p2.id } });
    shopify.setRating(P2, "4.39", 67); // drift (e.g. edited in Shopify, or a lost write)
    let report = await reconcileRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.equal(report.incorrect, 1);
    assert.equal(report.repaired, 1);
    assert.deepEqual(report.mismatches.find((m) => m.shopifyProductId === String(P2)), { shopifyProductId: String(P2), proofly: { count: 2, average: "4.00" }, shopify: { count: 67, average: "4.39" } });
    assert.deepEqual(shopify.rating(P2), { average: "4.00", count: 2 });
    shopify.setRating(P2, null, null); // missing
    report = await reconcileRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.equal(report.missing, 1);
    assert.deepEqual(shopify.rating(P2), { average: "4.00", count: 2 });
    report = await reconcileRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.equal(report.missing + report.incorrect, 0);
    assert.deepEqual(await reviewsIn(A.api), reviewsBefore); // entire entries, updatedAt included
    const aggAfter = await owner.product.findUniqueOrThrow({ where: { id: p2.id } });
    assert.deepEqual([aggAfter.reviewCount, Number(aggAfter.averageRating)], [aggBefore.reviewCount, Number(aggBefore.averageRating)]);
  });

  test("5. reconciliation ignores unmanaged products, whatever their Shopify values", async () => {
    shopify.setRating(P3, "1.00", 999);
    await reconcileRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.deepEqual(shopify.rating(P3), { average: "1.00", count: 999 });
    assert.ok(!gidsRead().includes(`gid://shopify/Product/${P3}`));
  });

  test("failed Shopify write: canonical data unchanged, product stays dirty with the error; a retry repairs it", async () => {
    await asA(async (t) => { await review(t, p2.id, 1); await recompute(t, p2.id); });
    const canonical = await owner.product.findUniqueOrThrow({ where: { id: p2.id } });
    shopify.failNext("ProoflySetRatings", "userError");
    const r1 = await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.equal(r1.failed, 1);
    const failed = await owner.product.findUniqueOrThrow({ where: { id: p2.id } });
    assert.ok(failed.ratingSyncError);
    assert.equal(failed.reviewCount, canonical.reviewCount); // canonical untouched
    assert.notEqual(failed.syncedCount, failed.reviewCount); // still dirty
    assert.deepEqual(shopify.rating(P2), { average: "4.00", count: 2 }); // Shopify stale, not corrupted
    shopify.failNext("ProoflySetRatings", "throw", 2); // transient: retried within the call
    shopify.failNext("ProoflySetRatings", "throttle", 1);
    const r2 = await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.deepEqual(r2, { written: 1, failed: 0 });
    assert.deepEqual(shopify.rating(P2), { average: "3.00", count: 3 });
    assert.equal((await owner.product.findUniqueOrThrow({ where: { id: p2.id } })).ratingSyncError, null);
  });

  test("6/7. deleting a product keeps its reviews and touches nothing in Shopify (own or third-party ratings)", async () => {
    const callsBefore = shopify.calls.length;
    const touches = (from: number, gid: string) => shopify.calls.slice(from).some((c) => JSON.stringify(c.variables ?? {}).includes(gid));
    const reviews = (await reviewsOfProduct(A.api, P2)).length;
    for (let i = 0; i < 2; i++) await productWebhook(DOMAIN_A, "products/delete", { id: Number(P2) }); // duplicate delivery
    await productWebhook(DOMAIN_A, "products/delete", { id: Number(P3) });
    const row = await owner.product.findUniqueOrThrow({ where: { id: p2.id } });
    assert.ok(row.deletedAt);
    assert.equal((await reviewsOfProduct(A.api, P2)).length, reviews);
    assert.equal(shopify.calls.length, callsBefore);
    const mark = shopify.calls.length;
    await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    await reconcileRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    // Deleted products are out of the sync/reconcile scope; the third-party product never was in it.
    assert.equal(touches(mark, `gid://shopify/Product/${P2}`), false);
    assert.equal(touches(mark, `gid://shopify/Product/${P3}`), false);
    assert.deepEqual(shopify.rating(P3), { average: "1.00", count: 999 }); // third-party rating survives
    // A late update for the deleted product does not resurrect it.
    await productWebhook(DOMAIN_A, "products/update", { id: Number(P2), handle: "owned-later", title: "Zombie", status: "active", updated_at: "2031-01-01T00:00:00Z" });
    assert.ok((await owner.product.findUniqueOrThrow({ where: { id: p2.id } })).deletedAt);
  });

  test("8. a recreated product (new Shopify id, same handle) does not inherit the old reviews", async () => {
    const NEW = 9_600_000_000_222n;
    await productWebhook(DOMAIN_A, "products/create", { id: Number(NEW), handle: "owned-later", title: "Owned later (new)", status: "active", updated_at: "2026-10-01T00:00:00Z" });
    const fresh = (await rowA(NEW))!;
    assert.notEqual(fresh.id, p2.id);
    assert.equal(fresh.ratingOwnership, "unmanaged");
    assert.equal((await reviewsOfProduct(A.api, NEW)).length, 0);
    assert.deepEqual(await asA((t) => ratingsByHandle(t, ["owned-later"])), {}); // handle no longer resolves to the old reviews
    assert.deepEqual((await list(DOMAIN_A, NEW, { summary: "1" })).summary.count, 0);
    assert.ok((await reviewsOfProduct(A.api, P2)).length); // old history kept on the deleted product
  });

  test("10. merchant A cannot read, sync, reconcile or change ownership of merchant B's ratings", async () => {
    const bp = await asB((t) => product(t, 9_600_000_000_900n, "b-owned"));
    await asB(async (t) => { await review(t, bp.id, 4); await recompute(t, bp.id); });
    const bShopify = new FakeShopify();
    await syncRatingCache(B.shopId, bShopify.graphql, { sleep: noSleep });
    const aShopify = new FakeShopify();
    await syncRatingCache(A.shopId, aShopify.graphql, { sleep: noSleep });
    await reconcileRatingCache(A.shopId, aShopify.graphql, { sleep: noSleep });
    const bGid = `gid://shopify/Product/${9_600_000_000_900n}`;
    assert.ok(!aShopify.calls.some((c) => JSON.stringify(c.variables ?? {}).includes(bGid)));
    // Through A's tenant context, B's product is invisible and unchangeable.
    assert.equal(await asA(({ db }) => db.product.count({ where: { id: bp.id } })), 0);
    assert.equal((await asA(({ db }) => db.product.updateMany({ where: { id: bp.id }, data: { ratingOwnership: "unmanaged", syncedCount: 0 } }))).count, 0);
    assert.equal((await recomputeProduct(A.api, 9_600_000_000_900n)).reviewCount, 0); // A's store has no reviews for B's product
    const b = await owner.product.findUniqueOrThrow({ where: { id: bp.id } });
    assert.deepEqual([b.ratingOwnership, b.reviewCount, b.syncedCount], ["proofly_managed", 1, 1]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Per-merchant app proxy path", () => {
  const B_PATH = "/community/reviews";
  before(async () => {
    assert.equal(await asB((t) => setProxyPath(t, "community/Reviews/", "test")), B_PATH);
    // Give B's copy of the shared product different numbers so any cross-tenant answer would be visible.
    await owner.product.updateMany({ where: { shopId: B.shopId, shopifyProductId: SAME_PRODUCT_ID }, data: { reviewCount: 7, averageRating: 3 } });
  });
  const ratingsVia = (domain: string, prefix: string) =>
    run(() => proxyRatings(args<LoaderFunctionArgs>(proxyRequest(domain, "ratings", { handles: SAME_HANDLE }, {}, prefix))));

  test("A uses the default path, B its own configured path; each reaches only its own data", async () => {
    const a = await ratingsVia(DOMAIN_A, DEFAULT_PROXY_PATH);
    const b = await ratingsVia(DOMAIN_B, B_PATH);
    assert.equal(a.response?.status ?? 200, 200);
    assert.equal(b.response?.status ?? 200, 200);
    assert.deepEqual(await a.response!.json(), { ratings: { [SAME_HANDLE]: [5, 1] } });
    assert.deepEqual(await b.response!.json(), { ratings: { [SAME_HANDLE]: [3, 7] } });
  });

  test("a merchant's requests are rejected on any other path — including the default and the other merchant's path", async () => {
    assert.equal((await ratingsVia(DOMAIN_A, B_PATH)).response?.status, 404);
    assert.equal((await ratingsVia(DOMAIN_B, DEFAULT_PROXY_PATH)).response?.status, 404); // no global fallback
    assert.equal((await ratingsVia(DOMAIN_B, "/apps/other")).response?.status, 404);
    // Changing the signed path_prefix after signing breaks the signature.
    const req = proxyRequest(DOMAIN_B, "ratings", { handles: SAME_HANDLE }, {}, B_PATH);
    const url = new URL(req.url);
    url.searchParams.set("path_prefix", DEFAULT_PROXY_PATH);
    const r = await run(() => proxyRatings(args<LoaderFunctionArgs>(new Request(url))));
    assert.ok(r.response && r.response.status >= 400 && r.response.status < 500);
  });

  test("each shop's path is explicit and validated; publishing writes only that shop's app metafield", async () => {
    for (const bad of ["", "/", "/apps", "/shop/x", "/apps/a b", "/apps/<x>", "apps/../admin", 5, null]) assert.equal(parseProxyPath(bad), null, String(bad));
    assert.equal(parseProxyPath("/a/Proofly-Reviews"), "/a/proofly-reviews");
    const settings = await owner.shopSettings.findMany({ where: { shopId: { in: [A.shopId, B.shopId] } }, orderBy: { shopId: "asc" } });
    for (const s of settings) assert.ok(s.proxyPath);
    const shopify = new FakeShopify();
    assert.equal(await publishShopProxyPath(B.shopId, shopify.graphql), true);
    assert.equal(shopify.metafields.get("gid://shopify/AppInstallation/1|proofly.proxy_path"), B_PATH);
    assert.equal(await publishShopProxyPath(B.shopId, shopify.graphql), false); // unchanged → no write
    assert.equal((await owner.shopSettings.findUniqueOrThrow({ where: { shopId: A.shopId } })).proxyPath, DEFAULT_PROXY_PATH);
  });

  test("the storefront takes the path from the app metafield; without it no request target is rendered", async () => {
    const product = liquidProduct({ id: 1, handle: "x", title: "X", average: 4, count: 2 });
    const custom = await renderBlock("reviews", { product, app: { metafields: { proofly: { proxy_path: { value: B_PATH } } } } });
    assert.match(custom, /data-api="\/community\/reviews"/);
    const none = await renderBlock("reviews", { product, app: null });
    assert.match(none, /data-api=""/);
    const cards = await renderBlock("card-ratings", { product: null, collection: null, search: { performed: false }, app: null });
    assert.match(cards, /data-api=""/);
  });

  test("no hard-coded proxy path anywhere in app or storefront code outside the configuration module", () => {
    const hits = execFileSync("git", ["grep", "--untracked", "-n", "apps/proofly", "--", "app", "extensions"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    assert.deepEqual([...new Set(hits.map((h) => h.split(":")[0]))], ["app/lib/proxy-path.server.ts"]);
  });
});
