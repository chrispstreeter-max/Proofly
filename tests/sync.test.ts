// Checkpoint 4: product sync, product webhooks, canonical aggregation (storage-limited photos), rating-cache ownership,
// metafield sync + reconciliation, per-merchant proxy paths, opaque public media ids, API version.
// Shopify is the in-memory FakeShopify (tests/helpers.ts) — no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import sharp from "sharp";
import prisma from "../app/db.server";
import { recomputeProduct } from "../app/lib/aggregates.server";
import { storeReviewImage } from "../app/lib/media.server";
import { moderate, setPlanLimited } from "../app/lib/moderation.server";
import { syncCatalog } from "../app/lib/products.server";
import { DEFAULT_PROXY_PATH, parseProxyPath, setProxyPath } from "../app/lib/proxy-path.server";
import { reconcileRatingCache, syncRatingCache } from "../app/lib/rating-cache.server";
import { ratingsByHandle } from "../app/lib/reviews.server";
import { markUninstalled, publishShopProxyPath, withTenant, type Tenant } from "../app/lib/tenant.server";
import { loader as mediaLoader } from "../app/routes/media.$";
import { loader as proxyList } from "../app/routes/proxy.products.$id.reviews";
import { loader as proxyRatings } from "../app/routes/proxy.ratings";
import { action as productsWebhook } from "../app/routes/webhooks.products";
import { API_VERSION } from "../app/shopify-api-version";
import { renderBlock, liquidProduct } from "../scripts/lib/extension-liquid";
import {
  args, DOMAIN_A, DOMAIN_B, DOMAIN_C, FakeShopify, installMerchant, owner, proxyRequest, resetDb, run, SAME_HANDLE, SAME_PRODUCT_ID,
  webhookRequest, type Merchant,
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
type Photo = "published" | "storage_limited" | "real";
async function review(t: Tenant, productId: string, rating: number, o: { status?: "published" | "pending" | "hidden" | "rejected"; hold?: "plan_limit" | "moderation"; photos?: Photo[] } = {}) {
  const r = await t.db.review.create({
    data: { shopId: t.shopId, productId, source: "csv", sourceReviewId: `s4-${++seq}`, rating, body: `body ${seq}`, reviewerName: "Fixture", reviewDate: new Date(Date.UTC(2026, 0, 1 + seq)), status: o.status ?? "published", holdReason: o.hold ?? null },
  });
  const ids: string[] = [];
  for (const [position, kind] of (o.photos ?? []).entries()) {
    const stored = kind === "real"
      ? await storeReviewImage(t.shopId, r.id, await sharp({ create: { width: 40, height: 30, channels: 3, background: "#4a7" } }).png().toBuffer())
      : { publicId: (seq.toString(16) + position).padStart(32, "c"), storageKey: `s/${t.shopId}/originals/x${seq}${position}.jpg`, thumbKey: `s/${t.shopId}/r/${r.id}/x${seq}${position}-320.webp`, largeKey: `s/${t.shopId}/r/${r.id}/x${seq}${position}-1600.webp`, contentType: "image/jpeg", fileSize: 1, sha256: String(position).repeat(64), width: 4, height: 3 };
    const img = await t.db.reviewImage.create({ data: { shopId: t.shopId, reviewId: r.id, originalFilename: "p.jpg", position, mediaStatus: kind === "storage_limited" ? "storage_limited" : "published", ...stored } });
    ids.push(img.publicId);
  }
  return { ...r, photoIds: ids };
}
const media = (name: string, init?: RequestInit) => run(() => mediaLoader(args<LoaderFunctionArgs>(new Request(`http://localhost/media/${name}`, init), { "*": name })));
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
    assert.match(toml, /^scopes = "read_products,write_products"$/m);
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
    assert.equal(await owner.review.count({ where: { productId: gone.id } }), 1);
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
describe("Canonical aggregation — storage limits apply to photos, never reviews", () => {
  const PID = 9_500_000_000_001n;
  let p: { id: string };
  const r: Record<string, Awaited<ReturnType<typeof review>>> = {};
  before(async () => {
    p = await asA((t) => product(t, PID, "photo-product"));
    await asA(async (t) => {
      r.publicPhoto = await review(t, p.id, 5, { photos: ["real"] });                                 // 1
      r.mixed = await review(t, p.id, 4, { photos: ["published", "storage_limited"] });               // 2
      r.allLimited = await review(t, p.id, 3, { photos: ["storage_limited", "storage_limited"] });     // 3
      r.planLimited = await review(t, p.id, 1, { hold: "plan_limit", photos: ["published"] });         // 4
      r.hidden = await review(t, p.id, 1, { status: "hidden", photos: ["published"] });                // 5
      r.noPhoto = await review(t, p.id, 4);
      await recomputeProduct(t, p.id);
    });
  });

  test("aggregate: count/average/distribution ignore photo state; photo_review_count counts only public photos", async () => {
    const row = await owner.product.findUniqueOrThrow({ where: { id: p.id } });
    assert.equal(row.reviewCount, 4); // 5,4,3,4 — plan-limited and hidden excluded; all-storage-limited INCLUDED
    assert.equal(Number(row.averageRating), 4);
    assert.deepEqual([row.rating1, row.rating2, row.rating3, row.rating4, row.rating5], [0, 0, 1, 2, 1]);
    assert.equal(row.photoReviewCount, 2); // publicPhoto + mixed; all-storage-limited is not a photo review
    // Making every storage-limited photo public changes ONLY the photo count.
    await asA(async (t) => {
      await t.db.reviewImage.updateMany({ where: { shopId: t.shopId, mediaStatus: "storage_limited", reviewId: { in: [r.mixed.id, r.allLimited.id] } }, data: { mediaStatus: "published" } });
      const a = await recomputeProduct(t, p.id);
      assert.deepEqual([a.reviewCount, a.averageRating, a.distribution, a.photoReviewCount], [4, 4, [0, 0, 1, 2, 1], 3]);
      await t.db.reviewImage.updateMany({ where: { shopId: t.shopId, publicId: { in: [r.mixed.photoIds[1], ...r.allLimited.photoIds] } }, data: { mediaStatus: "storage_limited" } });
      await recomputeProduct(t, p.id);
    });
  });

  test("storefront: reviews shown per review state; only public photos; photo filter = photo reviews", async () => {
    const body = await list(DOMAIN_A, PID, { summary: "1", sort: "highest" });
    const byRating = Object.fromEntries(body.reviews.map((x: { body: string; images: { thumb: string }[] }) => [x.body, x.images.map((i) => i.thumb)]));
    assert.deepEqual(Object.keys(byRating).sort(), [r.publicPhoto.body, r.mixed.body, r.allLimited.body, r.noPhoto.body].sort());
    assert.equal(byRating[r.publicPhoto.body].length, 1);
    assert.equal(byRating[r.mixed.body].length, 1); // photo 1 shown, photo 2 (storage-limited) not
    assert.ok(byRating[r.mixed.body][0].includes(r.mixed.photoIds[0]));
    assert.deepEqual(byRating[r.allLimited.body], []); // review displayed, no photos
    assert.deepEqual(body.summary, { count: 4, average: 4, distribution: [0, 0, 1, 2, 1], withPhotos: 2 });
    const photos = await list(DOMAIN_A, PID, { photos: "1" });
    assert.deepEqual(photos.reviews.map((x: { body: string }) => x.body).sort(), [r.publicPhoto.body, r.mixed.body].sort());
    const text = JSON.stringify(body);
    for (const id of [r.mixed.photoIds[1], ...r.allLimited.photoIds, ...r.planLimited.photoIds, ...r.hidden.photoIds]) assert.ok(!text.includes(id), id);
  });

  test("Shopify rating metafields follow the same aggregate (photos never change rating/count)", async () => {
    const shopify = new FakeShopify();
    await syncRatingCache(A.shopId, shopify.graphql, { productIds: [p.id], sleep: noSleep });
    assert.deepEqual(shopify.rating(PID), { average: "4.00", count: 4 });
  });

  test("public media: a public photo loads; storage-limited, plan-limited and hidden photos never do", async () => {
    const ok = await media(`${r.publicPhoto.photoIds[0]}-320.webp`);
    assert.equal(ok.response?.status, 200);
    assert.equal(ok.response?.headers.get("Content-Type"), "image/webp");
    assert.equal((await media(`${r.publicPhoto.photoIds[0]}-1600.webp`)).response?.status, 200);
    for (const id of [r.mixed.photoIds[1], ...r.allLimited.photoIds, ...r.planLimited.photoIds, ...r.hidden.photoIds]) {
      assert.equal((await media(`${id}-320.webp`)).response?.status, 404, id);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Opaque public media ids", () => {
  let good: string;
  let bReview: Awaited<ReturnType<typeof review>>;
  before(async () => {
    const pa = await asA((t) => product(t, 9_500_000_000_101n, "media-a"));
    const ra = await asA((t) => review(t, pa.id, 5, { photos: ["real"] }));
    good = ra.photoIds[0];
    const pb = await asB((t) => product(t, 9_500_000_000_101n, "media-a"));
    bReview = await asB((t) => review(t, pb.id, 5, { photos: ["real"] }));
  });

  test("ids are 128-bit random hex, unique, unrelated to database or Shopify ids", async () => {
    const all = await owner.reviewImage.findMany({ select: { publicId: true, id: true, reviewId: true, shopId: true } });
    assert.equal(new Set(all.map((x) => x.publicId)).size, all.length);
    for (const x of all) {
      assert.match(x.publicId, /^[0-9a-f]{32}$/);
      for (const internal of [x.id, x.reviewId, x.shopId]) assert.ok(!x.publicId.includes(internal.replace(/-/g, "").slice(0, 12)));
    }
  });

  test("invalid or manipulated ids, internal keys and originals → the same 404; query/tenant params are ignored", async () => {
    const flipped = (good[0] === "0" ? "1" : "0") + good.slice(1);
    const key = await owner.reviewImage.findFirstOrThrow({ where: { publicId: good } });
    const candidates = [
      `${flipped}-320.webp`, `${good}-640.webp`, `${good}.webp`, `${good.toUpperCase()}-320.webp`, `${good}-320.webp/..`,
      key.thumbKey, key.storageKey, `../${key.storageKey}`, `${good}-320.jpg`, "x", "",
      `${A.shopId}-320.webp`, `${key.reviewId.replace(/-/g, "")}-320.webp`,
    ];
    const bodies = new Set<string>();
    for (const c of candidates) {
      const res = (await media(c)).response!;
      assert.equal(res.status, 404, c);
      bodies.add(await res.text());
    }
    assert.equal(bodies.size, 1);
    const withParams = await run(() => mediaLoader(args<LoaderFunctionArgs>(new Request(`http://localhost/media/${good}-320.webp?shop=${DOMAIN_B}&shop_id=${B.shopId}`), { "*": `${good}-320.webp` })));
    assert.equal(withParams.response?.status, 200); // the asset id alone decides; extra params change nothing
  });

  test("another merchant's photo can only be reached by its own public id, and only while public; uninstalling hides it", async () => {
    const bId = bReview.photoIds[0];
    assert.equal((await media(`${bId}-320.webp`)).response?.status, 200);
    // A's storefront never references B's assets, even for the same Shopify product id and handle.
    assert.ok(!JSON.stringify(await list(DOMAIN_A, 9_500_000_000_101n)).includes(bId));
    await asB((t) => moderate(t, [bReview.id], "hide", "test"));
    assert.equal((await media(`${bId}-320.webp`)).response?.status, 404);
    await asB((t) => moderate(t, [bReview.id], "approve", "test"));
    assert.equal((await media(`${bId}-320.webp`)).response?.status, 200);
    // A shop that uninstalls stops serving its photos (data kept).
    const gone = await installMerchant("proofly-test-d.myshopify.com", "D");
    const gp = await withTenant(gone.shopId, (t) => product(t, 9_500_000_000_555n, "gone-media"));
    const gr = await withTenant(gone.shopId, (t) => review(t, gp.id, 5, { photos: ["real"] }));
    assert.equal((await media(`${gr.photoIds[0]}-320.webp`)).response?.status, 200);
    await markUninstalled("proofly-test-d.myshopify.com");
    assert.equal((await media(`${gr.photoIds[0]}-320.webp`)).response?.status, 404);
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
    await asA((t) => recomputeProduct(t, p2.id));
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
    await asA((t) => recomputeProduct(t, p2.id));
    const row = await owner.product.findUniqueOrThrow({ where: { id: p2.id } });
    assert.equal(row.ratingOwnership, "proofly_managed");
    assert.ok(row.ratingManagedAt);
    const r = await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.ok(r.written >= 1);
    assert.deepEqual(shopify.rating(P2), { average: "5.00", count: 1 });
  });

  test("3. Proofly-managed rating updates on review changes; re-syncing an unchanged aggregate writes nothing", async () => {
    await asA(async (t) => { await review(t, p2.id, 3); await recomputeProduct(t, p2.id); });
    await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.deepEqual(shopify.rating(P2), { average: "4.00", count: 2 });
    const before = shopify.ops("ProoflySetRatings").length;
    await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.equal(shopify.ops("ProoflySetRatings").length, before); // idempotent: nothing dirty
  });

  test("moderation and plan limits change the aggregate through the same pathway", async () => {
    await asA((t) => moderate(t, [first.id], "hide", "test"));
    await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.deepEqual(shopify.rating(P2), { average: "3.00", count: 1 });
    await asA((t) => moderate(t, [first.id], "approve", "test")); // restore → publish again
    const others = await owner.review.findMany({ where: { productId: p2.id, status: "published", rating: 3 } });
    await asA((t) => setPlanLimited(t, others.map((x) => x.id), true, "test"));
    await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.deepEqual(shopify.rating(P2), { average: "5.00", count: 1 });
    await asA((t) => setPlanLimited(t, others.map((x) => x.id), false, "test")); // made publishable again
    await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.deepEqual(shopify.rating(P2), { average: "4.00", count: 2 });
  });

  test("a Proofly-managed product with no public reviews left: count 0 and Proofly's own rating removed", async () => {
    const ids = (await owner.review.findMany({ where: { productId: p2.id, status: "published" } })).map((x) => x.id);
    await asA((t) => moderate(t, ids, "hide", "test"));
    await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.deepEqual(shopify.rating(P2), { average: null, count: 0 });
    await asA((t) => moderate(t, ids, "approve", "test"));
    await syncRatingCache(A.shopId, shopify.graphql, { sleep: noSleep });
    assert.deepEqual(shopify.rating(P2), { average: "4.00", count: 2 });
  });

  test("4. reconciliation repairs wrong, stale and missing Proofly-owned values — and never touches reviews", async () => {
    const reviewsBefore = await owner.review.findMany({ where: { shopId: A.shopId }, orderBy: { id: "asc" } });
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
    assert.deepEqual(await owner.review.findMany({ where: { shopId: A.shopId }, orderBy: { id: "asc" } }), reviewsBefore);
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
    await asA(async (t) => { await review(t, p2.id, 1); await recomputeProduct(t, p2.id); });
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
    const reviews = await owner.review.count({ where: { productId: p2.id } });
    for (let i = 0; i < 2; i++) await productWebhook(DOMAIN_A, "products/delete", { id: Number(P2) }); // duplicate delivery
    await productWebhook(DOMAIN_A, "products/delete", { id: Number(P3) });
    const row = await owner.product.findUniqueOrThrow({ where: { id: p2.id } });
    assert.ok(row.deletedAt);
    assert.equal(await owner.review.count({ where: { productId: p2.id } }), reviews);
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
    assert.equal(await owner.review.count({ where: { productId: fresh.id } }), 0);
    assert.deepEqual(await asA((t) => ratingsByHandle(t, ["owned-later"])), {}); // handle no longer resolves to the old reviews
    assert.deepEqual((await list(DOMAIN_A, NEW, { summary: "1" })).summary.count, 0);
    assert.ok(await owner.review.count({ where: { productId: p2.id } })); // old history kept on the deleted product
  });

  test("10. merchant A cannot read, sync, reconcile or change ownership of merchant B's ratings", async () => {
    const bp = await asB((t) => product(t, 9_600_000_000_900n, "b-owned"));
    await asB(async (t) => { await review(t, bp.id, 4); await recomputeProduct(t, bp.id); });
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
    assert.equal(await asA((t) => recomputeProduct(t, bp.id)).then((a) => a.reviewCount), 0); // computes over A's rows only
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
