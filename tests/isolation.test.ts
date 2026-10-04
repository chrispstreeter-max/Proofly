// Tenant isolation: the 10 required cases, at library level and through the real route handlers
// (real Shopify session-token validation and real app-proxy HMAC verification).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import { moderate, moderationHistory, reviewParam, saveReply } from "../app/lib/moderation.server";
import { getReview } from "../app/lib/review-store.server";
import { listReviews, parseListParams, ratingsByHandle } from "../app/lib/reviews.server";
import { markUninstalled, withTenant } from "../app/lib/tenant.server";
import { action as reviewAction, loader as reviewLoader } from "../app/routes/app.reviews.$id";
import { loader as reviewsListLoader } from "../app/routes/app.reviews._index";
import { loader as dashboardLoader } from "../app/routes/app._index";
import { loader as proxyRatings } from "../app/routes/proxy.ratings";
import { loader as proxyList } from "../app/routes/proxy.products.$id.reviews";
import { action as uninstalledWebhook } from "../app/routes/webhooks.app.uninstalled";
import { action as proxySubmit } from "../app/routes/proxy.reviews";
import {
  adminRequest, args, DOMAIN_A, DOMAIN_B, installMerchant, owner, proxyRequest, resetDb, reviewsIn, run, SAME_HANDLE, SAME_PRODUCT_ID, seedReview, storefrontHost, type Merchant,
} from "./helpers";

let A: Merchant, B: Merchant;
before(async () => {
  await resetDb();
  A = await installMerchant(DOMAIN_A, "A");
  B = await installMerchant(DOMAIN_B, "B");
});
after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

const asA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(A.shopId, fn);
const reviewB = async () => (await getReview(B.api, B.reviewId))!; // read through B's own store
const idB = () => reviewParam(B.reviewId);

describe("1. Merchant A cannot read Merchant B's review", () => {
  test("library: lookup by B's id through A's store returns nothing (Shopify-native: A's API reaches only A's data)", async () => {
    assert.equal(await getReview(A.api, B.reviewId), null);
    assert.ok(await getReview(B.api, B.reviewId)); // it exists — in B's store
    assert.deepEqual((await reviewsIn(A.api)).map((r) => r.id), [A.reviewId]);
  });
  test("admin: A's review detail request for B's review → 404", async () => {
    const r = await run(() => reviewLoader(args<LoaderFunctionArgs>(adminRequest(DOMAIN_A, `/app/reviews/${idB()}`), { id: idB() })));
    assert.equal(r.response?.status, 404);
  });
  test("admin: A's review list never contains B's reviews", async () => {
    const r = await run(() => reviewsListLoader(args<LoaderFunctionArgs>(adminRequest(DOMAIN_A, "/app/reviews"))));
    const ids = (r.data as { rows: { id: string }[] }).rows.map((x) => x.id);
    assert.deepEqual(ids, [reviewParam(A.reviewId)]);
  });
  test("admin: A's dashboard counts only A's data", async () => {
    const r = await run(() => dashboardLoader(args<LoaderFunctionArgs>(adminRequest(DOMAIN_A, "/app"))));
    assert.equal((r.data as { stats: { total: number } }).stats.total, 1);
  });
});

describe("2. Merchant A cannot modify Merchant B's review", () => {
  test("library: moderation and replies on B's review are no-ops", async () => {
    assert.deepEqual(await moderate(A.api, [B.reviewId], "hide", "test"), []);
    assert.equal(await saveReply(A.api, B.reviewId, "overwritten by A", "test"), false);
    const b = await reviewB();
    assert.equal(b.status, "published");
    assert.equal(b.reply, "Reply from store B");
  });
  test("admin: A's moderate / reply actions on B's review → 404, B unchanged", async () => {
    for (const intent of ["hide", "reject", "reply"]) {
      const body = new URLSearchParams({ intent, reply: "x" });
      const r = await run(() => reviewAction(args<ActionFunctionArgs>(adminRequest(DOMAIN_A, `/app/reviews/${idB()}`, { method: "POST", body }), { id: idB() })));
      assert.equal(r.response?.status, 404, intent);
    }
    const b = await reviewB();
    assert.equal(b.status, "published");
    assert.equal(b.reply, "Reply from store B");
  });
});

describe("3. Merchant A cannot read Merchant B's reviews or stored files", () => {
  test("storefront: A's product list for B's product never returns B's reviews", async () => {
    const bOnly = 9_000_000_000_778n; // a product only B has reviews for
    await seedReview(B.api, { productId: bOnly, body: "B-only review" });
    const res = await listReviews(A.api, bOnly, parseListParams(new URL("http://x/?page=1")), { replies: true });
    assert.deepEqual(res.reviews, []);
    // and A's list for the Shopify product id both shops share holds only A's review
    const shared = await listReviews(A.api, SAME_PRODUCT_ID, parseListParams(new URL("http://x/?page=1")), { replies: true });
    assert.deepEqual(shared.reviews.map((r) => r.body), [A.reviewBody]);
  });
  test("stored import files (CSV in the database) are row-level isolated per shop", async () => {
    await owner.importFile.createMany({ data: [A, B].map((m) => ({ shopId: m.shopId, importJobId: m.importJobId, data: new Uint8Array(Buffer.from(`csv of ${m.shopId}`)) })), skipDuplicates: true });
    const seenByA = await withTenant(A.shopId, ({ db }) => db.importFile.findMany({ select: { shopId: true } })); // no shop filter: RLS alone
    assert.deepEqual([...new Set(seenByA.map((f) => f.shopId))], [A.shopId]);
    await assert.rejects(withTenant(A.shopId, ({ db }) => db.importFile.create({ data: { shopId: B.shopId, importJobId: B.importJobId, data: new Uint8Array(1) } })));
  });
});

describe("4. Merchant A cannot access Merchant B's settings", () => {
  test("library: B's settings row is invisible; A's own is visible", async () => {
    assert.equal(await asA(({ db }) => db.shopSettings.findUnique({ where: { shopId: B.shopId } })), null);
    assert.ok(await asA(({ db }) => db.shopSettings.findUnique({ where: { shopId: A.shopId } })));
  });
  test("library: A cannot update B's settings", async () => {
    const n = await asA(({ db }) => db.shopSettings.updateMany({ where: { shopId: B.shopId }, data: { widgetEnabled: false } }));
    assert.equal(n.count, 0);
    assert.equal((await owner.shopSettings.findUniqueOrThrow({ where: { shopId: B.shopId } })).widgetEnabled, true);
  });
});

describe("5. Merchant A cannot access Merchant B's import jobs", () => {
  test("library: B's import job is invisible and cannot be changed", async () => {
    assert.equal(await asA(({ db }) => db.importJob.findFirst({ where: { id: B.importJobId } })), null);
    assert.equal((await asA(({ db }) => db.importJob.updateMany({ where: { id: B.importJobId }, data: { status: "failed" } }))).count, 0);
    assert.equal((await owner.importJob.findUniqueOrThrow({ where: { id: B.importJobId } })).status, "finished");
  });
});

describe("6. Merchant A cannot access Merchant B's moderation records", () => {
  test("library: B's moderation history is empty from A's context", async () => {
    assert.deepEqual(await asA((t) => moderationHistory(t, B.reviewId)), []);
    assert.equal(await asA(({ db }) => db.auditLog.findFirst({ where: { entityId: B.reviewId } })), null); // RLS alone
    assert.equal((await withTenant(B.shopId, (t) => moderationHistory(t, B.reviewId))).length, 1);
  });
});

describe("7. Missing resources and other-shop resources get the same safe response", () => {
  test("admin review detail: B's id and a random id → identical 404", async () => {
    const other = await run(() => reviewLoader(args<LoaderFunctionArgs>(adminRequest(DOMAIN_A, `/app/reviews/${idB()}`), { id: idB() })));
    const missing = "999999999999";
    const none = await run(() => reviewLoader(args<LoaderFunctionArgs>(adminRequest(DOMAIN_A, `/app/reviews/${missing}`), { id: missing })));
    assert.equal(other.response?.status, 404);
    assert.equal(none.response?.status, 404);
    assert.equal(await other.response!.text(), await none.response!.text());
  });
  test("storefront: ratings for another shop's product equal ratings for an unknown one", async () => {
    // Shop B's product exists under the SAME Shopify id in shop A, so use a shop-B-only id for the check:
    const bOnly = 9_000_000_000_777n;
    await withTenant(B.shopId, ({ db, shopId }) => db.product.create({ data: { shopId, shopifyProductId: bOnly, handle: "b-only", title: "B only", reviewCount: 3, averageRating: 4 } }));
    const other = await (await proxyRatings(args<LoaderFunctionArgs>(proxyRequest(DOMAIN_A, "ratings", { handles: "b-only" })))).json();
    const unknown = await (await proxyRatings(args<LoaderFunctionArgs>(proxyRequest(DOMAIN_A, "ratings", { handles: "no-such-product" })))).json();
    assert.deepEqual(other, { ratings: {} });
    assert.deepEqual(other, unknown);
    const list = await (await proxyList(args<LoaderFunctionArgs>(proxyRequest(DOMAIN_A, `products/${bOnly}/reviews`, { summary: "1" }), { id: String(bOnly) }))).json();
    const listUnknown = await (await proxyList(args<LoaderFunctionArgs>(proxyRequest(DOMAIN_A, "products/9000000000999/reviews", { summary: "1" }), { id: "9000000000999" }))).json();
    assert.deepEqual(list, listUnknown);
  });
});

describe("8. No client-supplied tenant id can override the authenticated shop", () => {
  test("storefront: same Shopify product id resolves to each shop's own data", async () => {
    const a = await (await proxyRatings(args<LoaderFunctionArgs>(proxyRequest(DOMAIN_A, "ratings", { handles: SAME_HANDLE })))).json();
    const listA = await (await proxyList(args<LoaderFunctionArgs>(proxyRequest(DOMAIN_A, `products/${SAME_PRODUCT_ID}/reviews`), { id: String(SAME_PRODUCT_ID) }))).json();
    assert.deepEqual(a, { ratings: { [SAME_HANDLE]: [5, 1] } });
    assert.deepEqual(listA.reviews.map((r: { body: string }) => r.body), [A.reviewBody]);
  });
  test("storefront: extra shop/tenant params (even signed) are ignored", async () => {
    const res = await proxyList(args<LoaderFunctionArgs>(proxyRequest(DOMAIN_A, `products/${SAME_PRODUCT_ID}/reviews`, { shop_id: B.shopId, shopId: B.shopId, tenant: B.shopId }), { id: String(SAME_PRODUCT_ID) }));
    assert.deepEqual((await res.json()).reviews.map((r: { body: string }) => r.body), [A.reviewBody]);
  });
  test("storefront: changing the signed `shop` parameter breaks the signature → rejected", async () => {
    const req = proxyRequest(DOMAIN_A, "ratings", { handles: SAME_HANDLE });
    const url = new URL(req.url);
    url.searchParams.set("shop", DOMAIN_B);
    const r = await run(() => proxyRatings(args<LoaderFunctionArgs>(new Request(url))));
    assert.ok(r.response && r.response.status >= 400 && r.response.status < 500, `status ${r.response?.status}`);
  });
  test("admin: shop/tenant ids in query or body are ignored", async () => {
    const r = await run(() => reviewsListLoader(args<LoaderFunctionArgs>(adminRequest(DOMAIN_A, `/app/reviews?shop=${DOMAIN_B}&shopId=${B.shopId}&shop_id=${B.shopId}`))));
    assert.deepEqual((r.data as { rows: { id: string }[] }).rows.map((x) => x.id), [reviewParam(A.reviewId)]);
    const body = new URLSearchParams({ intent: "hide", shopId: B.shopId, shop: DOMAIN_B });
    const act = await run(() => reviewAction(args<ActionFunctionArgs>(adminRequest(DOMAIN_A, `/app/reviews/${idB()}`, { method: "POST", body }), { id: idB() })));
    assert.equal(act.response?.status, 404);
  });
  test("database: a row claiming another shop is rejected inside a tenant transaction", async () => {
    await assert.rejects(withTenant(A.shopId, ({ db }) => db.auditLog.create({ data: { shopId: B.shopId, actor: "x", action: "x", entity: "x" } })));
  });
});

describe("9. Unauthenticated requests cannot access merchant data", () => {
  test("admin: no session token → no data (auth response thrown)", async () => {
    const r = await run(() => reviewsListLoader(args<LoaderFunctionArgs>(new Request(`${process.env.SHOPIFY_APP_URL}/app/reviews`, { headers: { Authorization: "Bearer not-a-token" } }))));
    assert.ok(r.response, "expected an auth Response");
    assert.ok(!r.data);
    assert.ok(r.response!.status >= 300, `status ${r.response!.status}`);
  });
  test("admin: a token signed with the wrong secret is rejected", async () => {
    const good = adminRequest(DOMAIN_A, "/app/reviews").headers.get("Authorization")!;
    const forged = good.slice(0, good.lastIndexOf(".") + 1) + "A".repeat(43);
    const r = await run(() => reviewsListLoader(args<LoaderFunctionArgs>(new Request(`${process.env.SHOPIFY_APP_URL}/app/reviews`, { headers: { Authorization: forged } }))));
    assert.ok(r.response && !r.data);
  });
  test("storefront: unsigned proxy request → rejected", async () => {
    const r = await run(() => proxyRatings(args<LoaderFunctionArgs>(new Request(`${process.env.SHOPIFY_APP_URL}/proxy/ratings?handles=${SAME_HANDLE}&shop=${DOMAIN_A}`))));
    assert.ok(r.response && r.response.status >= 400 && r.response.status < 500);
  });
  test("webhook without Shopify HMAC → rejected and no tenant change", async () => {
    const r = await run(() => uninstalledWebhook(args<ActionFunctionArgs>(new Request(`${process.env.SHOPIFY_APP_URL}/webhooks/app/uninstalled`, {
      method: "POST", body: "{}", headers: { "X-Shopify-Shop-Domain": DOMAIN_B, "X-Shopify-Topic": "app/uninstalled", "Content-Type": "application/json" },
    }))));
    assert.ok(r.response && r.response.status >= 400);
    assert.equal((await owner.shop.findUniqueOrThrow({ where: { id: B.shopId } })).uninstalledAt, null);
  });
  test("uninstalled shop: storefront serves nothing (404), data retained", async () => {
    const gone = await installMerchant("proofly-test-gone.myshopify.com", "Gone");
    await markUninstalled("proofly-test-gone.myshopify.com");
    const r = await run(() => proxyRatings(args<LoaderFunctionArgs>(proxyRequest("proofly-test-gone.myshopify.com", "ratings", { handles: SAME_HANDLE }))));
    assert.equal(r.response?.status, 404);
    assert.equal((await reviewsIn(gone.api)).length, 1); // the merchant's reviews stay in its own store
  });
});

describe("10. Production build contains no merchant data", () => {
  test("merchant-data scan passes on the repository and production build", { skip: !existsSync("build/server/index.js") && "run `npm run build` first" }, () => {
    const out = execFileSync("npx", ["tsx", "scripts/scan-merchant-data.ts"], { encoding: "utf8" });
    assert.match(out, /PASS — no merchant\/customer data found/);
  });
});

describe("Tenant-scoped writes from the storefront", () => {
  const submit = (origin: string) => {
    const fd = new FormData();
    fd.set("product_id", String(SAME_PRODUCT_ID)); fd.set("rating", "4"); fd.set("title", "Write test"); fd.set("body", "Fictional storefront submission."); fd.set("name", "Sky Example");
    return proxySubmit(args<ActionFunctionArgs>(proxyRequest(DOMAIN_A, "reviews", {}, { method: "POST", body: fd, headers: { Origin: origin, "x-forwarded-for": "198.51.100.7" } })));
  };
  test("a submission signed for shop A from A's storefront lands only in shop A, pending", async () => {
    const res = await submit(`https://${storefrontHost("A")}`);
    assert.equal(res.status, 201);
    const inA = (await reviewsIn(A.api)).filter((r) => r.title === "Write test");
    assert.equal(inA.length, 1);
    assert.equal(inA[0].status, "pending");
    assert.equal(inA[0].productId, SAME_PRODUCT_ID);
    assert.deepEqual((await reviewsIn(B.api)).filter((r) => r.title === "Write test"), []);
  });
  test("a submission for shop A whose Origin is shop B's storefront is rejected", async () => {
    const res = await submit(`https://${storefrontHost("B")}`);
    assert.equal(res.status, 403);
  });
  test("outside development there is no shared/global fallback origin", async () => {
    process.env.STOREFRONT_ORIGINS = "https://evil.example.com";
    const res = await submit("https://evil.example.com");
    assert.equal(res.status, 403);
  });
});

describe("Library: storefront aggregate reads are shop-scoped", () => {
  test("ratingsByHandle with the shared handle returns each shop's own aggregate", async () => {
    const a = await withTenant(A.shopId, (t) => ratingsByHandle(t, [SAME_HANDLE]));
    await withTenant(B.shopId, ({ db, shopId }) => db.product.updateMany({ where: { shopId, shopifyProductId: SAME_PRODUCT_ID }, data: { reviewCount: 7, averageRating: 3 } }));
    const b = await withTenant(B.shopId, (t) => ratingsByHandle(t, [SAME_HANDLE]));
    assert.deepEqual(a, { [SAME_HANDLE]: [5, 1] });
    assert.deepEqual(b, { [SAME_HANDLE]: [3, 7] });
  });
});
