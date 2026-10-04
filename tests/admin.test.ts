// Checkpoint 7: merchant review management — bulk moderation, settings enforced on the storefront, products page,
// shared rate limits. Offline; FakeShopify; network guard.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import { reconcileBilling } from "../app/lib/billing.server";
import { rateLimit } from "../app/lib/http.server";
import { reviewParam } from "../app/lib/moderation.server";
import { getReview } from "../app/lib/review-store.server";
import { publishStorefrontSettings } from "../app/lib/tenant.server";
import { loader as productsLoader } from "../app/routes/app.products";
import { action as bulkAction, loader as reviewsLoader } from "../app/routes/app.reviews._index";
import { action as settingsAction, loader as settingsLoader } from "../app/routes/app.settings";
import { action as proxySubmit } from "../app/routes/proxy.reviews";
import { liquidProduct, renderBlock } from "../scripts/lib/extension-liquid";
import { adminRequest, args, FakeShopify, installMerchant, owner, proxyRequest, resetDb, reviewsIn, run, SAME_PRODUCT_ID, seedReview, storefrontHost, type Merchant } from "./helpers";

let A: Merchant, B: Merchant;
before(async () => {
  await resetDb();
  A = await installMerchant("proofly-test-ma.myshopify.com", "MA");
  B = await installMerchant("proofly-test-mb.myshopify.com", "MB");
  await reconcileBilling(A.shopId, new FakeShopify().graphql); // Free, confirmed
});
after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

const post = (m: Merchant, path: string, fields: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) fd.append(k, x);
  return adminRequest(m.domain, path, { method: "POST", body: fd });
};
/** n pending reviews in the shop's store; returns their admin ids (the numeric part of the metaobject id). */
const pending = async (m: Merchant, n: number, tag: string) => {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(reviewParam((await seedReview(m.api, { productId: SAME_PRODUCT_ID, source: "storefront", sourceReviewId: `${tag}-${i}`, rating: 4, body: `${tag} ${i}`, reviewerName: "R", reviewDate: new Date(Date.UTC(2025, 0, 1, i)), status: "pending" })).id));
  return ids;
};
const byParam = async (m: Merchant, ids: string[]) => (await reviewsIn(m.api)).filter((r) => ids.includes(reviewParam(r.id)));
const submit = async (m: Merchant, label: string, fields: Record<string, string | Blob> = {}, ip = "198.51.100.20") => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ product_id: String(SAME_PRODUCT_ID), rating: "5", body: "Fictional submission.", name: "Sam Example", ...fields })) fd.set(k, v);
  return proxySubmit(args<ActionFunctionArgs>(proxyRequest(m.domain, "reviews", {}, { method: "POST", body: fd, headers: { Origin: `https://${storefrontHost(label)}`, "x-forwarded-for": ip } })));
};

describe("Bulk moderation", () => {
  test("approves the shop's own selected reviews; another shop's ids are ignored; status changes audited", async () => {
    const mine = await pending(A, 3, "bulk-a");
    const theirs = await pending(B, 2, "bulk-b");
    const res = await run(() => bulkAction(args<ActionFunctionArgs>(post(A, "/app/reviews", { intent: "approve", ids: [...mine, ...theirs, "not-a-uuid"] }))));
    assert.match((res.data as { message: string }).message, /^3 reviews approved\./);
    assert.equal((await byParam(A, mine)).filter((r) => r.isPublic).length, 3);
    assert.equal((await byParam(B, theirs)).filter((r) => r.status === "pending").length, 2);
    assert.equal(await owner.auditLog.count({ where: { entity: "review", entityId: { in: theirs.map((x) => `gid://shopify/Metaobject/${x}`) }, action: { startsWith: "review." } } }), 0);
    assert.equal(await owner.auditLog.count({ where: { shopId: A.shopId, action: "review.approve", entityId: { in: mine.map((x) => `gid://shopify/Metaobject/${x}`) } } }), 3);
  });

  test("approval beyond the plan allowance keeps reviews approved but held, and says so; hide / restore work in bulk", async () => {
    // Free = 100. Fill to 99 public, then approve 3: 1 published, 2 held (oldest first).
    const pub = (await reviewsIn(A.api)).filter((r) => r.isPublic).length;
    for (let i = 0; i < 99 - pub; i++) await seedReview(A.api, { productId: SAME_PRODUCT_ID, source: "seed", sourceReviewId: `fill-${i}`, body: "x", reviewerName: "x", reviewDate: new Date("2020-01-01") });
    const ids = await pending(A, 3, "over");
    const res = await run(() => bulkAction(args<ActionFunctionArgs>(post(A, "/app/reviews", { intent: "approve", ids }))));
    assert.match((res.data as { message: string }).message, /3 reviews approved\. 2 approved but currently held by your plan limit/);
    const held = await run(() => reviewsLoader(args<LoaderFunctionArgs>(adminRequest(A.domain, "/app/reviews?held=yes"))));
    assert.equal((held.data as { rows: { held: boolean }[] }).rows.filter((r) => r.held).length, 2);
    const hide = await run(() => bulkAction(args<ActionFunctionArgs>(post(A, "/app/reviews", { intent: "hide", ids: ids.slice(0, 1) }))));
    assert.match((hide.data as { message: string }).message, /1 review hidden/);
    const restore = await run(() => bulkAction(args<ActionFunctionArgs>(post(A, "/app/reviews", { intent: "restore", ids: ids.slice(0, 1) }))));
    assert.match((restore.data as { message: string }).message, /returned to pending/);
  });

  test("unknown intents and empty selections do nothing", async () => {
    for (const fields of [{ intent: "delete", ids: [reviewParam(A.reviewId)] }, { intent: "approve" }] as Record<string, string | string[]>[]) {
      const res = await run(() => bulkAction(args<ActionFunctionArgs>(post(A, "/app/reviews", fields))));
      assert.match((res.data as { message: string }).message, /Choose an action|Select at least one/);
    }
    assert.ok(await getReview(A.api, A.reviewId));
  });
});

describe("Settings are enforced on the storefront", () => {
  test("submissions off → refused (403) and nothing stored; on → accepted", async () => {
    await run(() => settingsAction(args<ActionFunctionArgs>(post(B, "/app/settings", { intent: "settings", moderationEnabled: "on" }))));
    const s = await run(() => settingsLoader(args<LoaderFunctionArgs>(adminRequest(B.domain, "/app/settings"))));
    assert.equal((s.data as { reviewSubmissionEnabled: boolean }).reviewSubmissionEnabled, false);
    const before = (await reviewsIn(B.api)).length;
    const res = await submit(B, "MB");
    assert.equal(res.status, 403);
    assert.equal((await reviewsIn(B.api)).length, before);
    await run(() => settingsAction(args<ActionFunctionArgs>(post(B, "/app/settings", { intent: "settings", reviewSubmissionEnabled: "on", moderationEnabled: "on" }))));
    assert.equal((await submit(B, "MB", {}, "198.51.100.21")).status, 201);
  });

  test("approval off → new submissions publish immediately within the allowance", async () => {
    await run(() => settingsAction(args<ActionFunctionArgs>(post(B, "/app/settings", { intent: "settings", reviewSubmissionEnabled: "on" }))));
    assert.equal((await submit(B, "MB", { body: "Auto-published fictional review." }, "198.51.100.24")).status, 201);
    const r = (await reviewsIn(B.api)).find((x) => x.body === "Auto-published fictional review.")!;
    assert.deepEqual([r.status, r.held, r.isPublic], ["published", false, true]);
  });

  test("settings changes are per shop and ignore tenant fields; the theme mirror follows the saved settings", async () => {
    const aBefore = await owner.shopSettings.findUniqueOrThrow({ where: { shopId: A.shopId } });
    await run(() => settingsAction(args<ActionFunctionArgs>(post(B, "/app/settings", { intent: "settings", shopId: A.shopId, shop_id: A.shopId, moderationEnabled: "on" }))));
    assert.deepEqual(await owner.shopSettings.findUniqueOrThrow({ where: { shopId: A.shopId } }), aBefore);
    const shopify = new FakeShopify();
    await publishStorefrontSettings(B.shopId, shopify.graphql);
    assert.deepEqual(JSON.parse(shopify.metafields.get("gid://shopify/AppInstallation/1|proofly.storefront")!), { submissions: false });
    const product = liquidProduct({ id: 1, handle: "x", title: "X", average: 4, count: 2 });
    const off = await renderBlock("reviews", { product, app: { metafields: { proofly: { proxy_path: { value: "/apps/proofly" }, storefront: { value: { submissions: false } } } } } });
    assert.doesNotMatch(off, /data-write/);
    assert.match(await renderBlock("reviews", { product }), /data-write/); // mirror missing → defaults on (server still enforces)
    await run(() => settingsAction(args<ActionFunctionArgs>(post(B, "/app/settings", { intent: "settings", reviewSubmissionEnabled: "on", moderationEnabled: "on" }))));
    assert.ok(await owner.auditLog.findFirst({ where: { shopId: B.shopId, action: "settings.updated" } }));
  });
});

describe("Products page and shared rate limits", () => {
  test("lists only this shop's catalogue with public counts and rating ownership; deleted products shown separately", async () => {
    await owner.product.create({ data: { shopId: A.shopId, shopifyProductId: 9_860_000_000_001n, handle: "deleted-example", title: "Deleted Example", deletedAt: new Date() } });
    const res = await run(() => productsLoader(args<LoaderFunctionArgs>(adminRequest(A.domain, "/app/products"))));
    const rows = (res.data as { rows: { title: string; deleted: boolean }[] }).rows;
    assert.ok(rows.every((r) => !r.deleted) && rows.some((r) => r.title === "Fixture Product MA"));
    assert.ok(!JSON.stringify(rows).includes("Fixture Product MB"));
    const del = await run(() => productsLoader(args<LoaderFunctionArgs>(adminRequest(A.domain, "/app/products?show=deleted"))));
    assert.deepEqual((del.data as { rows: { title: string }[] }).rows.map((r) => r.title), ["Deleted Example"]);
  });

  test("rate limits are shared through Postgres (not per process) and scoped by key", async () => {
    const key = `test:${Date.now()}`;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rateLimit(key, 3, 60_000));
    assert.deepEqual(results, [true, true, true, false]);
    assert.equal(await rateLimit(`${key}:other`, 3, 60_000), true);
    const stored = await owner.rateLimit.findMany({ where: {} });
    assert.ok(stored.every((r) => /^[0-9a-f]{64}$/.test(r.key))); // hashed, no shop or IP in clear
  });
});
