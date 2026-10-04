// Checkpoint 6 decision: replies are retained regardless of plan; PUBLIC reply visibility is feature-gated by the
// shop's current plan (entitlements `can(t, "replies")`), decided server-side. Data retention always wins.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import { reconcileBilling } from "../app/lib/billing.server";
import { serializeReview } from "../app/lib/reviews.server";
import { getReview } from "../app/lib/review-store.server";
import { loader as proxyList } from "../app/routes/proxy.products.$id.reviews";
import { args, DOMAIN_A, DOMAIN_B, FakeShopify, installMerchant, owner, proxyRequest, resetDb, reviewsIn, SAME_PRODUCT_ID, seedReview, type Merchant } from "./helpers";

let A: Merchant, B: Merchant;
const setPlan = (m: Merchant, handle: string | null) => {
  const s = new FakeShopify();
  if (handle) s.subscriptions = [{ id: `gid://shopify/AppSubscription/${handle}`, name: handle, status: "ACTIVE", planHandle: handle }];
  return reconcileBilling(m.shopId, s.graphql);
};
const list = async (domain: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  (await proxyList(args<LoaderFunctionArgs>(proxyRequest(domain, `products/${SAME_PRODUCT_ID}/reviews`, extra, { headers }), { id: String(SAME_PRODUCT_ID) }))).json() as Promise<{ reviews: { body: string; reply: { body: string } | null }[] }>;
/** The stored replies of a shop (in its Shopify store), with the review they belong to. */
const replyRows = async (m: Merchant) => (await reviewsIn(m.api)).filter((r) => r.reply).map((r) => ({ id: r.id, reply: r.reply, replyDate: r.replyDate }));

before(async () => {
  await resetDb();
  A = await installMerchant(DOMAIN_A, "A"); // each has one public review with a stored reply ("Reply from store X")
  B = await installMerchant(DOMAIN_B, "B");
  await setPlan(A, null); // Free
  await setPlan(B, null);
});
after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

describe("Reply visibility follows the Replies entitlement; replies are never lost", () => {
  test("Free: review public, reply stored, response carries no reply (as if there were none)", async () => {
    const body = await list(DOMAIN_A);
    assert.equal(body.reviews.length, 1);
    assert.equal(body.reviews[0].reply, null);
    assert.ok(!JSON.stringify(body).includes("Reply from store A"));
    assert.equal((await replyRows(A)).length, 1); // retained
  });

  test("Starter+: the reply is included", async () => {
    await setPlan(A, "starter");
    assert.equal((await list(DOMAIN_A)).reviews[0].reply?.body, "Reply from store A");
  });

  test("downgrade hides it without deleting; upgrade restores it without re-import; repeating changes nothing", async () => {
    const before = await replyRows(A);
    for (let i = 0; i < 3; i++) {
      await setPlan(A, null);
      const free = await list(DOMAIN_A);
      assert.equal(free.reviews.length, 1); // the review itself stays visible
      assert.equal(free.reviews[0].reply, null);
      await setPlan(A, "growth");
      assert.equal((await list(DOMAIN_A)).reviews[0].reply?.body, "Reply from store A");
    }
    assert.deepEqual(await replyRows(A), before); // same single row, untouched
  });

  test("hidden reply privacy: no reply body, metadata, entitlement state or ids in the JSON", async () => {
    await setPlan(A, null);
    const text = JSON.stringify(await list(DOMAIN_A));
    const [row] = await replyRows(A);
    for (const s of ["Reply from store A", row.id, "replies", "plan", "entitle", "FREE", "hold", "suppressed"]) assert.ok(!text.includes(s), s);
  });

  test("plan spoofing: query parameters (even signed) and headers cannot reveal the reply", async () => {
    const body = await list(DOMAIN_A, { plan: "STARTER", replies: "1", plan_handle: "scale" }, { "x-proofly-plan": "SCALE", cookie: "plan=PRO" });
    assert.equal(body.reviews[0].reply, null);
  });

  test("tenant isolation: A's entitlement never exposes B's reply; B's request never uses A's plan", async () => {
    await setPlan(A, "pro");
    const a = JSON.stringify(await list(DOMAIN_A));
    assert.ok(a.includes("Reply from store A") && !a.includes("Reply from store B"));
    const b = await list(DOMAIN_B); // B stays on Free
    assert.equal(b.reviews[0].reply, null);
    assert.ok(!JSON.stringify(b).includes("Reply from store"));
  });

  test("the entitlement never bypasses review visibility: held, hidden and rejected reviews stay out, with their replies", async () => {
    await setPlan(A, "pro");
    for (const [status, held, tag] of [["published", true, "held"], ["hidden", false, "hidden"], ["rejected", false, "rejected"], ["pending", false, "pending"]] as const) {
      await seedReview(A.api, { productId: SAME_PRODUCT_ID, sourceReviewId: `vis-${tag}`, body: `body ${tag}`, reviewerName: "X", reviewDate: new Date("2025-01-01"), status, held, reply: `secret reply ${tag}` });
    }
    const text = JSON.stringify(await list(DOMAIN_A));
    for (const tag of ["held", "hidden", "rejected", "pending"]) assert.ok(!text.includes(`secret reply ${tag}`) && !text.includes(`body ${tag}`), tag);
  });

  test("guard: the serializer itself omits a stored reply when not entitled, and the storefront route asks the entitlement layer", async () => {
    const r = (await getReview(A.api, A.reviewId))!;
    assert.ok(r.reply);
    assert.equal(serializeReview(r, { replies: false }).reply, null);
    assert.equal(serializeReview(r, { replies: true }).reply?.body, "Reply from store A");
    assert.match(readFileSync("app/routes/proxy.products.$id.reviews.tsx", "utf8"), /replies: await can\(t, "replies"\)/);
  });
});
