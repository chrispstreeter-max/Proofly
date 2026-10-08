// Checkpoint 9: privacy, retention and export — review export (CSV), shop/redact deletion, compliance webhooks,
// import-file retention, import files only in the database, stale imports, rate-limit purge. Offline; network guard.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import { exportReviewsCsv } from "../app/lib/export.server";
import { createImport, getImport, resolveProductMatch, runImport } from "../app/lib/import.server";
import { runMaintenance } from "../app/lib/maintenance.server";
import { markUninstalled, redactShop, withTenant } from "../app/lib/tenant.server";
import { loader as exportLoader } from "../app/routes/app.reviews.export";
import { action as complianceWebhook } from "../app/routes/webhooks.compliance";
import { adminRequest, args, installMerchant, owner, resetDb, reviewsIn, run, SAME_HANDLE, SAME_PRODUCT_ID, seedReview, storeOf, webhookRequest, type Merchant } from "./helpers";

let A: Merchant, B: Merchant;
before(async () => {
  await resetDb();
  A = await installMerchant("proofly-test-pa.myshopify.com", "PA");
  B = await installMerchant("proofly-test-pb.myshopify.com", "PB");
});
after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

/** Whether an import's uploaded CSV is still stored (in the database — Proofly has no file storage). */
const hasFile = async (jobId: string) => !!(await owner.importFile.findUnique({ where: { importJobId: jobId }, select: { importJobId: true } }));
const csvOf = (rows: string[][]) => Buffer.from(rows.map((r) => r.join(",")).join("\n"));
const DAY = 86_400_000;

describe("Review export", () => {
  test("all of the shop's reviews, any status, with reply and plan-limit flag; formula cells neutralised", async () => {
    await seedReview(A.api, {
      productId: SAME_PRODUCT_ID, source: "csv", sourceReviewId: "exp-2", rating: 2, title: "=HYPERLINK(\"http://x\")", body: "+cmd, \"quoted\"\nline",
      reviewerName: "@Kim", reviewDate: new Date("2025-02-01T00:00:00Z"), status: "hidden", held: true,
    });
    const csv = await exportReviewsCsv(A.api);
    const lines = csv.trim().split("\n");
    assert.equal(lines[0], "review_id,product_id,product_handle,product_title,rating,title,body,reviewer_name,review_date,status,plan_limited,reply,source,imported,verified_purchase,edited_outside_proofly");
    assert.match(csv, /Reply from store PA/);
    assert.match(csv, /exp-2,9000000000001,fixture-product,.*,2,"'=HYPERLINK\(""http:\/\/x""\)","'\+cmd, ""quoted""\nline",'@Kim,2025-02-01T00:00:00.000Z,hidden,yes,/);
    assert.doesNotMatch(csv, /PB/); // never another shop's data
    assert.doesNotMatch(csv, /s\/[0-9a-f-]{36}\//); // never a private storage key
  });

  test("route: authenticated shop only, CSV download, audited", async () => {
    const r = await run(() => exportLoader(args<LoaderFunctionArgs>(adminRequest(B.domain, "/app/reviews/export"))));
    assert.equal(r.response?.status, 200);
    assert.match(r.response!.headers.get("Content-Disposition")!, /attachment; filename="proofly-reviews-/);
    assert.equal(r.response!.headers.get("Cache-Control"), "no-store");
    const body = await r.response!.text();
    assert.match(body, /Fictional review body for store PB/);
    assert.doesNotMatch(body, /store PA/);
    assert.equal(await owner.auditLog.count({ where: { shopId: B.shopId, action: "reviews.exported" } }), 1);
    for (const auth of [undefined, "Bearer not-a-token"]) {
      const anon = await run(() => exportLoader(args<LoaderFunctionArgs>(new Request(`${process.env.SHOPIFY_APP_URL}/app/reviews/export`, { headers: auth ? { Authorization: auth } : {} }))));
      assert.ok(anon.response && !anon.data);
      assert.doesNotMatch(anon.response.headers.get("Content-Type") ?? "", /csv/); // the auth bounce/redirect, never the file
      assert.doesNotMatch(await anon.response.text(), /Fictional review body/);
    }
  });

  test("the export re-imports into the same store without duplicating reviews from that source", async () => {
    const csv = await exportReviewsCsv(A.api);
    const before = (await reviewsIn(A.api)).length;
    const { jobId } = await createImport(A.shopId, { csv: Buffer.from(csv), options: { publishMode: "publish" }, actor: "test" });
    await runImport(A.api, jobId);
    const j = (await getImport(A.shopId, jobId))!;
    assert.equal((j.counts as { imported: number }).imported, 0);
    assert.equal((await reviewsIn(A.api)).length, before);
  });
});

describe("Retention (scheduled maintenance)", () => {
  // Real-Shopify finding (dev database, 2026-10-04): a shop whose token Shopify refused (404) crashed the whole run, so
  // no later shop got retention, recounts or projection retries.
  test("a shop whose Shopify calls fail is skipped and reported; every other shop is still maintained", async () => {
    await owner.auditLog.deleteMany({ where: { action: "reviews.recounted", shopId: { in: [A.shopId, B.shopId] } } });
    const broken = { shopId: A.shopId, graphql: async () => { throw new Error("Received an error response (404) from Shopify"); } };
    const ids = (await owner.shop.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((x) => x.id);
    const r = await runMaintenance(new Date(), async (shopId) => (shopId === A.shopId ? broken : shopId === B.shopId ? B.api : null));
    assert.equal(r.shops, ids.length);
    assert.equal(r.failedShops, 1);
    assert.equal(r.recounted, 1);
    assert.ok(await owner.auditLog.findFirst({ where: { shopId: B.shopId, action: "reviews.recounted" } }), "B was recounted after A failed");
  });

  test("import files: kept while products are unresolved; deleted 30 days after a resolved import finishes", async () => {
    const rows = [["review_id", "product_handle", "rating", "body", "reviewer_name", "review_date"], ["ret-1", SAME_HANDLE, "5", "ok", "Kim", "2025-01-01"], ["ret-2", "no-such-product", "4", "ok", "Lee", "2025-01-02"]];
    const { jobId: open } = await createImport(B.shopId, { csv: csvOf(rows), options: { publishMode: "publish" }, actor: "test" });
    await runImport(B.api, open);
    const { jobId: clean } = await createImport(B.shopId, { csv: csvOf(rows.slice(0, 2).map((r, i) => (i ? ["ret-3", ...r.slice(1)] : r))), options: { publishMode: "publish" }, actor: "test" });
    await runImport(B.api, clean);
    const { jobId: recent } = await createImport(B.shopId, { csv: csvOf(rows.slice(0, 2).map((r, i) => (i ? ["ret-4", ...r.slice(1)] : r))), options: { publishMode: "publish" }, actor: "test" });
    await runImport(B.api, recent);
    await owner.importJob.updateMany({ where: { id: { in: [open, clean] } }, data: { finishedAt: new Date(Date.now() - 31 * DAY) } });
    assert.deepEqual([await hasFile(open), await hasFile(clean), await hasFile(recent)], [true, true, true]);

    const r = await runMaintenance();
    assert.equal(r.importFilesDeleted, 1);
    const after1 = await owner.importJob.findUniqueOrThrow({ where: { id: clean } });
    assert.deepEqual([await hasFile(clean), !!after1.filesDeletedAt], [false, true]);
    assert.ok(await hasFile(open), "unresolved product: rows exist only in the file — kept");
    assert.ok(await hasFile(recent), "finished less than 30 days ago — kept");
    assert.equal((await reviewsIn(B.api)).filter((r) => ["ret-1", "ret-3"].includes(r.sourceReviewId)).length, 2, "reviews are never touched");

    const ref = (await owner.importProductMatch.findFirstOrThrow({ where: { importJobId: open, status: "unmatched" } })).sourceProductRef;
    await resolveProductMatch(B.shopId, open, ref, null, "test"); // merchant skips → nothing left to resolve
    await runMaintenance();
    assert.equal(await hasFile(open), false);
    const page = (await getImport(B.shopId, open))!;
    assert.ok(page.filesDeletedAt);
  });

  test("no orphan files exist: a file belongs to its import (same shop) and goes with it; no file storage is used", async () => {
    const { jobId } = await createImport(A.shopId, { csv: csvOf([["review_id", "product_handle", "rating", "body", "reviewer_name", "review_date"], ["orph-1", SAME_HANDLE, "5", "ok", "Kim", "2025-01-01"]]), options: { publishMode: "publish" }, actor: "test" });
    assert.ok(await hasFile(jobId));
    // Without its import (or with another shop's import) a file can't exist.
    await assert.rejects(owner.importFile.create({ data: { shopId: A.shopId, importJobId: "00000000-0000-4000-8000-000000000000", data: new Uint8Array(1) } }));
    await assert.rejects(owner.importFile.create({ data: { shopId: B.shopId, importJobId: A.importJobId, data: new Uint8Array(1) } }));
    await owner.importJob.update({ where: { id: jobId }, data: { status: "cancelled" } });
  });

  test("an import whose worker stopped is marked failed (resumable); counters older than a day are purged", async () => {
    const job = await withTenant(A.shopId, ({ db, shopId }) => db.importJob.create({ data: { shopId, source: "csv", status: "running", heartbeatAt: new Date(Date.now() - 3_600_000) } }));
    const live = await withTenant(B.shopId, ({ db, shopId }) => db.importJob.create({ data: { shopId, source: "csv", status: "running", heartbeatAt: new Date() } }));
    await owner.rateLimit.createMany({ data: [{ key: "old", windowStart: new Date(Date.now() - 2 * DAY), count: 1 }, { key: "new", windowStart: new Date(), count: 1 }] });
    await runMaintenance();
    const j = await owner.importJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(j.status, "failed");
    assert.match(j.error!, /Resume/);
    assert.equal((await owner.importJob.findUniqueOrThrow({ where: { id: live.id } })).status, "running");
    const keys = (await owner.rateLimit.findMany({ select: { key: true } })).map((x) => x.key);
    assert.ok(keys.includes("new") && !keys.includes("old"));
    await owner.importJob.updateMany({ where: { id: { in: [job.id, live.id] } }, data: { status: "cancelled" } });
  });
});

describe("Compliance webhooks", () => {
  test("customers/data_request and customers/redact: audited without storing the customer id (Proofly holds none)", async () => {
    const id = 7_123_456_789;
    for (const [topic, p] of [["customers/data_request", "/webhooks/compliance"], ["customers/redact", "/webhooks/compliance"]]) {
      const res = await complianceWebhook(args<ActionFunctionArgs>(webhookRequest(A.domain, topic, p, { shop_domain: A.domain, customer: { id, email: "kim@example.com" } })));
      assert.equal(res.status, 200);
    }
    const logs = await owner.auditLog.findMany({ where: { shopId: A.shopId, action: { in: ["customer.data_request", "customer.redact"] } } });
    assert.equal(logs.length, 2);
    for (const l of logs) assert.ok(!JSON.stringify(l).includes(String(id)) && !JSON.stringify(l).includes("example.com"));
    for (const l of logs) assert.deepEqual(Object.values(l.details as object).filter((v) => typeof v === "number" && v > 0), []); // nothing linked
    const raw = [...storeOf(A.domain).metaobjects.values()].flatMap((m) => [...m.fields.keys()]);
    assert.deepEqual(raw.filter((k) => /customer|email|order|ip/i.test(k)), []); // no customer data in the stored reviews either
  });

  test("a compliance webhook without a valid HMAC changes nothing", async () => {
    const bad = webhookRequest(A.domain, "shop/redact", "/webhooks/compliance");
    bad.headers.set("X-Shopify-Hmac-Sha256", "AAAA");
    const r = await run(() => complianceWebhook(args<ActionFunctionArgs>(bad)));
    assert.equal(r.response?.status, 401);
    assert.ok(await owner.shop.findUnique({ where: { id: A.shopId } }));
  });
});

describe("shop/redact — permanent deletion", () => {
  test("ignored while the shop is installed (or reinstalled)", async () => {
    const res = await complianceWebhook(args<ActionFunctionArgs>(webhookRequest(A.domain, "shop/redact", "/webhooks/compliance", { shop_domain: A.domain })));
    assert.equal(res.status, 200);
    assert.ok(await owner.shop.findUnique({ where: { id: A.shopId } }));
    assert.ok((await reviewsIn(A.api)).length > 0);
  });

  test("after uninstall: every row and stored object of the shop is deleted; the other shop is untouched", async () => {
    await owner.importFile.createMany({ data: [A, B].map((m) => ({ shopId: m.shopId, importJobId: m.importJobId, data: new Uint8Array(Buffer.from("a")) })), skipDuplicates: true });
    const bRows = (await reviewsIn(B.api)).length;
    await markUninstalled(A.domain);
    const res = await complianceWebhook(args<ActionFunctionArgs>(webhookRequest(A.domain, "shop/redact", "/webhooks/compliance", { shop_domain: A.domain })));
    assert.equal(res.status, 200);

    assert.equal(await owner.shop.count({ where: { id: A.shopId } }), 0);
    const left = await owner.$queryRawUnsafe<{ t: string; n: bigint }[]>(`
      SELECT c.relname AS t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I WHERE shop_id = %L', c.relname, '${A.shopId}'), false, true, '')))[1]::text::bigint AS n
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'shop_id' WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace`);
    assert.ok(left.length >= 6);
    assert.deepEqual(left.filter((x) => x.n > 0n), []);
    assert.equal(await owner.session.count({ where: { shop: A.domain } }), 0);
    assert.equal(await hasFile(A.importJobId), false); // its import files too (counted in the loop above)

    assert.equal((await reviewsIn(B.api)).length, bRows);
    // The merchant's reviews are its data in its own Shopify store: shop/redact deletes Proofly's records, not the store's.
    assert.equal((await reviewsIn(A.api)).length > 0, true);
    assert.equal(await hasFile(B.importJobId), true);

    const del = await owner.shopDeletion.findFirstOrThrow({ where: { domainHash: createHash("sha256").update(A.domain).digest("hex") } });
    assert.ok(!JSON.stringify(del).includes(A.domain), "the deletion record holds no shop domain");
  });

  test("redelivery is a no-op; the deletion record is append-only for the app role", async () => {
    assert.deepEqual(await redactShop(A.domain), { deleted: false, reason: "unknown_or_already_deleted" });
    assert.equal(await owner.shopDeletion.count(), 1);
    await assert.rejects(prisma.shopDeletion.deleteMany({}), /permission denied/);
    await assert.rejects(prisma.shopDeletion.updateMany({ data: { details: {} } }), /permission denied/);
  });
});

describe("Public legal pages (App Store listing links)", () => {
  test("/privacy, /terms and /support load without login and state the facts the listing relies on", async () => {
    const { loader: privacy } = await import("../app/routes/privacy");
    const { loader: terms } = await import("../app/routes/terms");
    const { loader: support } = await import("../app/routes/support");
    const text = async (r: Response) => { assert.equal(r.status, 200); assert.match(r.headers.get("Content-Type") ?? "", /text\/html/); return r.text(); };
    const p = await text(privacy()), t = await text(terms()), s = await text(support());
    for (const page of [p, t, s]) assert.ok(page.includes(`mailto:${process.env.SUPPORT_EMAIL}`));
    assert.match(p, /stored in the merchant's own Shopify store/);
    assert.match(p, /does not ask for an email address/);
    assert.match(p, /48 hours after uninstall/);
    assert.match(t, /Render[^.]*Neon/);
    assert.doesNotMatch(p + t + s, /<script/);
  });
});
