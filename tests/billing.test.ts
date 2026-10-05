// Checkpoint 5: plans, Shopify App Pricing reconciliation, entitlements, imports, upgrade/downgrade,
// fairness, security. Shopify is FakeShopify; tests/no-network.ts blocks any real network access.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import { decide as decideRaw, planSelectionUrl, reconcileBilling, reconcileIfStale } from "../app/lib/billing.server";
import {
  getPlanStatus, getUsage, releaseEligibleReviews, REVIEW_ADMISSION_ORDER,
} from "../app/lib/entitlements.server";
import { importReviews, type ImportRow } from "../app/lib/import.server";
import { moderate, reviewParam } from "../app/lib/moderation.server";
import { getReview } from "../app/lib/review-store.server";
import { annualSavingPercent, FEATURES, PLAN_ORDER, PLANS, planForHandle, planHasFeature, type PlanKey } from "../app/lib/plans";
import { withTenant, type Tenant } from "../app/lib/tenant.server";
import { afterAuth } from "../app/shopify.server";
import { action as planAction, loader as planLoader } from "../app/routes/app.plan";
import { loader as dashboardLoader } from "../app/routes/app._index";
import { action as reviewAction } from "../app/routes/app.reviews.$id";
import { adminRequest, apiOf, args, clearReviews, DOMAIN_A, DOMAIN_B, DOMAIN_C, FakeShopify, installMerchant, owner, resetDb, reviewsIn, run, seedReview, storeOf, type Merchant } from "./helpers";

let A: Merchant, B: Merchant;
before(async () => {
  await resetDb();
  A = await installMerchant(DOMAIN_A, "A");
  B = await installMerchant(DOMAIN_B, "B");
});
after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

const as = <T>(m: { shopId: string }, fn: (t: Tenant) => Promise<T>) => withTenant(m.shopId, fn);
const billing = (m: { shopId: string }) => owner.billingState.findUniqueOrThrow({ where: { shopId: m.shopId } });
const sub = (planHandle: string | null, o: Partial<FakeShopify["subscriptions"][number]> = {}) =>
  ({ id: `gid://shopify/AppSubscription/${planHandle ?? "x"}-${Math.random().toString(36).slice(2, 8)}`, name: planHandle ?? "?", status: "ACTIVE", planHandle, ...o });
const shopifyWith = (...subs: FakeShopify["subscriptions"]) => { const s = new FakeShopify(); s.subscriptions = subs; return s; };
async function setPlan(m: { shopId: string }, handle: string | null, o: Partial<FakeShopify["subscriptions"][number]> = {}) {
  return reconcileBilling(m.shopId, shopifyWith(...(handle ? [sub(handle, o)] : [])).graphql);
}
let seq = 0;
async function newProduct(m: { shopId: string }, id: bigint) {
  return as(m, ({ db, shopId }) => db.product.create({ data: { shopId, shopifyProductId: id, handle: `p-${id}`, title: `P ${id}`, status: "active" } }));
}
/** n reviews already public (grandfathered), dated before anything created later. */
async function publicReviews(m: Merchant, shopifyProductId: bigint, n: number) {
  for (let i = 0; i < n; i++) await seedReview(m.api, { productId: shopifyProductId, source: "seed", sourceReviewId: `seed-${++seq}`, body: `public ${i}`, reviewerName: "S", reviewDate: new Date(Date.UTC(2020, 0, 1, 0, 0, i)) });
}
const rows = (n: number, productId: bigint, o: { start?: number; rating?: (i: number) => number; body?: (i: number) => string } = {}): ImportRow[] =>
  Array.from({ length: n }, (_, i) => ({
    sourceReviewId: `r-${o.start ?? 0}-${i}`, shopifyProductId: productId, rating: o.rating?.(i) ?? 4, body: o.body?.(i) ?? `Imported review ${i}`,
    reviewerName: `Reviewer ${i}`, reviewDate: new Date(Date.UTC(2024, 0, 1) + ((o.start ?? 0) + i) * 3_600_000),
  }));

// ---------------------------------------------------------------------------------------------------------------
describe("Plans: one canonical configuration", () => {
  test("five plans with the final prices and allowances", () => {
    const table = PLAN_ORDER.map((k) => [k, PLANS[k].name, PLANS[k].monthlyPriceUsd, PLANS[k].annualPriceUsd, PLANS[k].publishedReviewAllowance]);
    assert.deepEqual(table, [
      ["FREE", "Free", 0, 0, 100],
      ["STARTER", "Starter", 9, 90, 1_000],
      ["GROWTH", "Growth", 19, 190, 5_000],
      ["PRO", "Pro", 39, 390, 25_000],
      ["SCALE", "Scale", 79, 790, 100_000],
    ]);
    assert.deepEqual(PLAN_ORDER.map((k) => annualSavingPercent(k)), [0, 17, 17, 17, 17]);
    assert.deepEqual(PLAN_ORDER.filter((k) => PLANS[k].mostPopular), ["GROWTH"]);
    assert.deepEqual(PLAN_ORDER.filter((k) => PLANS[k].isFree), ["FREE"]);
  });

  test("stable ids, handle mapping, and the configuration cannot be mutated at runtime", () => {
    assert.deepEqual(Object.keys(PLANS), ["FREE", "STARTER", "GROWTH", "PRO", "SCALE"]);
    for (const k of PLAN_ORDER) assert.equal(planForHandle(PLANS[k].shopifyPlanHandle), k);
    assert.equal(planForHandle(" GROWTH "), "GROWTH");
    for (const bad of ["19", "enterprise", "", null, undefined, "gid://shopify/AppSubscription/1"]) assert.equal(planForHandle(bad as string), null);
    assert.throws(() => { (PLANS.GROWTH as { monthlyPriceUsd: number }).monthlyPriceUsd = 1; });
    assert.throws(() => { (PLANS as Record<string, unknown>).FREE = {}; });
    assert.equal(PLANS.GROWTH.monthlyPriceUsd, 19);
  });

  test("features: replies from Starter; unreleased features (API, analytics, V1.1) are never available on any plan", () => {
    assert.deepEqual(PLAN_ORDER.map((k) => planHasFeature(k, "replies")), [false, true, true, true, true]);
    assert.deepEqual(PLAN_ORDER.map((k) => planHasFeature(k, "prioritySupport")), [false, false, true, true, true]);
    for (const f of ["apiAccess", "advancedAnalytics", "reviewRequests", "verifiedPurchase"] as const) {
      assert.equal(FEATURES[f].released, false);
      for (const k of PLAN_ORDER) assert.equal(planHasFeature(k, f), false, `${k} ${f}`);
    }
    assert.ok(PLANS.PRO.features.includes("apiAccess")); // reserved in the model, inert until released
  });

  test("no plan prices, allowances or names hard-coded outside the plan configuration", () => {
    const hits = execFileSync("git", ["grep", "--untracked", "-n", "-E", String.raw`\$(9|19|39|79|90|190|390|790)\b|\b(5_000|25_?000|100_?000)\b|"(Starter|Growth|Scale)"|\b(Starter|Growth|Scale) plan\b`, "--", "app", "extensions"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    assert.deepEqual([...new Set(hits.map((h) => h.split(":")[0]))], ["app/lib/plans.ts"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("New merchant starts on Free", () => {
  test("install with no Shopify subscription → Free confirmed: 100 reviews, zero reviews", async () => {
    const shopify = new FakeShopify({ myshopifyDomain: DOMAIN_C, id: 9_700_000_000_003n, name: "Store C", host: "store-c.example.com" });
    await afterAuth({ session: { shop: DOMAIN_C }, admin: shopify });
    const c = await owner.shop.findUniqueOrThrow({ where: { shopDomain: DOMAIN_C } });
    const s = await billing({ shopId: c.id });
    assert.deepEqual([s.plan, s.verification, s.shopifyStatus], ["FREE", "confirmed", "none"]);
    const st = await as({ shopId: c.id }, (t) => getPlanStatus(t));
    assert.equal(st.plan.publishedReviewAllowance, 100);
    assert.equal(st.usage.publishedReviews, 0);
    assert.deepEqual(await reviewsIn(apiOf(DOMAIN_C, c.id)), []);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Shopify App Pricing is authoritative", () => {
  test("decide(): only an ACTIVE subscription with a known plan handle grants a paid plan", () => {
    const decide = (active: ReturnType<typeof sub>[], recent: ReturnType<typeof sub>[]) => decideRaw(active.map(FakeShopify.subscriptionNode), recent.map(FakeShopify.subscriptionNode));
    assert.equal(decide([sub("growth")], []).kind === "confirmed" && decide([sub("growth")], []).plan, "GROWTH");
    assert.equal(decide([sub("enterprise")], []).kind, "unverified");
    assert.equal(decide([sub(null)], []).kind, "unverified");
    for (const status of ["PENDING", "DECLINED", "EXPIRED", "CANCELLED"]) {
      const d = decide([], [sub("scale", { status })]);
      assert.deepEqual(d.kind === "confirmed" && [d.plan, d.shopifyStatus], ["FREE", status.toLowerCase()]);
    }
    const frozen = decide([sub("pro", { status: "FROZEN" })], []);
    assert.deepEqual(frozen.kind === "confirmed" && [frozen.plan, frozen.shopifyStatus], ["FREE", "frozen"]);
  });

  test("upgrade is applied only from a verified Shopify subscription; monthly vs annual; audited once", async () => {
    const r = await setPlan(A, "growth", { interval: "ANNUAL", amount: "190.0" });
    assert.deepEqual([r.outcome, r.plan, r.changed], ["confirmed", "GROWTH", true]);
    const s = await billing(A);
    assert.deepEqual([s.plan, s.interval, s.shopifyStatus, s.verification], ["GROWTH", "annual", "active", "confirmed"]);
    const cached = await owner.subscription.findMany({ where: { shopId: A.shopId } });
    assert.equal(cached.length, 1);
    assert.equal(cached[0].plan, "GROWTH");
    assert.equal(String(cached[0].priceAmount), "190");
    const audits = await owner.auditLog.count({ where: { shopId: A.shopId, action: "billing.plan_upgraded" } });
    assert.equal(audits, 1);
  });

  test("duplicate/repeated reconciliation of the same state is harmless: no new audit rows, no duplicate cache rows", async () => {
    const shopify = shopifyWith(sub("starter"));
    for (let i = 0; i < 3; i++) await reconcileBilling(B.shopId, shopify.graphql);
    assert.equal((await billing(B)).plan, "STARTER");
    assert.equal(await owner.subscription.count({ where: { shopId: B.shopId } }), 1);
    assert.equal(await owner.auditLog.count({ where: { shopId: B.shopId, action: { startsWith: "billing." } } }), 2); // upgraded + subscription_active
  });

  test("billing API unavailable or unknown plan → unverified, plan kept (no downgrade, no upgrade), failure audited once", async () => {
    const before = await billing(A);
    for (const shopify of [(() => { const s = new FakeShopify(); s.failNext("ProoflySubscriptionState", "throw", 9); return s; })(), shopifyWith(sub("enterprise")), shopifyWith(sub(null))]) {
      const r = await reconcileBilling(A.shopId, shopify.graphql);
      assert.deepEqual([r.outcome, r.plan], ["unverified", "GROWTH"]);
    }
    const s = await billing(A);
    assert.deepEqual([s.plan, s.verification, s.interval], ["GROWTH", "unverified", before.interval]);
    assert.ok(s.checkError);
    assert.equal(await owner.auditLog.count({ where: { shopId: A.shopId, action: "billing.verification_failed" } }), 1);
    await setPlan(A, "growth"); // confirmed again
    assert.equal((await billing(A)).verification, "confirmed");
  });

  test("pending, declined and expired changes never upgrade; cancellation moves to Free (Shopify wins)", async () => {
    const m = await installMerchant("proofly-test-d.myshopify.com", "D");
    await reconcileBilling(m.shopId, shopifyWith(sub("scale", { status: "PENDING" })).graphql);
    assert.deepEqual([(await billing(m)).plan, (await billing(m)).shopifyStatus], ["FREE", "pending"]);
    await reconcileBilling(m.shopId, shopifyWith(sub("scale", { status: "DECLINED" })).graphql);
    assert.deepEqual([(await billing(m)).plan, (await billing(m)).shopifyStatus], ["FREE", "declined"]);
    await reconcileBilling(m.shopId, shopifyWith(sub("scale", { status: "EXPIRED" })).graphql);
    assert.deepEqual([(await billing(m)).plan, (await billing(m)).shopifyStatus], ["FREE", "expired"]);
    await setPlan(m, "pro");
    assert.equal((await billing(m)).plan, "PRO");
    await reconcileBilling(m.shopId, shopifyWith(sub("pro", { status: "CANCELLED" })).graphql);
    const s = await billing(m);
    assert.deepEqual([s.plan, s.shopifyStatus, s.interval], ["FREE", "cancelled", null]);
    assert.ok(await owner.auditLog.findFirst({ where: { shopId: m.shopId, action: "billing.plan_downgraded" } }));
    assert.ok(await owner.auditLog.findFirst({ where: { shopId: m.shopId, action: "billing.subscription_cancelled" } }));
  });

  test("stale state is re-checked; fresh state is not (no routine polling)", async () => {
    const shopify = shopifyWith(sub("growth"));
    assert.equal(await reconcileIfStale(A.shopId, shopify.graphql), null);
    assert.equal(shopify.calls.length, 0);
    await owner.billingState.update({ where: { shopId: A.shopId }, data: { verifiedAt: new Date(Date.now() - 3_600_000) } });
    assert.equal((await reconcileIfStale(A.shopId, shopify.graphql))?.outcome, "confirmed");
    assert.equal(shopify.calls.length, 1);
  });

  test("Shopify's hosted plan page is the only place to change plans", () => {
    assert.equal(planSelectionUrl("proofly-test-a.myshopify.com"), "https://admin.shopify.com/store/proofly-test-a/charges/proofly-test/pricing_plans");
    const toml = readFileSync("shopify.app.toml", "utf8");
    assert.doesNotMatch(toml, /app_subscriptions/); // App Pricing sends no subscription webhooks (since 2026-04-28)
    assert.doesNotMatch(readFileSync("app/lib/billing.server.ts", "utf8"), /appSubscriptionCreate|appSubscriptionCancel/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Billing security: client input never decides the plan", () => {
  test("plan, price, interval, shop or subscription ids in the request are ignored by the Plan page", async () => {
    // Shopify (A's own store) says Growth. Whatever the request asks for, Shopify's answer is the plan.
    storeOf(DOMAIN_A).subscriptions = [{ id: "gid://shopify/AppSubscription/g", name: "Growth", status: "ACTIVE", planHandle: "growth" }];
    const before = await billing(A);
    assert.equal(before.plan, "GROWTH");
    for (const intent of ["refresh", "select", "upgrade", "activate"]) {
      const fd = new FormData();
      for (const [k, v] of Object.entries({ intent, plan: "SCALE", plan_handle: "scale", price: "0", interval: "annual", shopId: B.shopId, subscription_id: "gid://shopify/AppSubscription/1" })) fd.set(k, v);
      await run(() => planAction(args<ActionFunctionArgs>(adminRequest(DOMAIN_A, "/app/plan", { method: "POST", body: fd }))));
    }
    // A Shopify redirect back with ?plan_handle=scale triggers a re-check, it never grants Scale.
    const r = await run(() => planLoader(args<LoaderFunctionArgs>(adminRequest(DOMAIN_A, "/app/plan?plan_handle=scale&shop=" + DOMAIN_B))));
    assert.ok(r.data);
    const after = await billing(A);
    assert.equal(after.plan, "GROWTH"); // re-checked with Shopify: never Scale, never anything the request named
    assert.equal(after.verification, "confirmed");
    assert.equal((await billing(B)).plan, "STARTER");
    await setPlan(A, "growth");
  });

  test("merchant A cannot read or change merchant B's billing state or subscriptions", async () => {
    assert.equal(await as(A, ({ db }) => db.billingState.count({ where: { shopId: B.shopId } })), 0);
    assert.equal(await as(A, ({ db }) => db.subscription.count({ where: { shopId: B.shopId } })), 0);
    assert.equal((await as(A, ({ db }) => db.billingState.updateMany({ where: { shopId: B.shopId }, data: { plan: "SCALE" } }))).count, 0);
    await assert.rejects(as(A, ({ db }) => db.subscription.create({ data: { shopId: B.shopId, shopifySubscriptionId: "x", name: "x", status: "active", shopifyCreatedAt: new Date() } })));
    // Reconciling A with Shopify data never touches B.
    await reconcileBilling(A.shopId, shopifyWith(sub("scale")).graphql);
    assert.equal((await billing(B)).plan, "STARTER");
    await setPlan(A, "growth");
  });

  test("same subscription id, plan and counts in two shops do not collide", async () => {
    const shared = sub("starter", { id: "gid://shopify/AppSubscription/777" });
    await reconcileBilling(A.shopId, shopifyWith(shared).graphql);
    await reconcileBilling(B.shopId, shopifyWith(shared).graphql);
    assert.equal(await owner.subscription.count({ where: { shopifySubscriptionId: "gid://shopify/AppSubscription/777" } }), 2);
    await setPlan(A, "growth");
  });

  test("the storefront never touches billing: no billing code on storefront paths or in the extension", () => {
    for (const f of ["app/routes/proxy.reviews.tsx", "app/routes/proxy.ratings.tsx", "app/routes/proxy.products.$id.reviews.tsx", "app/lib/proxy.server.ts", "app/lib/submit.server.ts"]) {
      assert.doesNotMatch(readFileSync(f, "utf8"), /billing\.server/, f);
    }
    const r = spawnSync("git", ["grep", "--untracked", "-il", "-E", "billing|subscription", "--", "extensions"], { encoding: "utf8" });
    assert.equal(r.stdout.trim(), ""); // exit 1 = no match
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Imports: never truncated; excess is plan-limited, oldest first", () => {
  const PID = 9_700_000_000_100n;
  let shop: Merchant;
  before(async () => {
    shop = await installMerchant("proofly-test-e.myshopify.com", "E"); // Free (100)
    await newProduct(shop, PID);
  });

  test("below the limit: everything published", async () => {
    const r = await importReviews(shop.api, { source: "csv", rows: rows(40, PID), actor: "test" });
    assert.deepEqual([r.imported, r.published, r.planLimited], [40, 40, 0]);
  });

  test("exactly at the limit, then above it: stored in full, the excess held — nothing deleted", async () => {
    // The fixture review from installMerchant is public too: 41 used, 59 left.
    const atLimit = await importReviews(shop.api, { source: "csv", rows: rows(59, PID, { start: 1000 }), actor: "test" });
    assert.deepEqual([atLimit.imported, atLimit.published, atLimit.planLimited], [59, 59, 0]);
    assert.equal((await as(shop, (t) => getUsage(t))).publishedReviews, 100);
    const over = await importReviews(shop.api, { source: "csv", rows: rows(30, PID, { start: 2000 }), actor: "test" });
    assert.deepEqual([over.imported, over.published, over.planLimited], [30, 0, 30]);
    assert.equal((await reviewsIn(shop.api)).length, 130);
    const job = await owner.importJob.findFirstOrThrow({ where: { shopId: shop.shopId }, orderBy: { createdAt: "desc" } });
    assert.equal((job.counts as { planLimited: number }).planLimited, 30);
  });

  test("re-running the same import is idempotent; unmatched products and invalid rows are reported, not stored", async () => {
    const r = await importReviews(shop.api, {
      source: "csv", actor: "test",
      rows: [...rows(5, PID, { start: 2000 }), ...rows(2, 9_999_999_999_999n, { start: 3000 }), { ...rows(1, PID, { start: 4000 })[0], rating: 9 }],
    });
    assert.deepEqual([r.imported, r.duplicates, r.unmatchedProduct, r.invalid], [0, 5, 2, 1]);
  });

  test("Free merchant importing 1,000 reviews: 1,000 stored, 100 published (the oldest), 900 plan-limited", async () => {
    const m = await installMerchant("proofly-test-f.myshopify.com", "F");
    await clearReviews(m); // start from zero public reviews
    await newProduct(m, PID);
    // Adversarial data: the OLDEST reviews are 1★ and negative, the newest 5★ and glowing.
    const input = rows(1000, PID, { rating: (i) => (i < 500 ? 1 : 5), body: (i) => (i < 500 ? `Terrible, broke at once ${i}` : `Wonderful, love it ${i}`) });
    const r = await importReviews(m.api, { source: "legacy-provider", rows: [...input].reverse(), actor: "test" });
    assert.deepEqual([r.received, r.imported, r.published, r.planLimited, r.notPublished], [1000, 1000, 100, 900, 0]);
    const all = await reviewsIn(m.api);
    assert.equal(all.length, 1000);
    const published = all.filter((r) => r.isPublic);
    assert.deepEqual(new Set(published.map((p) => p.sourceReviewId)), new Set(input.slice(0, 100).map((x) => x.sourceReviewId))); // date order, nothing else
    assert.ok(published.every((p) => p.rating === 1));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Fairness: date order only (regression guards)", () => {
  test("admission orderings are chronological and use no quality signal", () => {
    // Review date, then the stable handle (a hash of source + source review id) — deterministic, never a quality signal.
    assert.deepEqual([...REVIEW_ADMISSION_ORDER], ["reviewDate", "handle"]);
    const banned = /rating|sentiment|body|title|reviewerName|verified|images|photo|product|flags|helpful|score|createdAt/i;
    for (const o of REVIEW_ADMISSION_ORDER) assert.doesNotMatch(JSON.stringify(o), banned);
  });

  test("every allowance decision in the entitlement layer uses that ordering", () => {
    const src = readFileSync("app/lib/entitlements.server.ts", "utf8");
    const sorts = src.match(/\.sort\([^)]*\)/g) ?? [];
    assert.deepEqual(sorts, [".sort(byAdmissionOrder)"]); // the only ordering applied to candidates
    assert.match(src, /scanReviews\(api, \{ status: "published", held: true[^\n]*\{ oldestFirst: true \}\)/); // read oldest first
    // and the store's oldest-first order IS that ordering: the display name is "review date | handle"
    assert.match(readFileSync("app/lib/review-store.server.ts", "utf8"), /sort_key: `\$\{atSecond\(r\.reviewDate\)\}\|\$\{handle\}`/);
  });

  test("high ratings never jump the queue when publishing eligible reviews", async () => {
    const m = await installMerchant("proofly-test-g.myshopify.com", "G");
    await clearReviews(m);
    const P = 9_700_000_000_200n;
    await newProduct(m, P);
    await publicReviews(m, P, 99); // 1 slot left
    await seedReview(m.api, { productId: P, source: "x", sourceReviewId: "newer-5star", rating: 5, body: "great", reviewerName: "x", reviewDate: new Date("2023-06-01"), held: true, verified: true });
    await seedReview(m.api, { productId: P, source: "x", sourceReviewId: "older-1star", rating: 1, body: "bad", reviewerName: "x", reviewDate: new Date("2023-01-01"), held: true });
    const r = await releaseEligibleReviews(m.api);
    assert.deepEqual([r.released, r.stillHeld], [1, 1]);
    const released = (await reviewsIn(m.api)).filter((x) => x.source === "x" && x.isPublic);
    assert.deepEqual(released.map((x) => x.sourceReviewId), ["older-1star"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Upgrade and downgrade", () => {
  let m: Merchant;
  before(async () => {
    m = await installMerchant("proofly-test-h.myshopify.com", "H");
    await clearReviews(m);
    await newProduct(m, 9_700_000_000_300n);
    await setPlan(m, null); // Free, confirmed
    await importReviews(m.api, { source: "csv", rows: rows(150, 9_700_000_000_300n), actor: "test" }); // 100 public, 50 held
  });

  test("upgrade: allowance grows only after Shopify confirms; held reviews do NOT auto-publish; 'Publish eligible reviews' does", async () => {
    let st = await as(m, (t) => getPlanStatus(t));
    assert.deepEqual([st.plan.key, st.usage.publishedReviews, st.usage.planLimitedReviews], ["FREE", 100, 50]);
    await setPlan(m, "starter");
    st = await as(m, (t) => getPlanStatus(t));
    assert.deepEqual([st.plan.key, st.usage.publishedReviews, st.usage.planLimitedReviews, st.reviewRoom], ["STARTER", 100, 50, 900]);
    const fd = new FormData();
    fd.set("intent", "publish_eligible");
    // Through the real Plan page action (as merchant H):
    await owner.billingState.update({ where: { shopId: m.shopId }, data: { verifiedAt: new Date() } });
    const res = await run(() => planAction(args<ActionFunctionArgs>(adminRequest("proofly-test-h.myshopify.com", "/app/plan", { method: "POST", body: fd }))));
    assert.match((res.data as { message: string }).message, /Published 50 reviews/);
    st = await as(m, (t) => getPlanStatus(t));
    assert.deepEqual([st.usage.publishedReviews, st.usage.planLimitedReviews], [150, 0]);
  });

  test("downgrade: published reviews stay visible (grandfathered); only new ones are limited; nothing deleted", async () => {
    // Downgrade to Free (150 published > 100 allowance).
    await reconcileBilling(m.shopId, shopifyWith(sub("starter", { status: "CANCELLED" })).graphql);
    let st = await as(m, (t) => getPlanStatus(t));
    assert.deepEqual([st.plan.key, st.usage.publishedReviews, st.overReviewAllowance, st.reviewRoom], ["FREE", 150, true, 0]);
    // Future imports and approvals are held; nothing becomes hidden, nothing is deleted.
    const imp = await importReviews(m.api, { source: "csv", rows: rows(10, 9_700_000_000_300n, { start: 5000 }), actor: "test" });
    assert.deepEqual([imp.imported, imp.published, imp.planLimited], [10, 0, 10]);
    const pending = await seedReview(m.api, { productId: 9_700_000_000_300n, source: "storefront", sourceReviewId: "sf-1", rating: 5, body: "new", reviewerName: "N", reviewDate: new Date(), status: "pending" });
    await moderate(m.api, [pending.id], "approve", "test");
    const approved = (await getReview(m.api, pending.id))!;
    assert.deepEqual([approved.status, approved.held], ["published", true]); // approved, held — never rejected
    st = await as(m, (t) => getPlanStatus(t));
    assert.equal(st.usage.publishedReviews, 150);
    assert.equal((await reviewsIn(m.api)).length, 161);
  });

  test("approval with no room → admin message 'Approved, but currently held by your plan limit.'", async () => {
    const r = await seedReview(m.api, { productId: 9_700_000_000_300n, source: "storefront", sourceReviewId: "sf-2", rating: 4, body: "new", reviewerName: "N", reviewDate: new Date(), status: "pending" });
    await owner.billingState.update({ where: { shopId: m.shopId }, data: { verifiedAt: new Date() } });
    const fd = new FormData();
    fd.set("intent", "approve");
    const res = await run(() => reviewAction(args<ActionFunctionArgs>(adminRequest("proofly-test-h.myshopify.com", `/app/reviews/${reviewParam(r.id)}`, { method: "POST", body: fd }), { id: reviewParam(r.id) })));
    assert.match((res.data as { message: string }).message, /Approved, but currently held by your plan limit/);
  });

  test("dashboard shows published / allowance / plan-limited / awaiting moderation and a non-destructive warning", async () => {
    const res = await run(() => dashboardLoader(args<LoaderFunctionArgs>(adminRequest("proofly-test-h.myshopify.com", "/app"))));
    const plan = (res.data as { plan: { published: number; allowance: number; planLimited: number; awaiting: number; over: boolean } }).plan;
    assert.deepEqual([plan.published, plan.allowance, plan.planLimited, plan.over], [150, 100, 12, true]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Every plan's allowances are what the entitlement layer enforces", () => {
  for (const k of PLAN_ORDER) {
    test(`${k}`, async () => {
      await reconcileBilling(B.shopId, shopifyWith(...(k === "FREE" ? [] : [sub(PLANS[k].shopifyPlanHandle)])).graphql);
      const st = await as(B, (t) => getPlanStatus(t));
      assert.equal(st.plan.key, k as PlanKey);
      assert.equal(st.reviewRoom, Math.max(0, PLANS[k].publishedReviewAllowance - st.usage.publishedReviews));
    });
  }
});
