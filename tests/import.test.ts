// Checkpoint 6: import engine + CSV importer. Numbers refer to the checkpoint's required test list.
// Offline: Shopify is FakeShopify; tests/no-network.ts blocks real network access; data is fictional.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { after, before, describe, test } from "node:test";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import sharp from "sharp";
import prisma from "../app/db.server";
import { computeAggregate } from "../app/lib/aggregates.server";
import { reconcileBilling } from "../app/lib/billing.server";
import { getPlanStatus, releaseEligibleMedia, releaseEligibleReviews } from "../app/lib/entitlements.server";
import {
  analyseRecords, cancelImport, createImport, fallbackId, getImport, IMPORT_LIMITS, ImportError, parseReviewDate, runImport, skuLookupFromAdmin,
} from "../app/lib/import.server";
import { readPrivate } from "../app/lib/media.server";
import { markUninstalled, withTenant } from "../app/lib/tenant.server";
import { action as importsAction, loader as importsLoader } from "../app/routes/app.imports";
import { loader as mediaLoader } from "../app/routes/media.$";
import { loader as proxyList } from "../app/routes/proxy.products.$id.reviews";
import { adminRequest, args, FakeShopify, installMerchant, owner, proxyRequest, resetDb, run, type Merchant } from "./helpers";

after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

// ---------------------------------------------------------------------------------------------------------------
let n = 0;
async function emptyShop(label: string): Promise<Merchant> {
  const m = await installMerchant(`proofly-test-${label}.myshopify.com`, label);
  await owner.review.deleteMany({ where: { shopId: m.shopId } });
  await owner.product.deleteMany({ where: { shopId: m.shopId } });
  await owner.importJob.deleteMany({ where: { shopId: m.shopId } });
  return m;
}
type P = { id: bigint; handle: string; title: string; deleted?: boolean };
const addProducts = (m: Merchant, ps: P[]) =>
  withTenant(m.shopId, ({ db, shopId }) => db.product.createMany({ data: ps.map((p) => ({ shopId, shopifyProductId: p.id, handle: p.handle, title: p.title, status: "active", deletedAt: p.deleted ? new Date() : null })) }));
const csvOf = (rows: Record<string, string>[]) => {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const q = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  return Buffer.from([cols.join(","), ...rows.map((r) => cols.map((c) => q(r[c] ?? "")).join(","))].join("\n"));
};
const row = (o: Record<string, string> = {}) => ({ review_id: `r${++n}`, product_id: "9800000000001", rating: "5", title: "Fine", body: `Body ${n}`, reviewer_name: "Pat Example", review_date: "2025-01-01T10:00:00Z", ...o });
/** ZIP writer for tests (stored or deflated entries; names are used verbatim). */
function zipOf(files: Record<string, Buffer>, deflate = true) {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const body = deflate ? deflateRawSync(data) : data;
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, body); centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const png = (hue: number, w = 60) => sharp({ create: { width: w, height: 40, channels: 3, background: { r: hue, g: 120, b: 200 } } }).png().toBuffer();
async function importNow(m: Merchant, rows: Record<string, string>[], o: { images?: Buffer; publishMode?: "publish" | "moderate"; shopify?: FakeShopify; source?: string; batchRows?: number } = {}) {
  const { jobId } = await createImport(m.shopId, { csv: csvOf(rows), images: o.images ?? null, options: { publishMode: o.publishMode ?? "publish", source: o.source }, actor: "test", skuLookup: o.shopify ? skuLookupFromAdmin(o.shopify.graphql) : null });
  await runImport(m.shopId, jobId, { batchRows: o.batchRows });
  return (await getImport(m.shopId, jobId))!;
}
const C = (j: { counts: unknown }) => j.counts as Record<string, number>;
const A = (j: { analysis: unknown }) => j.analysis as Record<string, number> & { problems: { record: number; code: string | null; warnings: string[]; images: string[] }[] };
const reviewsOf = (m: Merchant) => owner.review.findMany({ where: { shopId: m.shopId }, orderBy: { sourceReviewId: "asc" } });
const publishedIds = async (m: Merchant) => (await owner.review.findMany({ where: { shopId: m.shopId, status: "published", holdReason: null }, select: { sourceReviewId: true } })).map((r) => r.sourceReviewId).sort();
const setPlan = (m: Merchant, handle: string | null) => { const s = new FakeShopify(); if (handle) s.subscriptions = [{ id: `gid://shopify/AppSubscription/${handle}`, name: handle, status: "ACTIVE", planHandle: handle }]; return reconcileBilling(m.shopId, s.graphql); };
const P1: P = { id: 9_800_000_000_001n, handle: "alpha-example-mug", title: "Alpha Example Mug" };
const P2: P = { id: 9_800_000_000_002n, handle: "beta-sample-tote", title: "Beta Sample Tote" };
const P3: P = { id: 9_800_000_000_003n, handle: "gamma-demo-lamp", title: "Gamma Demo Lamp" };

before(async () => { await resetDb(); });

// ---------------------------------------------------------------------------------------------------------------
describe("Basics", () => {
  test("1. a new merchant starts empty (no reviews, imports or matches)", async () => {
    const m = await emptyShop("j");
    assert.equal(await owner.review.count({ where: { shopId: m.shopId } }), 0);
    assert.equal(await owner.importJob.count({ where: { shopId: m.shopId } }), 0);
    assert.equal(await owner.importProductMatch.count({ where: { shopId: m.shopId } }), 0);
  });

  test("2. basic valid CSV import: every row stored, published within the allowance, job completed", async () => {
    const m = await emptyShop("k");
    await addProducts(m, [P1]);
    const j = await importNow(m, [row(), row({ rating: "4" }), row({ rating: "3", title: "" })]);
    assert.equal(j.status, "completed");
    assert.deepEqual([C(j).imported, C(j).published, C(j).planLimited], [3, 3, 0]);
    const rs = await reviewsOf(m);
    assert.ok(rs.every((r) => r.imported && r.importJobId === j.id && r.source === "csv" && !r.verifiedPurchase));
  });

  test("3. missing optional fields: no id (deterministic fallback), no title, no name, no status column", async () => {
    const m = await emptyShop("l");
    await addProducts(m, [P1]);
    const rows = [{ product_handle: P1.handle, rating: "5", body: "Only the essentials.", review_date: "2024-05-01" }];
    const j = await importNow(m, rows);
    assert.equal(j.status, "completed_with_warnings");
    const [r] = await reviewsOf(m);
    assert.equal(r.reviewerName, "Anonymous");
    assert.equal(r.title, "");
    assert.match(r.sourceReviewId, /^h_[0-9a-f]{64}$/);
    const ref = JSON.stringify({ id: "", handle: P1.handle, sku: "", title: "" });
    assert.equal(r.sourceReviewId, fallbackId(ref, "Anonymous", new Date("2024-05-01T00:00:00Z"), "Only the essentials."));
    assert.ok(A(j).problems.some((p) => p.warnings.includes("missing_reviewer_name")));
  });

  test("4 + 5. invalid ratings and dates are reported and never stored", async () => {
    for (const v of ["0", "6", "five", "4.5", "", " 3 x"]) assert.equal(analyseRecords(csvOf([row({ rating: v })]).toString(), { publishMode: "publish" }).rows[0].code, "invalid_rating", v);
    for (const v of ["31/12/2020", "2021-02-30", "2021-13-40 10:00", "yesterday", "2099-01-01", "1980-01-01", ""]) assert.equal(analyseRecords(csvOf([row({ review_date: v })]).toString(), { publishMode: "publish" }).rows[0].code, "invalid_date", v);
    assert.ok(parseReviewDate("2025-06-01 13:45"));
    assert.equal(parseReviewDate("2025-06-01T13:45:00+02:00")!.toISOString(), "2025-06-01T11:45:00.000Z");
    const m = await emptyShop("m");
    await addProducts(m, [P1]);
    const j = await importNow(m, [row({ rating: "9" }), row({ review_date: "02/03/2024" }), row()]);
    assert.deepEqual([C(j).imported, A(j).invalidRows], [1, 2]);
    assert.equal(await owner.review.count({ where: { shopId: m.shopId } }), 1);
  });

  test("6. status mapping: known states kept, unknown/malformed never public, published still goes through Proofly", async () => {
    const m = await emptyShop("n");
    await addProducts(m, [P1]);
    const j = await importNow(m, [
      row({ review_id: "s-pub", status: "Approved" }), row({ review_id: "s-pen", status: "pending" }), row({ review_id: "s-rej", status: "spam" }),
      row({ review_id: "s-hid", status: "archived" }), row({ review_id: "s-unk", status: "featured???" }), row({ review_id: "s-mal", status: "pub lished" }),
    ]);
    const by = Object.fromEntries((await reviewsOf(m)).map((r) => [r.sourceReviewId, [r.status, r.holdReason, r.flags.includes("unknown_source_status")]]));
    assert.deepEqual(by, {
      "s-pub": ["published", null, false], "s-pen": ["pending", null, false], "s-rej": ["rejected", null, false], "s-hid": ["hidden", null, false],
      "s-unk": ["pending", null, true], "s-mal": ["pending", null, true],
    });
    assert.equal(C(j).published, 1);
    // "Hold for moderation" mode: even published source rows wait for the merchant.
    const m2 = await emptyShop("o");
    await addProducts(m2, [P1]);
    const j2 = await importNow(m2, [row({ status: "published" }), row()], { publishMode: "moderate" });
    assert.deepEqual([C(j2).published, C(j2).awaitingModeration], [0, 2]);
  });

  test("7. duplicate rows in one CSV: identical → imported once; same id with different content → neither (order-independent)", async () => {
    const m = await emptyShop("p");
    await addProducts(m, [P1]);
    const same = row({ review_id: "dup-1" });
    const j = await importNow(m, [same, { ...same }, row({ review_id: "clash" }), row({ review_id: "clash", body: "different text" })]);
    assert.deepEqual([C(j).imported, A(j).duplicateSourceRows, A(j).conflictingSourceIds], [1, 1, 2]);
    assert.deepEqual((await reviewsOf(m)).map((r) => r.sourceReviewId), ["dup-1"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Idempotency, retry and resume", () => {
  test("8. re-importing the same CSV changes nothing: no duplicate reviews, replies, media, moderation rows, dates, states or allowance use", async () => {
    const m = await emptyShop("q");
    await addProducts(m, [P1]);
    const zip = zipOf({ "a.png": await png(10), "b.png": await png(90) });
    const rows = [row({ review_id: "i-1", reply: "Thanks!", image_files: "a.png" }), row({ review_id: "i-2", image_files: "b.png", status: "pending" }), row({ review_id: "i-3" })];
    const first = await importNow(m, rows, { images: zip });
    const snap = async () => ({
      reviews: await reviewsOf(m), // entire rows, including updatedAt: a re-import must not touch them
      replies: await owner.reviewReply.findMany({ where: { shopId: m.shopId }, orderBy: { reviewId: "asc" } }),
      images: await owner.reviewImage.findMany({ where: { shopId: m.shopId }, orderBy: { publicId: "asc" } }),
      moderation: await owner.moderationAction.count({ where: { shopId: m.shopId } }),
      usage: (await withTenant(m.shopId, (t) => getPlanStatus(t))).usage,
    });
    const before = await snap();
    const second = await importNow(m, rows, { images: zip });
    assert.deepEqual([C(second).imported, C(second).alreadyImported, C(second).published, C(second).planLimited, C(second).mediaAccepted], [0, 3, 0, 0, 0]);
    assert.deepEqual(await snap(), before);
    assert.equal(C(first).repliesImported, 1);
  });

  test("43 + 44. a crashed import resumes at its cursor; malformed rows never cause duplicates", async () => {
    const m = await emptyShop("r");
    await addProducts(m, [P1]);
    const rows = Array.from({ length: 9 }, (_, i) => row({ review_id: `res-${i}`, rating: i === 4 ? "x" : "4" }));
    const { jobId } = await createImport(m.shopId, { csv: csvOf(rows), options: { publishMode: "publish" }, actor: "test" });
    await assert.rejects(runImport(m.shopId, jobId, { batchRows: 2, failAfterBatches: 2 }), /simulated process failure/);
    let j = (await getImport(m.shopId, jobId))!;
    assert.deepEqual([j.status, j.processedRows, C(j).imported], ["failed", 4, 4]);
    assert.equal(await owner.review.count({ where: { shopId: m.shopId, status: "published", holdReason: null } }), 0); // not finalized yet
    await runImport(m.shopId, jobId, { batchRows: 2 });
    j = (await getImport(m.shopId, jobId))!;
    assert.deepEqual([j.status, C(j).imported, C(j).published, A(j).invalidRows], ["completed_with_warnings", 8, 8, 1]);
    assert.equal(await owner.review.count({ where: { shopId: m.shopId } }), 8);
  });

  test("9. re-uploading after a partial failure adopts the unfinished rows: same final state as a clean import", async () => {
    const m = await emptyShop("s");
    await addProducts(m, [P1]);
    await setPlan(m, null); // Free: 100
    const rows = Array.from({ length: 120 }, (_, i) => row({ review_id: `ad-${String(i).padStart(3, "0")}`, review_date: new Date(Date.UTC(2024, 0, 1, i)).toISOString() }));
    const { jobId } = await createImport(m.shopId, { csv: csvOf([...rows].reverse()), options: { publishMode: "publish" }, actor: "test" });
    await assert.rejects(runImport(m.shopId, jobId, { batchRows: 40, failAfterBatches: 1 }));
    const j2 = await importNow(m, rows); // fresh upload, different row order
    assert.deepEqual([C(j2).imported, C(j2).adopted, C(j2).published, C(j2).planLimited], [80, 40, 100, 20]);
    assert.deepEqual(await publishedIds(m), rows.slice(0, 100).map((r) => r.review_id).sort()); // oldest 100
    assert.equal(await owner.review.count({ where: { shopId: m.shopId } }), 120);
  });

  test("10 + 23. final publication is identical regardless of CSV row order — including equal timestamps", async () => {
    const make = (i: number) => row({ review_id: `ord-${(i * 7919) % 1000}`, rating: String((i % 5) + 1), review_date: new Date(Date.UTC(2023, 0, 1 + Math.floor(i / 3))).toISOString() });
    const rows = Array.from({ length: 130 }, (_, i) => make(i)); // 3 reviews per day → many equal timestamps
    const orders = [rows, [...rows].reverse(), [...rows].sort((a, b) => a.body.localeCompare(b.body)), rows.filter((_, i) => i % 2).concat(rows.filter((_, i) => !(i % 2)))];
    const results: string[][] = [];
    for (const [k, order] of orders.entries()) {
      const m = await emptyShop(`ord${k}`);
      await addProducts(m, [P1]);
      await importNow(m, order);
      results.push(await publishedIds(m));
    }
    assert.equal(results[0].length, 100);
    for (const r of results.slice(1)) assert.deepEqual(r, results[0]);
    // The tie-break on equal dates is the stable source id, never row position or rating.
    const sameDay = rows.filter((r) => r.review_date === rows[99].review_date).map((r) => r.review_id).sort();
    const cut = sameDay.filter((id) => results[0].includes(id));
    assert.deepEqual(cut, sameDay.slice(0, cut.length));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Product matching (ID → handle → SKU; never guessed)", () => {
  let m: Merchant;
  let shopify: FakeShopify;
  before(async () => {
    m = await emptyShop("t");
    await addProducts(m, [P1, P2, P3, { id: 9_800_000_000_009n, handle: "gone-example", title: "Gone Example", deleted: true }]);
    shopify = new FakeShopify();
    shopify.skus.set("SKU-ONE", [P1.id]);
    shopify.skus.set("SKU-SHARED", [P2.id, P3.id]);
  });
  const matchOf = async (r: Record<string, string>) => {
    const j = await importNow(m, [{ ...row(), product_id: "", ...r }], { shopify });
    return { j, match: j.matches[0], stored: await owner.review.findFirst({ where: { shopId: m.shopId, importJobId: j.id } }) };
  };

  test("17. by Shopify product id", async () => {
    const { match, stored } = await matchOf({ product_id: String(P2.id) });
    assert.deepEqual([match.status, match.method], ["matched", "id"]);
    assert.equal(stored!.productId, (await owner.product.findFirstOrThrow({ where: { shopId: m.shopId, shopifyProductId: P2.id } })).id);
  });
  test("18. by handle (case-insensitive)", async () => {
    const { match } = await matchOf({ product_handle: P3.handle.toUpperCase() });
    assert.deepEqual([match.status, match.method], ["matched", "handle"]);
  });
  test("19. by SKU (through the shop's own Admin API; exact)", async () => {
    const { match } = await matchOf({ sku: "SKU-ONE" });
    assert.deepEqual([match.status, match.method], ["matched", "sku"]);
    assert.equal((await matchOf({ sku: "sku-one" })).match.status, "unmatched"); // exact only
  });
  test("15. ambiguous: identifiers disagree, a SKU on two products, or an id that is not live while the handle matches", async () => {
    for (const r of [{ product_id: String(P1.id), product_handle: P2.handle }, { sku: "SKU-SHARED" }, { product_id: "9800000000009", product_handle: P1.handle }, { product_id: "9800000000777", product_handle: P1.handle }] as Record<string, string>[]) {
      const { match, stored } = await matchOf(r);
      assert.equal(match.status, "ambiguous", JSON.stringify(r));
      assert.equal(stored, null);
    }
  });
  test("16. unmatched: unknown or deleted product → reported with a reason, no review written", async () => {
    for (const r of [{ product_id: "9800000000555" }, { product_handle: "no-such-thing" }, { product_id: "9800000000009" }, { sku: "NOPE" }] as Record<string, string>[]) {
      const { j, match, stored } = await matchOf(r);
      assert.equal(match.status, "unmatched");
      assert.ok(match.reason);
      assert.equal(stored, null);
      assert.equal(A(j).unmatchedRows, 1);
    }
  });
  test("20. title only → unmatched; the exact-title product is a suggestion, never an association", async () => {
    const { match, stored } = await matchOf({ product_title: `  ${P1.title.toLowerCase()} ` });
    assert.equal(match.status, "unmatched");
    assert.equal(match.reason, "title_only_needs_confirmation");
    assert.deepEqual((match.candidates as { handle: string; via: string }[]).map((c) => [c.handle, c.via]), [[P1.handle, "title"]]);
    assert.equal(stored, null);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Tenant isolation", () => {
  let a: Merchant, b: Merchant;
  before(async () => {
    a = await emptyShop("ua");
    b = await emptyShop("ub");
    for (const s of [a, b]) await addProducts(s, [P1, P2]); // identical Shopify ids, handles and titles in both shops
  });

  test("11–14. colliding source ids, product ids, handles and SKUs: each shop imports into its own records only", async () => {
    const shopifyA = new FakeShopify(); shopifyA.skus.set("SHARED-SKU", [P1.id]);
    const shopifyB = new FakeShopify(); shopifyB.skus.set("SHARED-SKU", [P2.id]);
    const rows = [row({ review_id: "same-1" }), row({ review_id: "same-2", product_id: "", product_handle: P2.handle }), row({ review_id: "same-3", product_id: "", sku: "SHARED-SKU" })];
    await importNow(a, rows, { shopify: shopifyA });
    const bBefore = await owner.review.count({ where: { shopId: b.shopId } });
    await importNow(b, rows, { shopify: shopifyB });
    const prodOf = async (s: Merchant, srid: string) => (await owner.product.findUniqueOrThrow({ where: { id: (await owner.review.findFirstOrThrow({ where: { shopId: s.shopId, sourceReviewId: srid } })).productId } }));
    for (const s of [a, b]) for (const id of ["same-1", "same-2", "same-3"]) assert.equal((await prodOf(s, id)).shopId, s.shopId);
    assert.equal((await prodOf(a, "same-3")).shopifyProductId, P1.id);
    assert.equal((await prodOf(b, "same-3")).shopifyProductId, P2.id);
    assert.equal(await owner.review.count({ where: { shopId: b.shopId } }), bBefore + 3);
  });

  test("33 + 34. shop A cannot read or cancel shop B's import (library and admin route)", async () => {
    const { jobId } = await createImport(b.shopId, { csv: csvOf([row({ review_id: "b-q" })]), options: { publishMode: "publish" }, actor: "test" });
    assert.equal(await getImport(a.shopId, jobId), null);
    await assert.rejects(cancelImport(a.shopId, jobId, "a"), (e: unknown) => e instanceof ImportError && e.code === "not_found");
    await assert.rejects(runImport(a.shopId, jobId), (e: unknown) => e instanceof ImportError && e.code === "not_found");
    const listed = await run(() => importsLoader(args<LoaderFunctionArgs>(adminRequest(a.domain, "/app/imports"))));
    assert.ok(!JSON.stringify(listed.data).includes(jobId));
    const fd = new FormData(); fd.set("intent", "cancel"); fd.set("jobId", jobId);
    const res = await run(() => importsAction(args<ActionFunctionArgs>(adminRequest(a.domain, "/app/imports", { method: "POST", body: fd }))));
    assert.match((res.data as { message: string }).message, /not found/i);
    assert.equal((await owner.importJob.findUniqueOrThrow({ where: { id: jobId } })).status, "queued");
    await cancelImport(b.shopId, jobId, "b");
  });

  test("35 + 36. tenant ids in the request or the file are ignored; another shop's identifiers never cross over", async () => {
    const bProduct = await owner.product.findFirstOrThrow({ where: { shopId: b.shopId, shopifyProductId: P1.id } });
    const bReview = await owner.review.findFirstOrThrow({ where: { shopId: b.shopId } });
    const fd = new FormData();
    fd.set("intent", "upload"); fd.set("shopId", b.shopId); fd.set("shop_id", b.shopId); fd.set("publishMode", "publish");
    fd.set("csv", new File([csvOf([
      row({ review_id: "x-1", shop_id: b.shopId, shop: b.domain }),
      row({ review_id: bReview.sourceReviewId, product_id: "", product_handle: "", product_title: "", sku: bProduct.id }), // B's internal ids
    ])], "r.csv", { type: "text/csv" }));
    const before = await owner.review.findMany({ where: { shopId: b.shopId }, orderBy: { id: "asc" } });
    const res = await run(() => importsAction(args<ActionFunctionArgs>(adminRequest(a.domain, "/app/imports", { method: "POST", body: fd }))));
    assert.match((res.data as { message: string }).message, /Import started/);
    await new Promise((r) => setTimeout(r, 400)); // background run (same process)
    const job = await owner.importJob.findFirstOrThrow({ where: { shopId: a.shopId }, orderBy: { createdAt: "desc" } });
    assert.equal(job.shopId, a.shopId);
    assert.deepEqual(await owner.review.findMany({ where: { shopId: b.shopId }, orderBy: { id: "asc" } }), before);
    assert.ok(await owner.review.findFirst({ where: { shopId: a.shopId, sourceReviewId: "x-1" } }));
  });

  test("32. an uninstalled shop cannot import", async () => {
    const g = await emptyShop("uc");
    await addProducts(g, [P1]);
    await markUninstalled(g.domain);
    await assert.rejects(createImport(g.shopId, { csv: csvOf([row()]), options: { publishMode: "publish" }, actor: "x" }), (e: unknown) => e instanceof ImportError && e.code === "shop_inactive");
  });

  test("42. one active import per shop", async () => {
    const s = await emptyShop("ud");
    await addProducts(s, [P1]);
    const { jobId } = await createImport(s.shopId, { csv: csvOf([row()]), options: { publishMode: "publish" }, actor: "x" });
    await assert.rejects(createImport(s.shopId, { csv: csvOf([row()]), options: { publishMode: "publish" }, actor: "x" }), (e: unknown) => e instanceof ImportError && e.code === "import_in_progress");
    await owner.importJob.update({ where: { id: jobId }, data: { status: "running", heartbeatAt: new Date() } });
    await assert.rejects(runImport(s.shopId, jobId), (e: unknown) => e instanceof ImportError && e.code === "not_runnable");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Plan limits on import (date order only)", () => {
  test("21 + 22. old 1★ vs new 5★ and old 5★ vs new 1★: the oldest win either way", async () => {
    for (const [label, oldRating, newRating] of [["v1", "1", "5"], ["v2", "5", "1"]] as const) {
      const m = await emptyShop(label);
      await addProducts(m, [P1]);
      const rows = Array.from({ length: 140 }, (_, i) => row({ review_id: `f-${label}-${String(999 - i).padStart(3, "0")}`, rating: i < 100 ? oldRating : newRating, body: i < 100 ? "Old review" : "New review", review_date: new Date(Date.UTC(2022, 0, 1, i)).toISOString() }));
      const j = await importNow(m, [...rows].reverse());
      assert.deepEqual([C(j).published, C(j).planLimited], [100, 40]);
      const pub = await owner.review.findMany({ where: { shopId: m.shopId, status: "published", holdReason: null } });
      assert.ok(pub.every((r) => r.body === "Old review" && String(r.rating) === oldRating), label);
    }
  });

  test("24. a downgraded merchant keeps grandfathered published reviews; imported reviews are held", async () => {
    const m = await emptyShop("w");
    await addProducts(m, [P1]);
    await setPlan(m, "starter");
    await importNow(m, Array.from({ length: 150 }, (_, i) => row({ review_id: `g-${i}`, review_date: new Date(Date.UTC(2021, 0, 1, i)).toISOString() })));
    await setPlan(m, null);
    const j = await importNow(m, Array.from({ length: 10 }, (_, i) => row({ review_id: `g-new-${i}` })));
    assert.deepEqual([C(j).imported, C(j).published, C(j).planLimited], [10, 0, 10]);
    assert.equal((await publishedIds(m)).length, 150);
  });

  test("25 + 26 + 27. Free overage is kept as plan-limited; upgrading publishes nothing; 'Publish eligible reviews' does, oldest first", async () => {
    const m = await emptyShop("x");
    await addProducts(m, [P1]);
    await setPlan(m, null);
    const rows = Array.from({ length: 260 }, (_, i) => row({ review_id: `o-${i}`, review_date: new Date(Date.UTC(2020, 0, 1, i)).toISOString() }));
    const j = await importNow(m, rows);
    assert.deepEqual([C(j).imported, C(j).published, C(j).planLimited], [260, 100, 160]);
    await setPlan(m, "starter");
    assert.equal((await publishedIds(m)).length, 100); // no automatic publication
    const r = await withTenant(m.shopId, (t) => releaseEligibleReviews(t, { actor: "merchant" }));
    assert.deepEqual(r, { released: 160, stillHeld: 0 });
    assert.equal(await owner.review.count({ where: { shopId: m.shopId } }), 260);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Photos", () => {
  let m: Merchant;
  before(async () => {
    m = await emptyShop("y");
    await addProducts(m, [P1, P2]);
  });

  test("37 + 39 + 40 + 41. path traversal, remote URLs, oversized, zip-bomb, unsupported and >5 images are rejected deterministically", async () => {
    const big = Buffer.alloc(IMPORT_LIMITS.imageBytes + 1, 1);
    const zip = zipOf({
      "ok-1.png": await png(1), "ok-2.png": await png(2), "ok-3.png": await png(3), "ok-4.png": await png(4), "ok-5.png": await png(5), "ok-6.png": await png(6),
      "big.png": big, "bomb.png": Buffer.alloc(25 * 1024 * 1024, 0), "anim.gif": Buffer.from("GIF89a....."), "notes.txt": Buffer.from("hello"),
      "../escape.png": await png(7),
    });
    const j = await importNow(m, [
      row({ review_id: "img-many", image_files: "ok-1.png;ok-2.png;ok-3.png;ok-4.png;ok-5.png;ok-6.png" }),
      row({ review_id: "img-bad", image_files: "../escape.png|/etc/passwd|C:/x.png|a/../../b.png|https://example.com/x.jpg|big.png|bomb.png|anim.gif|notes.txt|ok-1.png" }),
    ], { images: zip });
    const many = await owner.reviewImage.findMany({ where: { review: { sourceReviewId: "img-many", shopId: m.shopId } }, orderBy: { position: "asc" } });
    assert.deepEqual(many.map((i) => i.position), [0, 1, 2, 3, 4]); // first five listed, sixth refused
    const bad = A(j).problems.find((p) => p.record === 2)!;
    // Listed order decides: the first five references are checked, everything after the fifth is refused.
    assert.deepEqual(bad.images, ["invalid_path", "invalid_path", "invalid_path", "invalid_path", "remote_images_not_supported", ...Array(5).fill("too_many_images")]);
    assert.equal(await owner.reviewImage.count({ where: { review: { sourceReviewId: "img-bad", shopId: m.shopId } } }), 0);
    assert.equal(C(j).mediaAccepted, 5);
  });

  test("28 + 29 + 30 + 46. storage-limited photos: original kept privately, never public, strict date order, photo count excludes them", async () => {
    const s = await emptyShop("z");
    await addProducts(s, [P1]);
    // Fill the Free 500 MB public allowance completely (an earlier, already public photo).
    await withTenant(s.shopId, async ({ db, shopId }) => {
      const p = await db.product.findFirstOrThrow({ where: { shopId } });
      const r = await db.review.create({ data: { shopId, productId: p.id, source: "seed", sourceReviewId: "filler", rating: 5, body: "f", reviewerName: "F", reviewDate: new Date("2019-01-01"), status: "published" } });
      await db.reviewImage.create({ data: { shopId, reviewId: r.id, originalFilename: "f", storageKey: `s/${shopId}/originals/f.jpg`, thumbKey: "x", largeKey: "y", contentType: "image/jpeg", fileSize: 1, sha256: "f".repeat(64), publicBytes: 500 * 1024 ** 2, mediaStatus: "published" } });
    });
    const zip = zipOf({ "early-large.png": await png(30, 900), "late-small.png": await png(60, 20) });
    await importNow(s, [
      row({ review_id: "early", image_files: "early-large.png", review_date: "2024-01-01T00:00:00Z" }),
      row({ review_id: "late", image_files: "late-small.png", review_date: "2024-06-01T00:00:00Z" }),
    ], { images: zip });
    const imgs = await owner.reviewImage.findMany({ where: { shopId: s.shopId, review: { sourceReviewId: { in: ["early", "late"] } } }, include: { review: true } });
    assert.ok(imgs.every((i) => i.mediaStatus === "storage_limited"));
    for (const i of imgs) {
      assert.ok(await readPrivate(i.storageKey)); // original retained privately
      assert.equal((await run(() => mediaLoader(args<LoaderFunctionArgs>(new Request(`http://x/media/${i.publicId}-320.webp`), { "*": `${i.publicId}-320.webp` })))).response?.status, 404);
    }
    const body = JSON.stringify(await (await proxyList(args<LoaderFunctionArgs>(proxyRequest(s.domain, `products/${P1.id}/reviews`, { summary: "1" }), { id: String(P1.id) }))).json());
    for (const i of imgs) assert.ok(!body.includes(i.publicId));
    // The reviews themselves are public; photo-review count excludes storage-limited photos.
    assert.deepEqual(await publishedIds(s), ["early", "filler", "late"]);
    const p = await owner.product.findFirstOrThrow({ where: { shopId: s.shopId } });
    assert.equal(p.photoReviewCount, 1); // only the filler's public photo
    // Room only for the later, smaller photo: it must NOT jump ahead of the earlier, larger one.
    const early = imgs.find((i) => i.review.sourceReviewId === "early")!;
    const late = imgs.find((i) => i.review.sourceReviewId === "late")!;
    assert.ok(late.publicBytes < early.publicBytes);
    await owner.reviewImage.updateMany({ where: { shopId: s.shopId, sha256: "f".repeat(64) }, data: { publicBytes: 500 * 1024 ** 2 - late.publicBytes } });
    assert.deepEqual(await withTenant(s.shopId, (t) => releaseEligibleMedia(t)), { released: 0, stillLimited: 2 });
    await owner.reviewImage.updateMany({ where: { shopId: s.shopId, sha256: "f".repeat(64) }, data: { publicBytes: 1 } });
    assert.deepEqual(await withTenant(s.shopId, (t) => releaseEligibleMedia(t)), { released: 2, stillLimited: 0 });
  });

  test("31. photos of hidden (or pending / rejected) imported reviews are never served", async () => {
    const zip = zipOf({ "h.png": await png(120), "p.png": await png(140) });
    await importNow(m, [row({ review_id: "hid", status: "hidden", image_files: "h.png" }), row({ review_id: "pen", status: "pending", image_files: "p.png" })], { images: zip });
    const imgs = await owner.reviewImage.findMany({ where: { shopId: m.shopId, review: { sourceReviewId: { in: ["hid", "pen"] } } } });
    assert.equal(imgs.length, 2);
    for (const i of imgs) assert.equal((await run(() => mediaLoader(args<LoaderFunctionArgs>(new Request(`http://x/media/${i.publicId}-320.webp`), { "*": `${i.publicId}-320.webp` })))).response?.status, 404);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Limits, privacy, aggregates and the rating cache", () => {
  test("38. oversized CSV and archive are refused before anything is stored", async () => {
    const m = await emptyShop("aa");
    await assert.rejects(createImport(m.shopId, { csv: Buffer.alloc(IMPORT_LIMITS.csvBytes + 1, 0x61), options: { publishMode: "publish" }, actor: "x" }), (e: unknown) => e instanceof ImportError && e.code === "csv_too_large");
    await assert.rejects(createImport(m.shopId, { csv: csvOf([row()]), images: { length: IMPORT_LIMITS.archiveBytes + 1 } as Buffer, options: { publishMode: "publish" }, actor: "x" }), (e: unknown) => e instanceof ImportError && e.code === "archive_too_large");
    await assert.rejects(createImport(m.shopId, { csv: csvOf([row()]), images: Buffer.from("not a zip"), options: { publishMode: "publish" }, actor: "x" }), (e: unknown) => e instanceof ImportError && e.code === "archive_invalid");
    assert.equal(await owner.importJob.count({ where: { shopId: m.shopId } }), 0);
  });

  test("49 + 50. no reviewer email and no customer/order identity is ever stored or reported", async () => {
    const m = await emptyShop("ab");
    await addProducts(m, [P1]);
    const j = await importNow(m, [row({ email: "reviewer@example.com", customer_email: "c@example.com", customer_id: "12345", order_id: "98765", phone: "+1 555 0100" })]);
    const [r] = await reviewsOf(m);
    assert.equal(r.shopifyCustomerId, null);
    assert.equal(r.shopifyOrderId, null);
    const all = JSON.stringify({ r, j, audits: await owner.auditLog.findMany({ where: { shopId: m.shopId } }) }, (_k, v) => (typeof v === "bigint" ? String(v) : v));
    for (const s of ["reviewer@example.com", "c@example.com", "12345", "98765", "555 0100"]) assert.ok(!all.includes(s), s);
  });

  test("45 + 47 + 48. aggregates use the one aggregate path; the Proofly-managed cache is synced; unmanaged ratings are untouched", async () => {
    const m = await emptyShop("ac");
    await addProducts(m, [P1, P2]);
    const shopify = new FakeShopify();
    shopify.setRating(P2.id, "4.41", 68); // another app's rating on P2
    const { jobId } = await createImport(m.shopId, { csv: csvOf([row({ rating: "5" }), row({ rating: "3" }), row({ product_id: String(P2.id), status: "pending" })]), options: { publishMode: "publish" }, actor: "x", skuLookup: null });
    await runImport(m.shopId, jobId, { graphql: shopify.graphql });
    const p1 = await owner.product.findFirstOrThrow({ where: { shopId: m.shopId, shopifyProductId: P1.id } });
    const agg = await withTenant(m.shopId, (t) => computeAggregate(t, p1.id));
    assert.deepEqual([p1.reviewCount, Number(p1.averageRating)], [agg.reviewCount, agg.averageRating]);
    assert.deepEqual([agg.reviewCount, agg.averageRating], [2, 4]);
    assert.equal(p1.ratingOwnership, "proofly_managed");
    assert.deepEqual(shopify.rating(P1.id), { average: "4.00", count: 2 });
    assert.deepEqual(shopify.rating(P2.id), { average: "4.41", count: 68 }); // pending only → still unmanaged
    assert.ok(!shopify.calls.some((c) => JSON.stringify(c.variables ?? {}).includes(`Product/${P2.id}`)));
  });

  test("51. the network guard is active for the whole suite", async () => {
    await assert.rejects(fetch("https://example.com/"), /network access blocked in tests/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Synthetic fixture end to end (~1,150 reviews, 90 products, 160 images)", () => {
  test("imports with the exact expected outcome on Free", async () => {
    const dir = path.resolve("fixtures/synthetic");
    const exp = JSON.parse(await readFile(path.join(dir, "expectations.json"), "utf8"));
    const catalogue = JSON.parse(await readFile(path.join(dir, "catalogue.json"), "utf8")) as { id: string; handle: string; title: string; skus: string[] }[];
    const m = await emptyShop("ad");
    await setPlan(m, null);
    await addProducts(m, catalogue.map((p) => ({ id: BigInt(p.id), handle: p.handle, title: p.title })));
    const shopify = new FakeShopify();
    for (const p of catalogue) for (const s of p.skus) shopify.skus.set(s, [BigInt(p.id)]);
    const files: Record<string, Buffer> = {};
    for (const f of await readdir(path.join(dir, "images"))) files[f] = await readFile(path.join(dir, "images", f));
    const { jobId } = await createImport(m.shopId, { csv: await readFile(path.join(dir, "reviews.csv")), images: zipOf(files), options: { publishMode: "publish", source: "synthetic" }, actor: "test", skuLookup: skuLookupFromAdmin(shopify.graphql) });
    await runImport(m.shopId, jobId);
    const j = (await getImport(m.shopId, jobId))!;
    assert.equal(j.status, "completed_with_warnings");
    assert.equal(A(j).totalRows, exp.reviews);
    assert.equal(A(j).unmatchedRows, exp.unmatched_rows);
    assert.equal(A(j).ambiguousRows, 0);
    assert.equal(A(j).invalidRows, exp.invalid_rating + exp.invalid_date);
    assert.equal(C(j).imported, exp.reviews - exp.unmatched_rows - exp.invalid_rating - exp.invalid_date);
    assert.equal(C(j).published, 100);
    assert.equal(C(j).planLimited, exp.plan_limited_under_free);
    assert.equal(C(j).published + C(j).planLimited, exp.importable_published);
    const titleOnly = j.matches.filter((x) => x.reason === "title_only_needs_confirmation");
    assert.equal(titleOnly.length, 9); // 8 unique titles + 1 shared title
    assert.ok(titleOnly.every((x) => x.status === "unmatched" && x.productId === null));
    assert.ok(C(j).mediaRejected >= exp.images_missing + exp.images_corrupt);
    assert.ok(await owner.review.count({ where: { shopId: m.shopId, flags: { has: "cross_product_repeat" } } }) >= exp.cross_product_rows - 5);
    assert.ok(await owner.review.count({ where: { shopId: m.shopId, flags: { has: "possible_duplicate" } } }) >= exp.duplicate_same_product_extra_rows);
  });
});
