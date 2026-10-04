// Phase 2: the storefront projection — an app-owned product metafield holding the summary and newest PUBLIC reviews,
// which the Review widget renders without a request to Proofly. Same visibility rules as the proxy, no private fields,
// replies only when entitled, capped below Shopify's JSON limit, right immediately despite search lag, retried on failure.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import { aggregateOf, recomputeProduct, retryStaleProjections } from "../app/lib/aggregates.server";
import { reconcileBilling } from "../app/lib/billing.server";
import { runMaintenance } from "../app/lib/maintenance.server";
import { moderate, saveReply } from "../app/lib/moderation.server";
import { buildProjection, PROJECTION_MAX_BYTES, PROJECTION_MAX_REVIEWS, PROJECTION_RETRY_AFTER_MS } from "../app/lib/projection.server";
import { ensureReviewDefinition, type StoredReview } from "../app/lib/review-store.server";
import { markUninstalled, upsertShopFromAuth, withTenant } from "../app/lib/tenant.server";
import { loader as proxyList } from "../app/routes/proxy.products.$id.reviews";
import { liquidProduct, renderBlock } from "../scripts/lib/extension-liquid";
import { args, DOMAIN_A, DOMAIN_B, installMerchant, owner, proxyRequest, resetDb, SAME_PRODUCT_ID, seedReview, storeOf, type Merchant } from "./helpers";

let A: Merchant, B: Merchant;
const PUBLIC_KEYS = ["body", "date", "name", "rating", "reply", "title", "verified"];
const setPlan = (m: Merchant, handle: string | null) => {
  const s = storeOf(m.domain); // the shop's own Shopify: billing and its reviews live in the same store
  s.subscriptions = handle ? [{ id: `gid://shopify/AppSubscription/${handle}`, name: handle, status: "ACTIVE", planHandle: handle }] : [];
  return reconcileBilling(m.shopId, s.graphql);
};
const productRow = (m: Merchant, id: bigint) => owner.product.findFirstOrThrow({ where: { shopId: m.shopId, shopifyProductId: id } });
const newProduct = (m: Merchant, id: bigint) =>
  withTenant(m.shopId, ({ db, shopId }) => db.product.create({ data: { shopId, shopifyProductId: id, handle: `p-${id}`, title: `P ${id}`, status: "active" } }));
const bodies = (m: Merchant, id: bigint) => storeOf(m.domain).projection(id)?.reviews.map((r) => r.body);

before(async () => {
  await resetDb();
  A = await installMerchant(DOMAIN_A, "A");
  B = await installMerchant(DOMAIN_B, "B");
  await setPlan(A, null);
  await setPlan(B, null);
});
after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

describe("Projection content", () => {
  const review = (i: number, o: Partial<StoredReview> = {}) => ({
    id: `gid://shopify/Metaobject/${i}`, handle: `r-${i}`, productId: 1n, status: "published", held: false, isPublic: true, rating: 5, title: `T${i}`, body: `B${i}`,
    reviewerName: "N", reviewDate: new Date(Date.UTC(2026, 0, 1)), source: "csv", sourceReviewId: `src-${i}`, reply: `secret reply ${i}`, replyDate: null,
    verified: false, flags: ["possible_duplicate"], imported: true, importJobId: "job-1", updatedAt: new Date(), editedOutside: false, ...o,
  }) as StoredReview;

  test("public allow-listed fields only; anything not public is skipped; summary and completeness", () => {
    const rows = [review(1), review(2, { isPublic: false, status: "pending", body: "pending body" }), review(3, { isPublic: false, held: true, body: "held body" })];
    const p = buildProjection(rows, aggregateOf(rows), { replies: false });
    assert.deepEqual(p.summary, { count: 1, average: 5, distribution: [0, 0, 0, 0, 1] });
    assert.equal(p.complete, true);
    assert.deepEqual(p.reviews.map((r) => r.body), ["B1"]);
    assert.deepEqual(Object.keys(p.reviews[0]).sort(), PUBLIC_KEYS);
    const json = JSON.stringify(p);
    for (const leak of ["gid://", "r-1", "src-1", "csv", "possible_duplicate", "job-1", "secret reply", "pending body", "held body"]) assert.ok(!json.includes(leak), leak);
    assert.equal(buildProjection(rows, aggregateOf(rows), { replies: true }).reviews[0].reply?.body, "secret reply 1");
  });

  test("capped below Shopify's 131,072-byte JSON limit and at the review cap; `complete` false when not all fit", () => {
    const big = Array.from({ length: 80 }, (_, i) => review(i, { body: "é".repeat(2500), reply: "ü".repeat(2500) })); // ~10 KB each
    const p = buildProjection(big, aggregateOf(big), { replies: true });
    assert.ok(Buffer.byteLength(JSON.stringify(p)) <= PROJECTION_MAX_BYTES && PROJECTION_MAX_BYTES < 131_072);
    assert.ok(p.reviews.length > 0 && p.reviews.length < 80);
    assert.equal(p.complete, false);
    assert.deepEqual(p.reviews.map((r) => r.title), big.slice(0, p.reviews.length).map((r) => r.title)); // newest kept, order kept
    const many = Array.from({ length: PROJECTION_MAX_REVIEWS + 5 }, (_, i) => review(i));
    const q = buildProjection(many, aggregateOf(many), { replies: false });
    assert.deepEqual([q.reviews.length, q.complete, q.summary.count], [PROJECTION_MAX_REVIEWS, false, PROJECTION_MAX_REVIEWS + 5]);
  });

  test("the projection definition is app-owned: merchants can read it, not edit it; re-running is harmless", async () => {
    const s = storeOf(DOMAIN_A);
    assert.deepEqual(s.metafieldDefinitions.get("$app:proofly.reviews"), {
      namespace: "$app:proofly", key: "reviews", type: "json", name: "Proofly reviews (storefront)", ownerType: "PRODUCT", access: { admin: "MERCHANT_READ", storefront: "PUBLIC_READ" },
    });
    await ensureReviewDefinition(A.api); // TAKEN → fine
  });
});

describe("Projection follows every change to public reviews", () => {
  const P = 9_600_000_000_001n;
  before(async () => { await newProduct(A, P); await newProduct(B, P); });

  test("approve → in the projection, in the same newest-first order as the proxy; hide → gone", async () => {
    const older = await seedReview(A.api, { productId: P, status: "pending", body: "older", reviewDate: new Date("2026-02-01T00:00:00Z") });
    const newer = await seedReview(A.api, { productId: P, status: "pending", body: "newer", rating: 3, reviewDate: new Date("2026-03-01T00:00:00Z") });
    assert.equal(storeOf(DOMAIN_A).projection(P), null); // nothing public yet: nothing published
    await moderate(A.api, [older.id, newer.id], "approve", "test");
    assert.deepEqual(bodies(A, P), ["newer", "older"]);
    assert.deepEqual(storeOf(DOMAIN_A).projection(P)!.summary, { count: 2, average: 4, distribution: [0, 0, 1, 0, 1] });
    const proxy = await (await proxyList(args<LoaderFunctionArgs>(proxyRequest(DOMAIN_A, `products/${P}/reviews`), { id: String(P) }))).json();
    assert.deepEqual(storeOf(DOMAIN_A).projection(P)!.reviews, proxy.reviews); // identical shape and order
    await moderate(A.api, [newer.id], "hide", "test");
    assert.deepEqual(bodies(A, P), ["older"]);
    await moderate(A.api, [older.id], "reject", "test");
    assert.deepEqual(storeOf(DOMAIN_A).projection(P), { summary: { count: 0, average: 0, distribution: [0, 0, 0, 0, 0] }, complete: true, reviews: [] });
    assert.equal(storeOf(DOMAIN_B).projection(P), null); // B's store never receives A's reviews
  });

  test("plan-limited (held) and edited-outside reviews never reach the projection", async () => {
    const held = await seedReview(A.api, { productId: P, status: "published", held: true, body: "held by plan" });
    const edited = await seedReview(A.api, { productId: P, status: "published", body: "will be edited" });
    await recomputeProduct(A.api, P);
    assert.deepEqual(bodies(A, P), ["will be edited"]);
    storeOf(DOMAIN_A).editOutside(edited.id, { body: "edited in Shopify admin" });
    await recomputeProduct(A.api, P);
    assert.deepEqual(bodies(A, P), []);
    assert.ok(!JSON.stringify(storeOf(DOMAIN_A).projection(P)).includes(held.body));
  });

  test("replies: saved reply appears only when the plan includes Replies; a downgrade republishes without it", async () => {
    const r = await seedReview(A.api, { productId: P, status: "published", body: "with reply" });
    await recomputeProduct(A.api, P);
    const reply = () => storeOf(DOMAIN_A).projection(P)!.reviews.find((x) => x.body === "with reply")!.reply;
    await saveReply(A.api, r.id, "Free reply", "test");
    assert.equal(reply(), null); // Free
    await setPlan(A, "starter");
    assert.equal(reply()?.body, "Free reply"); // the upgrade republished it
    await saveReply(A.api, r.id, "Thanks from A", "test");
    assert.deepEqual(reply(), { body: "Thanks from A", date: new Date().toISOString().slice(0, 10) }); // the save republished it
    await setPlan(A, null);
    assert.equal(reply(), null);
    assert.ok(!JSON.stringify(storeOf(DOMAIN_A).projection(P)).includes("Thanks from A"));
  });

  test("search lag: an approval is in the projection at once, though Shopify's search can't see it yet", async () => {
    const LAG = 9_600_000_000_002n;
    await newProduct(A, LAG);
    const store = storeOf(DOMAIN_A);
    const pending = await seedReview(A.api, { productId: LAG, status: "pending", body: "lagging approval" });
    store.searchLag = true;
    try {
      await moderate(A.api, [pending.id], "approve", "test");
      assert.deepEqual(bodies(A, LAG), ["lagging approval"]);
    } finally { store.searchLag = false; store.flushIndex(); }
  });

  test("a failed write never undoes the change; the product stays stale and is retried only once search has caught up", async () => {
    const F = 9_600_000_000_003n;
    await newProduct(A, F);
    const r = await seedReview(A.api, { productId: F, status: "pending", body: "hide me" });
    await moderate(A.api, [r.id], "approve", "test");
    assert.deepEqual(bodies(A, F), ["hide me"]);
    storeOf(DOMAIN_A).failNext("ProoflyPublishProjection", "userError");
    const [after] = await moderate(A.api, [r.id], "hide", "test");
    assert.equal(after.isPublic, false); // canonical change stands
    assert.deepEqual(bodies(A, F), ["hide me"]); // Shopify still holds the old projection…
    const staleSince = (await productRow(A, F)).projectionStaleSince!;
    assert.ok(staleSince); // …and Proofly knows it
    assert.equal(await retryStaleProjections(A.api, new Date(+staleSince + 1_000)), 0); // search may still lag: wait
    const report = await runMaintenance(new Date(+staleSince + PROJECTION_RETRY_AFTER_MS + 1_000), async (shopId) => (shopId === A.shopId ? A.api : null));
    assert.equal(report.projectionsRepublished, 1);
    assert.deepEqual(bodies(A, F), []);
    assert.equal((await productRow(A, F)).projectionStaleSince, null);
  });

  test("only products Proofly manages carry a projection (no write for products without Proofly reviews)", async () => {
    const U = 9_600_000_000_004n;
    await newProduct(A, U);
    await recomputeProduct(A.api, U);
    assert.equal(storeOf(DOMAIN_A).projection(U), null);
    assert.equal((await productRow(A, U)).projectionStaleSince, null);
  });
});

describe("Projections survive an uninstall/reinstall", () => {
  // Shopify deletes app-owned ($app) metafields on uninstall; Proofly republishes them after a reinstall.
  test("uninstall marks every managed product's projection stale; after reinstall maintenance republishes them", async () => {
    const R = 9_600_000_000_005n;
    await newProduct(A, R);
    const r = await seedReview(A.api, { productId: R, status: "pending", body: "survives reinstall" });
    await moderate(A.api, [r.id], "approve", "test");
    await markUninstalled(DOMAIN_A);
    storeOf(DOMAIN_A).uninstallApp();
    assert.equal(storeOf(DOMAIN_A).projection(R), null);
    assert.ok((await productRow(A, R)).projectionStaleSince);
    await upsertShopFromAuth(DOMAIN_A, storeOf(DOMAIN_A).graphql); // reinstall
    const report = await runMaintenance(new Date(), async (shopId) => (shopId === A.shopId ? A.api : null));
    assert.ok(report.projectionsRepublished >= 1);
    assert.deepEqual(bodies(A, R), ["survives reinstall"]);
  });
});

describe("Review widget renders from the projection (Liquid)", () => {
  const product = (projection: unknown, count = 1) => {
    const p = liquidProduct({ id: SAME_PRODUCT_ID, handle: "example-product", title: "Example Product", average: 5, count });
    return { ...p, metafields: { ...p.metafields, "$app:proofly": { reviews: { value: projection } } } };
  };
  const unescape = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  test("embedded as an HTML-escaped attribute: hostile review text cannot break out, and parses back exactly", async () => {
    const projection = { summary: { count: 1, average: 5, distribution: [0, 0, 0, 0, 1] }, complete: true, reviews: [{ rating: 5, title: "x", body: `"></section><script>alert(1)</script>' &amp;`, name: "N", date: "2026-01-01", verified: false, reply: null }] };
    const html = await renderBlock("reviews", { product: product(projection) });
    const attr = /data-initial="([^"]*)"/.exec(html)![1];
    assert.doesNotMatch(attr, /[<>"']/);
    assert.deepEqual(JSON.parse(unescape(attr)), projection);
    assert.doesNotMatch(html, /<script>alert/);
  });

  test("no projection (not yet published) or no reviews → no data-initial; the widget falls back to the proxy", async () => {
    assert.doesNotMatch(await renderBlock("reviews", { product: product(null) }), /data-initial/);
    assert.doesNotMatch(await renderBlock("reviews", { product: product({ summary: {}, reviews: [] }, 0) }), /data-initial/);
  });
});
