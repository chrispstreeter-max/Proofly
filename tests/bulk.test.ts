// Phase 3: large imports and large plan releases write through Shopify bulk operations. Creation never overwrites an
// existing entry, results are matched by line number, an interrupted bulk operation is resumed (never re-sent), rows
// Shopify rejects are retried on resume, and a bulk release can never publish a review that changed meanwhile.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { ActionFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import { reconcileBilling } from "../app/lib/billing.server";
import { readStats, recountStats, releaseEligibleReviews } from "../app/lib/entitlements.server";
import { createImport, getImport, importReviews, runImport, type ImportRow } from "../app/lib/import.server";
import { moderate } from "../app/lib/moderation.server";
import { getReview, type StoredReview } from "../app/lib/review-store.server";
import { withTenant } from "../app/lib/tenant.server";
import { action as planAction } from "../app/routes/app.plan";
import { adminRequest, args, clearReviews, DOMAIN_A, installMerchant, owner, resetDb, reviewsIn, run, seedReview, storeOf, type Merchant } from "./helpers";

let A: Merchant;
const noSleep = async () => {};
const BULK = { bulkMinRows: 50, bulkRows: 100, sleep: noSleep }; // small thresholds: same code paths, fast tests
const setPlan = (handle: string | null) => {
  const s = storeOf(A.domain);
  s.subscriptions = handle ? [{ id: `gid://shopify/AppSubscription/${handle}`, name: handle, status: "ACTIVE", planHandle: handle }] : [];
  return reconcileBilling(A.shopId, s.graphql);
};
const newProduct = (id: bigint) =>
  withTenant(A.shopId, ({ db, shopId }) => db.product.create({ data: { shopId, shopifyProductId: id, handle: `p-${id}`, title: `P ${id}`, status: "active" } }));
const rows = (n: number, productId: bigint, prefix: string, o: (i: number) => Partial<ImportRow> = () => ({})): ImportRow[] =>
  Array.from({ length: n }, (_, i) => ({ sourceReviewId: `${prefix}-${i}`, shopifyProductId: productId, rating: (i % 5) + 1, body: `${prefix} body ${i}`, reviewerName: `R ${i}`, reviewDate: new Date(Date.UTC(2024, 0, 1) + i * 3_600_000), ...o(i) }));
const ops = (op: string) => storeOf(A.domain).ops(op).length;
const statsMatchShopify = async () => {
  const cached = await withTenant(A.shopId, (t) => readStats(t));
  assert.deepEqual(cached, await recountStats({ shopId: A.shopId, graphql: storeOf(A.domain).graphql }));
};

before(async () => {
  await resetDb();
  A = await installMerchant(DOMAIN_A, "A");
});
after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

describe("Large imports write in bulk", () => {
  test("chunks of bulk operations; exact outcome; results matched by line number (Shopify returns them out of order)", async () => {
    await clearReviews(A);
    await setPlan(null); // Free: 100
    const P = 9_700_000_000_001n;
    await newProduct(P);
    const stagedBefore = ops("ProoflyStageBulkInput");
    const intents = ["published", "published", "pending", "hidden", "rejected"] as const;
    const r = await importReviews(A.api, { source: "bulkcsv", rows: rows(250, P, "b", (i) => ({ status: intents[i % 5], reply: i % 7 === 0 ? `Reply ${i}` : undefined })), actor: "test", run: BULK });
    assert.equal(ops("ProoflyStageBulkInput") - stagedBefore, 3); // 100 + 100 + 50
    assert.deepEqual([r.imported, r.published, r.planLimited, r.notPublished], [250, 100, 0, 150]);
    const stored = (await reviewsIn(A.api)).filter((x) => x.source === "bulkcsv");
    assert.equal(stored.length, 250);
    assert.equal(new Set(stored.map((x) => x.handle)).size, 250); // no duplicates
    // Every entry carries exactly its own row's data (line numbers matched, not order).
    for (const x of stored) {
      const i = Number(x.sourceReviewId.split("-")[1]);
      assert.equal(x.body, `b body ${i}`);
      assert.equal(x.status, intents[i % 5]);
      assert.equal(x.reply, i % 7 === 0 ? `Reply ${i}` : null);
    }
    // Oldest 100 published rows are public (date order only); the other published rows are held.
    const published = stored.filter((x) => x.status === "published").sort((a, b) => +a.reviewDate - +b.reviewDate);
    assert.ok(published.slice(0, 100).every((x) => x.isPublic) && published.slice(100).every((x) => x.held && !x.isPublic));
    const job = await getImport(A.shopId, r.jobId);
    assert.equal((job!.counts as { repliesImported: number }).repliesImported, stored.filter((x) => x.reply).length);
    await statsMatchShopify();
  });

  test("bulk creation never overwrites an existing entry (Shopify search lag hid it from the existence check)", async () => {
    await clearReviews(A);
    const P = 9_700_000_000_002n;
    await newProduct(P);
    const existing = await seedReview(A.api, { productId: P, source: "lagcsv", sourceReviewId: "lag-3", status: "hidden", body: "moderated earlier" });
    const store = storeOf(A.domain);
    store.indexed.delete(existing.id); // search doesn't see it yet
    const r = await importReviews(A.api, { source: "lagcsv", rows: rows(60, P, "lag"), actor: "test", run: BULK });
    store.flushIndex();
    assert.deepEqual([r.imported, r.duplicates], [59, 1]); // TAKEN → already imported
    const after = (await getReview(A.api, existing.id))!;
    assert.deepEqual([after.status, after.body, after.importJobId], ["hidden", "moderated earlier", null]); // untouched
  });

  test("a crash after a bulk operation started: resuming collects that operation's results, never re-sends the chunk", async () => {
    await clearReviews(A);
    const P = 9_700_000_000_003n;
    await newProduct(P);
    const csv = ["review_id,product_id,rating,body,reviewer_name,review_date", ...rows(120, P, "crash").map((x) => `${x.sourceReviewId},${P},${x.rating},${x.body},${x.reviewerName},${x.reviewDate.toISOString()}`)].join("\n");
    const { jobId } = await createImport(A.shopId, { csv: Buffer.from(csv), options: { source: "crashcsv", publishMode: "publish" }, actor: "test" });
    await assert.rejects(runImport(A.api, jobId, { ...BULK, crashAfterBulkStart: true }), /simulated process failure/);
    const mid = await owner.importJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(mid.status, "failed");
    assert.equal(mid.cursor, 0);
    assert.ok((mid.bulkOperation as { id: string }).id); // recorded before waiting
    const stagedBefore = ops("ProoflyStageBulkInput");
    const done = (await runImport(A.api, jobId, BULK))!;
    assert.equal(ops("ProoflyStageBulkInput") - stagedBefore, 0); // chunk 1 not re-sent; the last 20 rows go one by one
    assert.equal((done.counts as { imported: number }).imported, 120);
    assert.equal((await reviewsIn(A.api)).filter((x) => x.source === "crashcsv").length, 120);
    assert.equal((await owner.importJob.findUniqueOrThrow({ where: { id: jobId } })).bulkOperation, null);
    await statsMatchShopify();
  });

  test("rows Shopify rejects stop the import before the cursor moves; resuming retries them; nothing is duplicated", async () => {
    await clearReviews(A);
    const P = 9_700_000_000_004n;
    await newProduct(P);
    const store = storeOf(A.domain);
    store.bulkFailLines = new Set([5, 17]);
    const csv = ["review_id,product_id,rating,body,reviewer_name,review_date", ...rows(60, P, "fail").map((x) => `${x.sourceReviewId},${P},${x.rating},${x.body},${x.reviewerName},${x.reviewDate.toISOString()}`)].join("\n");
    const { jobId } = await createImport(A.shopId, { csv: Buffer.from(csv), options: { source: "failcsv", publishMode: "publish" }, actor: "test" });
    try {
      await assert.rejects(runImport(A.api, jobId, BULK), /couldn't store 2 reviews/);
    } finally { store.bulkFailLines = new Set(); }
    const mid = await owner.importJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.deepEqual([mid.status, mid.cursor, (mid.counts as { imported: number }).imported], ["failed", 0, 58]);
    const done = (await runImport(A.api, jobId, BULK))!;
    assert.equal((done.counts as { imported: number }).imported, 60);
    const stored = (await reviewsIn(A.api)).filter((x) => x.source === "failcsv");
    assert.deepEqual([stored.length, new Set(stored.map((x) => x.handle)).size], [60, 60]);
    await statsMatchShopify();
  });

  // Real-Shopify finding (Proofly Test, 2026-10-04): resumed seconds after an interruption, the import's outcome missed
  // the reviews the first run wrote (search hadn't indexed them), so its report under-counted plan-limited reviews.
  test("an import resumed while search still lags counts and admits the reviews its earlier run wrote", async () => {
    await clearReviews(A);
    await setPlan(null);
    const P = 9_700_000_000_010n;
    await newProduct(P);
    const csv = ["review_id,product_id,rating,body,reviewer_name,review_date,reply", ...rows(6, P, "lagres").map((x, i) => `${x.sourceReviewId},${P},${x.rating},${x.body},${x.reviewerName},${x.reviewDate.toISOString()},${i < 2 ? "Reply" : ""}`)].join("\n");
    const { jobId } = await createImport(A.shopId, { csv: Buffer.from(csv), options: { source: "lagrescsv", publishMode: "publish" }, actor: "test" });
    const store = storeOf(A.domain);
    store.searchLag = true;
    try {
      await assert.rejects(runImport(A.api, jobId, { batchRows: 2, failAfterBatches: 1, sleep: noSleep }), /simulated process failure/);
      // Resumed at once: the first run's 2 entries are not searchable yet; they become so while finalize waits.
      const done = (await runImport(A.api, jobId, { batchRows: 2, sleep: async () => store.flushIndex() }))!;
      const c = done.counts as { imported: number; published: number; planLimited: number; repliesImported: number; repliesSuppressed: number; repliesVisible: number };
      assert.deepEqual([c.imported, c.published + c.planLimited, c.repliesImported, c.repliesVisible + c.repliesSuppressed], [6, 6, 2, 2]);
    } finally { store.searchLag = false; store.flushIndex(); }
    await statsMatchShopify();
  });

  test("while Shopify works, the import keeps its heartbeat (it is never mistaken for a dead worker)", async () => {
    await clearReviews(A);
    const P = 9_700_000_000_005n;
    await newProduct(P);
    const store = storeOf(A.domain);
    store.bulkPolls = 3;
    const sleeps: number[] = [];
    try {
      await importReviews(A.api, { source: "slowcsv", rows: rows(60, P, "slow"), actor: "test", run: { ...BULK, sleep: async (ms) => { sleeps.push(ms); } } });
    } finally { store.bulkPolls = 0; }
    assert.deepEqual(sleeps.slice(0, 3), [1_000, 2_000, 4_000]); // backoff between polls
  });
});

describe("Large plan releases write in bulk, and can only ever leave a review private", () => {
  test("upgrade + 'Publish eligible reviews' over the bulk threshold: oldest first, all public, counts exact", async () => {
    await clearReviews(A);
    await setPlan(null);
    const P = 9_700_000_000_006n;
    await newProduct(P);
    const r = await importReviews(A.api, { source: "relcsv", rows: rows(400, P, "rel"), actor: "test", run: BULK });
    assert.deepEqual([r.published, r.planLimited], [100, 300]);
    await setPlan("starter"); // 1,000: room for all 300 → over BULK_RELEASE_MIN → bulk
    const runsBefore = ops("ProoflyRunBulk");
    const rel = await releaseEligibleReviews(A.api, { actor: "test", sleep: noSleep });
    assert.equal(ops("ProoflyRunBulk") - runsBefore, 1);
    assert.deepEqual([rel.released, rel.stillHeld], [300, 0]);
    assert.ok((await reviewsIn(A.api)).filter((x) => x.source === "relcsv").every((x) => x.isPublic));
    const p = await owner.product.findFirstOrThrow({ where: { shopId: A.shopId, shopifyProductId: P } });
    assert.equal(p.reviewCount, 400);
    assert.equal(storeOf(A.domain).projection(P)!.summary.count, 400);
    await statsMatchShopify();
  });

  test("the Plan page runs a large 'Publish eligible reviews' in the background (it can take minutes in Shopify)", async () => {
    await clearReviews(A);
    await setPlan(null);
    const P = 9_700_000_000_009n;
    await newProduct(P);
    await importReviews(A.api, { source: "bgcsv", rows: rows(250, P, "bg"), actor: "test", run: BULK });
    await setPlan("starter");
    await owner.billingState.update({ where: { shopId: A.shopId }, data: { verifiedAt: new Date() } }); // no re-check
    const fd = new FormData();
    fd.set("intent", "publish_eligible");
    const res = await run(() => planAction(args<ActionFunctionArgs>(adminRequest(DOMAIN_A, "/app/plan", { method: "POST", body: fd }))));
    assert.match((res.data as { message: string }).message, /in the background/);
    for (let i = 0; i < 100 && (await withTenant(A.shopId, (t) => readStats(t))).planLimited > 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok((await reviewsIn(A.api)).filter((x) => x.source === "bgcsv").every((x) => x.isPublic));
    await statsMatchShopify();
  });

  test("a review hidden after the release was decided stays private; the reserved count is corrected", async () => {
    await clearReviews(A);
    await setPlan(null);
    const P = 9_700_000_000_007n;
    await newProduct(P);
    await importReviews(A.api, { source: "racecsv", rows: rows(250, P, "race"), actor: "test", run: BULK });
    await setPlan("starter");
    const held = (await reviewsIn(A.api)).filter((x) => x.source === "racecsv" && x.held);
    assert.equal(held.length, 150);
    const victim = held[0];
    await moderate(A.api, [victim.id], "hide", "test"); // the copies below are now stale for this one
    const rel = await releaseEligibleReviews(A.api, { reviews: held, actor: "test", sleep: noSleep });
    const now = (await getReview(A.api, victim.id))!;
    assert.equal(now.status, "hidden");
    assert.equal(now.isPublic, false);
    assert.equal(now.editedOutside, true); // flagged for the merchant, never public
    assert.equal(rel.released, 149);
    await statsMatchShopify();
  });

  test("a held review edited outside Proofly is never released (one by one or in bulk); only re-approval publishes it", async () => {
    await clearReviews(A);
    await setPlan("starter");
    const P = 9_700_000_000_008n;
    await newProduct(P);
    const small = await seedReview(A.api, { productId: P, status: "published", held: true, body: "held, then edited" });
    storeOf(A.domain).editOutside(small.id, { body: "edited in Shopify admin" });
    const r1 = await releaseEligibleReviews(A.api, { actor: "test" });
    assert.equal(r1.released, 0);
    assert.equal((await getReview(A.api, small.id))!.isPublic, false);
    const many: StoredReview[] = [];
    for (let i = 0; i < 120; i++) many.push(await seedReview(A.api, { productId: P, status: "published", held: true, body: `held ${i}`, reviewDate: new Date(Date.UTC(2023, 0, 1 + i)) }));
    storeOf(A.domain).editOutside(many[0].id, { body: "edited too" });
    const r2 = await releaseEligibleReviews(A.api, { reviews: [...many, (await getReview(A.api, small.id))!], actor: "test", sleep: noSleep });
    assert.equal(r2.released, 119);
    assert.equal((await getReview(A.api, many[0].id))!.isPublic, false);
    assert.equal((await getReview(A.api, small.id))!.isPublic, false);
    await statsMatchShopify();
  });
});
