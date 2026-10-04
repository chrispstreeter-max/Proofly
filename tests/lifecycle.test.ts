// Checkpoint 2: install → authenticate → onboard → uninstall → reinstall, and removal of the manual login flow.
// Install/reinstall run the app's real afterAuth hook (what Shopify-managed installation + token exchange invoke);
// only the network calls (token exchange itself, the Admin API `shop` query) are stood in for.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import * as shopifyServer from "../app/shopify.server";
import { afterAuth } from "../app/shopify.server";
import { activeShopByDomain, withTenant } from "../app/lib/tenant.server";
import { action as dashboardAction, loader as dashboardLoader } from "../app/routes/app._index";
import { loader as reviewsListLoader } from "../app/routes/app.reviews._index";
import { loader as landingLoader } from "../app/routes/_index/route";
import { loader as proxyList } from "../app/routes/proxy.products.$id.reviews";
import { loader as proxyRatings } from "../app/routes/proxy.ratings";
import { action as proxySubmit } from "../app/routes/proxy.reviews";
import { action as uninstalledWebhook } from "../app/routes/webhooks.app.uninstalled";
import {
  adminRequest, args, DOMAIN_A, DOMAIN_C, fakeAdmin, installMerchant, owner, proxyRequest, resetDb, run, SAME_HANDLE, SAME_PRODUCT_ID,
  storeOfflineSession, webhookRequest, type Merchant,
} from "./helpers";

const C_IDENTITY = { myshopifyDomain: DOMAIN_C, id: 9_200_000_000_003n, name: "Fixture Store C", host: "store-c.example.com" };
const TENANT_TABLES = ["product", "review", "reviewImage", "reviewReply", "reviewRequest", "moderationAction", "importJob", "subscription"] as const;

let A: Merchant;
before(async () => {
  await resetDb();
  A = await installMerchant(DOMAIN_A, "A");
});
after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

const install = (identity = C_IDENTITY) => afterAuth({ session: { shop: DOMAIN_C }, admin: fakeAdmin(identity) });
const shopC = () => owner.shop.findUniqueOrThrow({ where: { shopDomain: DOMAIN_C } });
const audit = async (shopId: string) => (await owner.auditLog.findMany({ where: { shopId }, orderBy: { createdAt: "asc" } })).map((a) => a.action);

/** Everything merchant A owns, so we can prove C's lifecycle never changes it. */
async function snapshotA() {
  const where = { shopId: A.shopId };
  return {
    shop: await owner.shop.findUniqueOrThrow({ where: { id: A.shopId } }),
    settings: await owner.shopSettings.findUniqueOrThrow({ where }),
    reviews: await owner.review.findMany({ where, orderBy: { id: "asc" } }),
    images: await owner.reviewImage.findMany({ where }),
    replies: await owner.reviewReply.findMany({ where }),
    jobs: await owner.importJob.findMany({ where }),
    moderation: await owner.moderationAction.findMany({ where }),
    sessions: await owner.session.findMany({ where: { shop: DOMAIN_A } }),
  };
}
const dashboard = async (domain: string) => {
  const r = await run(() => dashboardLoader(args<LoaderFunctionArgs>(adminRequest(domain, "/app"))));
  return r.data as { stats: { total: number; pending: number }; onboarding: { done: boolean; reviewsBlockUrl: string } };
};
const submitC = (body: string) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ product_id: String(SAME_PRODUCT_ID), rating: "4", body, name: "Casey Example" })) fd.set(k, v);
  return proxySubmit(args<ActionFunctionArgs>(proxyRequest(DOMAIN_C, "reviews", {}, {
    method: "POST", body: fd, headers: { Origin: `https://${C_IDENTITY.host}`, "x-forwarded-for": "198.51.100.7" },
  })));
};

describe("Install: a newly installed merchant starts with an empty tenant", () => {
  test("a mismatched Admin API identity is refused and creates nothing (cannot hijack another shop's tenant)", async () => {
    const before = await snapshotA();
    await assert.rejects(install({ ...C_IDENTITY, myshopifyDomain: DOMAIN_A }), /identity mismatch/);
    assert.equal(await owner.shop.count({ where: { shopDomain: DOMAIN_C } }), 0);
    assert.deepEqual(await snapshotA(), before);
  });

  test("install creates the shop from Shopify's identity with default settings and no data", async () => {
    await install();
    const c = await shopC();
    assert.equal(c.shopifyShopId, C_IDENTITY.id);
    assert.equal(c.shopName, C_IDENTITY.name);
    assert.deepEqual(c.storefrontHosts, [C_IDENTITY.host]);
    assert.equal(c.uninstalledAt, null);
    assert.equal((await owner.billingState.findUniqueOrThrow({ where: { shopId: c.id } })).plan, "FREE");
    assert.notEqual(c.id, A.shopId);

    // Every merchant-owned table is empty for C — counted WITHOUT a shop filter, so RLS alone decides visibility.
    await withTenant(c.id, async ({ db }) => {
      for (const table of TENANT_TABLES) assert.equal(await (db[table] as { count: () => Promise<number> }).count(), 0, table);
      const settings = await db.shopSettings.findMany();
      assert.equal(settings.length, 1);
      assert.equal(settings[0].onboardingCompletedAt, null);
    });
    assert.deepEqual(await audit(c.id), ["shop.installed"]);
  });

  test("the new merchant's admin and storefront are empty even for a product id another shop has reviews for", async () => {
    await storeOfflineSession(DOMAIN_C, "C"); // what the token exchange stores
    const d = await dashboard(DOMAIN_C);
    assert.equal(d.stats.total, 0);
    assert.equal(d.onboarding.done, false);
    assert.ok(d.onboarding.reviewsBlockUrl.startsWith(`https://${DOMAIN_C}/admin/themes/current/editor?`));

    const list = await run(() => reviewsListLoader(args<LoaderFunctionArgs>(adminRequest(DOMAIN_C, "/app/reviews"))));
    assert.deepEqual((list.data as { rows: unknown[] }).rows, []);

    const pub = await proxyList(args<LoaderFunctionArgs>(proxyRequest(DOMAIN_C, `products/${SAME_PRODUCT_ID}/reviews`, { summary: "1" }), { id: String(SAME_PRODUCT_ID) }));
    const body = (await pub.json()) as { reviews: unknown[]; summary: { count: number } | null };
    assert.deepEqual(body.reviews, []);
    assert.ok(!body.summary || body.summary.count === 0);

    const ratings = await proxyRatings(args<LoaderFunctionArgs>(proxyRequest(DOMAIN_C, "ratings", { handles: SAME_HANDLE })));
    assert.deepEqual(await ratings.json(), { ratings: {} });
  });
});

describe("Lifecycle: authenticate → onboard → use → uninstall → reinstall stays tenant-isolated", () => {
  let aBefore: Awaited<ReturnType<typeof snapshotA>>;
  let cReviewId: string;
  before(async () => { aBefore = await snapshotA(); });

  test("authenticate: the tenant comes from the session token, not from ?shop=", async () => {
    const r = await run(() => dashboardLoader(args<LoaderFunctionArgs>(adminRequest(DOMAIN_C, `/app?shop=${DOMAIN_A}`))));
    assert.equal((r.data as { stats: { total: number } }).stats.total, 0); // A has 1 review; C sees its own 0
  });

  test("token refresh (afterAuth again on an active shop) keeps the same tenant, touches no data, writes no audit record", async () => {
    const id = (await shopC()).id;
    for (let i = 0; i < 3; i++) await install(); // e.g. three hourly refreshes of an expiring offline token
    assert.equal((await shopC()).id, id);
    assert.equal(await owner.shop.count(), 2);
    assert.deepEqual(await audit(id), ["shop.installed"]);
    assert.equal(await owner.auditLog.count({ where: { action: "shop.authenticated" } }), 0);
  });

  test("onboard: finishing setup is recorded for C only", async () => {
    const fd = new FormData();
    fd.set("intent", "complete_onboarding");
    const r = await run(() => dashboardAction(args<ActionFunctionArgs>(adminRequest(DOMAIN_C, "/app", { method: "POST", body: fd }))));
    assert.equal((r.data as { message: string }).message, "Setup complete.");
    assert.equal((await dashboard(DOMAIN_C)).onboarding.done, true);
    assert.equal((await dashboard(DOMAIN_A)).onboarding.done, false);
    const c = await shopC();
    const entry = await owner.auditLog.findFirstOrThrow({ where: { shopId: c.id, action: "onboarding.completed" } });
    assert.equal(entry.actor, "staff:42");
  });

  test("use: a storefront review lands in C (pending) and nowhere else, with no customer identity stored", async () => {
    const c = await shopC();
    // C's own copy of the product (product sync is checkpoint 4; seeded here so the test makes no Admin API call).
    await withTenant(c.id, ({ db, shopId }) =>
      db.product.create({ data: { shopId, shopifyProductId: SAME_PRODUCT_ID, handle: "fixture-product-c", title: "Fixture Product C", status: "active" } }));
    const res = await submitC("Fictional lifecycle review.");
    assert.equal(res.status, 201);
    const rows = await owner.review.findMany({ where: { shopId: c.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].shopifyCustomerId, null);
    assert.equal(rows[0].shopifyOrderId, null);
    assert.equal(rows[0].verifiedPurchase, false);
    cReviewId = rows[0].id;
    const list = await run(() => reviewsListLoader(args<LoaderFunctionArgs>(adminRequest(DOMAIN_C, "/app/reviews"))));
    assert.deepEqual((list.data as { rows: { id: string }[] }).rows.map((x) => x.id), [cReviewId]);
  });

  test("uninstall: C's sessions are deleted and C goes dark; A keeps its session and storefront", async () => {
    const res = await uninstalledWebhook(args<ActionFunctionArgs>(webhookRequest(DOMAIN_C, "app/uninstalled", "/webhooks/app/uninstalled", { myshopify_domain: DOMAIN_C })));
    assert.equal(res.status, 200);
    const c = await shopC();
    assert.ok(c.uninstalledAt);
    assert.equal(await owner.session.count({ where: { shop: DOMAIN_C } }), 0);
    assert.equal(await activeShopByDomain(DOMAIN_C), null);

    const dark = await run(() => proxyList(args<LoaderFunctionArgs>(proxyRequest(DOMAIN_C, `products/${SAME_PRODUCT_ID}/reviews`), { id: String(SAME_PRODUCT_ID) })));
    assert.equal(dark.response?.status, 404);
    const aStill = await run(() => proxyList(args<LoaderFunctionArgs>(proxyRequest(DOMAIN_A, `products/${SAME_PRODUCT_ID}/reviews`), { id: String(SAME_PRODUCT_ID) })));
    assert.equal(aStill.response?.status ?? 200, 200);
    assert.equal(await owner.session.count({ where: { shop: DOMAIN_A } }), 1);

    // Data is retained (deletion happens only on shop/redact, checkpoint 10).
    assert.equal(await owner.review.count({ where: { shopId: c.id } }), 1);
  });

  test("uninstall webhook redelivery is idempotent; an unknown shop's uninstall creates nothing", async () => {
    const c = await shopC();
    await uninstalledWebhook(args<ActionFunctionArgs>(webhookRequest(DOMAIN_C, "app/uninstalled", "/webhooks/app/uninstalled")));
    assert.deepEqual((await shopC()).uninstalledAt, c.uninstalledAt);
    assert.equal((await audit(c.id)).filter((a) => a === "shop.uninstalled").length, 1);

    const res = await uninstalledWebhook(args<ActionFunctionArgs>(webhookRequest("proofly-test-gone.myshopify.com", "app/uninstalled", "/webhooks/app/uninstalled")));
    assert.equal(res.status, 200);
    assert.equal(await owner.shop.count(), 2);
  });

  test("reinstall: same tenant reactivated, its own data and onboarding retained, still isolated", async () => {
    const before = await shopC();
    await install();
    await storeOfflineSession(DOMAIN_C, "C2");
    const c = await shopC();
    assert.equal(c.id, before.id);
    assert.equal(c.uninstalledAt, null);
    assert.ok(c.installedAt > before.installedAt);
    assert.deepEqual(await audit(c.id), ["shop.installed", "onboarding.completed", "review.submitted", "shop.uninstalled", "shop.reinstalled"]);

    const d = await dashboard(DOMAIN_C);
    assert.equal(d.stats.total, 1);
    assert.equal(d.stats.pending, 1);
    assert.equal(d.onboarding.done, true);
    const list = await run(() => reviewsListLoader(args<LoaderFunctionArgs>(adminRequest(DOMAIN_C, "/app/reviews"))));
    assert.deepEqual((list.data as { rows: { id: string }[] }).rows.map((x) => x.id), [cReviewId]);
    const back = await run(() => proxyList(args<LoaderFunctionArgs>(proxyRequest(DOMAIN_C, `products/${SAME_PRODUCT_ID}/reviews`), { id: String(SAME_PRODUCT_ID) })));
    assert.equal(back.response?.status ?? 200, 200);
  });

  test("merchant A is byte-for-byte unchanged by C's whole lifecycle", async () => {
    assert.deepEqual(await snapshotA(), aBefore);
    assert.equal((await dashboard(DOMAIN_A)).stats.total, 1);
  });
});

describe("Production install/auth configuration", () => {
  const toml = readFileSync("shopify.app.toml", "utf8");

  test("V1 requests only product scopes; no order/customer scopes or order webhooks", () => {
    const scopes = /^scopes = "([^"]*)"/m.exec(toml)?.[1];
    assert.equal(scopes, "read_products,write_products");
    assert.doesNotMatch(toml, /orders|customers"/);
    assert.match(toml, /^use_legacy_install_flow = false$/m);
    for (const f of [".env.example", ".env.test"]) assert.match(readFileSync(f, "utf8"), /^SCOPES=read_products,write_products$/m, f);
    assert.equal(existsSync("app/routes/webhooks.orders.fulfilled.tsx"), false);
  });

  test("no manual shop-domain login: login route and login() export are gone, landing page has no form", async () => {
    assert.equal(existsSync("app/routes/auth.login"), false);
    assert.equal("login" in shopifyServer, false);
    assert.doesNotMatch(readFileSync("app/routes/_index/route.tsx", "utf8"), /<form|<Form|name="shop"/i);
    assert.equal(await landingLoader(args<LoaderFunctionArgs>(new Request("http://localhost/"))), null);
    const r = await run(() => landingLoader(args<LoaderFunctionArgs>(new Request(`http://localhost/?shop=${DOMAIN_C}&host=abc`))));
    assert.equal(r.response?.status, 302);
    assert.equal(r.response?.headers.get("Location"), `/app?shop=${DOMAIN_C}&host=abc`); // /app re-verifies via session token
  });

  test("the server refuses to start without its secrets (an empty API secret would make HMACs forgeable)", () => {
    const env = { ...process.env, SHOPIFY_API_SECRET: "", TOKEN_ENCRYPTION_KEY: "" };
    const r = spawnSync(process.execPath, ["--import", "tsx", "-e", "await import('./app/shopify.server.ts')"], { env, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Missing required environment variables: SHOPIFY_API_SECRET, TOKEN_ENCRYPTION_KEY/);
  });
});
