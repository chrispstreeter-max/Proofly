// Checkpoint 8: guided import — manual product matching (merchant-confirmed, shop-scoped, re-used), re-import of newly
// matched rows, problem report, column mapping. Offline (FakeShopify).
import assert from "node:assert/strict";
import https from "node:https";
import { after, before, beforeEach, describe, test } from "node:test";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import { createImport, getImport, ImportError, importProblemReport, refreshAnalysis, resolveProductMatch, runImport } from "../app/lib/import.server";
import { withTenant } from "../app/lib/tenant.server";
import { action as detailAction, loader as detailLoader } from "../app/routes/app.imports.$id";
import { loader as reportLoader } from "../app/routes/app.imports.$id_.report";
import { action as uploadAction } from "../app/routes/app.imports._index";
import { adminRequest, args, installMerchant, owner, resetDb, reviewsIn, run, type Merchant } from "./helpers";

let A: Merchant, B: Merchant;
const MUG = { id: 9_870_000_000_001n, handle: "east-example-mug", title: "East Example Mug" };
const LAMP = { id: 9_870_000_000_002n, handle: "west-demo-lamp", title: "West Demo Lamp" };
let n = 0;
const csv = (rows: Record<string, string>[], cols?: string[]) => {
  const c = cols ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return Buffer.from([c.join(","), ...rows.map((r) => c.map((k) => r[k] ?? "").join(","))].join("\n"));
};
const row = (o: Record<string, string>) => ({ review_id: `g${++n}`, rating: "4", body: `Body ${n}`, reviewer_name: "Lee Example", review_date: `2024-02-${String((n % 27) + 1).padStart(2, "0")}`, ...o });
const productOf = (m: Merchant, id: bigint) => owner.product.findFirstOrThrow({ where: { shopId: m.shopId, shopifyProductId: id } });
/** One active import per shop is enforced; tests that leave an import queued release the slot here. */
const freeSlot = () => owner.importJob.updateMany({ where: { status: { in: ["queued", "running"] } }, data: { status: "cancelled" } });
beforeEach(freeSlot);
const post = (m: Merchant, path: string, fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return adminRequest(m.domain, path, { method: "POST", body: fd }); };

before(async () => {
  await resetDb();
  A = await installMerchant("proofly-test-ga.myshopify.com", "GA");
  B = await installMerchant("proofly-test-gb.myshopify.com", "GB");
  for (const m of [A, B]) await withTenant(m.shopId, ({ db, shopId }) => db.product.createMany({ data: [MUG, LAMP].map((p) => ({ shopId, shopifyProductId: p.id, handle: p.handle, title: p.title, status: "active" })) }));
  await owner.product.create({ data: { shopId: A.shopId, shopifyProductId: 9_870_000_000_009n, handle: "gone-mug", title: "Gone Mug", deletedAt: new Date() } });
});
after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

describe("Manual product matching", () => {
  let jobId: string;
  const titleRef = JSON.stringify({ id: "", handle: "", sku: "", title: "East Example Mug" }); // as given by the source

  test("a title-only reference is resolved only by the merchant's explicit choice; analysis and import follow it", async () => {
    ({ jobId } = await createImport(A.shopId, { csv: csv([row({ product_title: "East Example Mug" }), row({ product_handle: LAMP.handle })]), options: { publishMode: "publish" }, actor: "test" }));
    let job = (await getImport(A.shopId, jobId))!;
    assert.equal((job.analysis as { unmatchedRows: number }).unmatchedRows, 1);
    const mug = await productOf(A, MUG.id);
    await resolveProductMatch(A.shopId, jobId, titleRef, mug.id, "staff:1");
    assert.equal((await refreshAnalysis(A.shopId, jobId))!.unmatchedRows, 0);
    await runImport(A.api, jobId);
    job = (await getImport(A.shopId, jobId))!;
    assert.equal((job.counts as { imported: number }).imported, 2);
    const m = job.matches.find((x) => x.method === "manual")!;
    assert.equal(m.productId, mug.id);
    assert.ok((await reviewsIn(A.api)).find((r) => r.importJobId === jobId && r.productId === MUG.id));
    assert.ok(await owner.auditLog.findFirst({ where: { shopId: A.shopId, action: "import.match_confirmed", actor: "staff:1" } }));
  });

  test("only a live product of the authenticated shop can be chosen; another shop cannot touch the import", async () => {
    const { jobId: j } = await createImport(A.shopId, { csv: csv([row({ product_title: "West Demo Lamp" })]), options: { publishMode: "publish" }, actor: "test" });
    const ref = JSON.stringify({ id: "", handle: "", sku: "", title: "West Demo Lamp" });
    const bLamp = await productOf(B, LAMP.id);
    const gone = await owner.product.findFirstOrThrow({ where: { shopId: A.shopId, handle: "gone-mug" } });
    for (const bad of [bLamp.id, gone.id, "not-a-uuid", "00000000-0000-0000-0000-000000000000"]) {
      await assert.rejects(resolveProductMatch(A.shopId, j, ref, bad, "x"), (e: unknown) => e instanceof ImportError && e.code === "invalid_product", bad);
    }
    await assert.rejects(resolveProductMatch(B.shopId, j, ref, bLamp.id, "x"), (e: unknown) => e instanceof ImportError && e.code === "not_found");
    // Through the admin route, with B's product id supplied by the client:
    const res = await run(() => detailAction(args<ActionFunctionArgs>(post(A, `/app/imports/${j}`, { intent: "match", ref, productId: bLamp.id }), { id: j })));
    assert.equal((res.data as { message: string }).message, "Choose one of your store's products.");
    const fromB = await run(() => detailLoader(args<LoaderFunctionArgs>(adminRequest(B.domain, `/app/imports/${j}`), { id: j })));
    assert.equal(fromB.response?.status, 404);
    assert.equal(await owner.productMatchConfirmation.count({ where: { productId: bLamp.id } }), 0);
  });

  test("automatic matches cannot be overridden; skipping is explicit and explained", async () => {
    const { jobId: j } = await createImport(A.shopId, { csv: csv([row({ product_handle: MUG.handle }), row({ product_handle: "nothing-like-this" })]), options: { publishMode: "publish" }, actor: "test" });
    const auto = JSON.stringify({ id: "", handle: MUG.handle, sku: "", title: "" });
    await assert.rejects(resolveProductMatch(A.shopId, j, auto, (await productOf(A, LAMP.id)).id, "x"), (e: unknown) => e instanceof ImportError && e.code === "already_matched");
    const missing = JSON.stringify({ id: "", handle: "nothing-like-this", sku: "", title: "" });
    await resolveProductMatch(A.shopId, j, missing, null, "x");
    const csvReport = (await importProblemReport(A.shopId, j))!;
    assert.match(csvReport, /skipped_by_merchant,You chose to skip these reviews\./);
  });

  test("the problem report neutralises formulas coming from the uploaded file (CSV injection), like the review export", async () => {
    const { jobId: j } = await createImport(A.shopId, { csv: csv([row({ review_id: "-2+3+cmd|' /C calc'!A0", product_handle: "=HYPERLINK(\"http://x\")" })]), options: { publishMode: "publish" }, actor: "test" });
    const report = (await importProblemReport(A.shopId, j))!;
    const cells = report.trim().split("\n")[1];
    assert.ok(cells.includes(`'-2+3+cmd|' /C calc'!A0`), cells);
    assert.ok(cells.includes(`,'=hyperlink(http://x),`), cells); // handles are normalised, then neutralised
    assert.doesNotMatch(report, /(^|,)[=+\-@]/m);
  });

  test("confirmations are re-used by later imports of the same source — never over an automatic match, never across sources", async () => {
    const { jobId: j } = await createImport(A.shopId, { csv: csv([row({ product_title: "East Example Mug" })]), options: { publishMode: "publish" }, actor: "test" });
    const m = (await getImport(A.shopId, j))!.matches[0];
    assert.deepEqual([m.status, m.method], ["matched", "manual"]);
    await freeSlot();
    const { jobId: other } = await createImport(A.shopId, { csv: csv([row({ product_title: "East Example Mug" })]), options: { publishMode: "publish", source: "legacy" }, actor: "test" });
    assert.equal((await getImport(A.shopId, other))!.matches[0].status, "unmatched");
    // B never sees A's confirmation.
    const { jobId: bj } = await createImport(B.shopId, { csv: csv([row({ product_title: "East Example Mug" })]), options: { publishMode: "publish" }, actor: "test" });
    assert.equal((await getImport(B.shopId, bj))!.matches[0].status, "unmatched");
  });

  test("after an import, newly matched rows are imported by a re-import; existing rows are not touched", async () => {
    const rows = [row({ review_id: "re-1", product_handle: LAMP.handle }), row({ review_id: "re-2", product_handle: "renamed-lamp" })];
    const { jobId: j } = await createImport(B.shopId, { csv: csv(rows), options: { publishMode: "publish" }, actor: "test" });
    await runImport(B.api, j);
    assert.equal((await reviewsIn(B.api)).filter((r) => ["re-1", "re-2"].includes(r.sourceReviewId)).length, 1);
    const before = (await reviewsIn(B.api)).find((r) => r.sourceReviewId === "re-1")!;
    await resolveProductMatch(B.shopId, j, JSON.stringify({ id: "", handle: "renamed-lamp", sku: "", title: "" }), (await productOf(B, LAMP.id)).id, "x");
    const res = await run(() => detailAction(args<ActionFunctionArgs>(post(B, `/app/imports/${j}`, { intent: "reimport" }), { id: j })));
    const next = res.response!.headers.get("Location")!.split("/").pop()!;
    await runImport(B.api, next);
    const c = (await getImport(B.shopId, next))!.counts as Record<string, number>;
    assert.deepEqual([c.imported, c.alreadyImported], [1, 1]);
    assert.deepEqual((await reviewsIn(B.api)).find((r) => r.sourceReviewId === "re-1"), before);
  });
});

describe("Problem report and column mapping", () => {
  test("the report lists every unimported row with a plain-English reason, never the review text; shop-scoped", async () => {
    const { jobId } = await createImport(A.shopId, { csv: csv([row({ product_handle: MUG.handle, rating: "9", body: "SECRET BODY TEXT" }), row({ product_handle: MUG.handle, review_date: "31/12/2020" })]), options: { publishMode: "publish" }, actor: "test" });
    const res = await run(() => reportLoader(args<LoaderFunctionArgs>(adminRequest(A.domain, `/app/imports/${jobId}/report`), { id: jobId })));
    const r = res.response!;
    assert.equal(r.headers.get("Content-Type"), "text/csv; charset=utf-8");
    assert.match(r.headers.get("Content-Disposition")!, /attachment/);
    const text = await r.text();
    assert.match(text, /^record,review_id,product_id,product_handle,sku,product_title,problem,explanation\n/);
    assert.match(text, /invalid_rating,The rating must be a whole number from 1 to 5\./);
    assert.match(text, /invalid_date,"The date is missing, in the future, or in an unclear format\./);
    assert.ok(!text.includes("SECRET BODY TEXT"));
    assert.equal((await run(() => reportLoader(args<LoaderFunctionArgs>(adminRequest(B.domain, `/app/imports/${jobId}/report`), { id: jobId })))).response?.status, 404);
  });

  test("unrecognised headers → the merchant maps columns; the mapped upload is analysed", async () => {
    const file = csv([{ Stars: "5", Comment: "Mapped body", When: "2024-01-05", Slug: MUG.handle }]);
    const fd = new FormData(); fd.set("intent", "upload"); fd.set("csv", new File([file], "x.csv"));
    const first = await run(() => uploadAction(args<ActionFunctionArgs>(adminRequest(A.domain, "/app/imports", { method: "POST", body: fd }))));
    assert.deepEqual((first.data as { headers: string[] }).headers, ["Stars", "Comment", "When", "Slug"]);
    await freeSlot();
    const fd2 = new FormData(); fd2.set("intent", "upload"); fd2.set("csv", new File([file], "x.csv"));
    for (const [k, v] of Object.entries({ map_rating: "Stars", map_body: "Comment", map_reviewDate: "When", map_handle: "Slug" })) fd2.set(k, v);
    const second = await run(() => uploadAction(args<ActionFunctionArgs>(adminRequest(A.domain, "/app/imports", { method: "POST", body: fd2 }))));
    assert.equal(second.response?.status, 302);
    const job = await owner.importJob.findFirstOrThrow({ where: { shopId: A.shopId }, orderBy: { createdAt: "desc" } });
    assert.equal((job.analysis as { validRows: number }).validRows, 1);
  });
});

describe("Network guard", () => {
  test("the test network guard also blocks raw https sockets", async () => {
    await assert.rejects(new Promise((resolve, reject) => { https.get("https://example.com/", resolve).on("error", reject); }), /network access blocked in tests/);
  });
});
