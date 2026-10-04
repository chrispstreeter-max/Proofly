// Checkpoint 8: guided import — manual product matching (merchant-confirmed, shop-scoped, re-used), re-import of newly
// matched rows, problem report, column mapping, SSRF-safe remote images. Offline (FakeShopify + injected transports).
import assert from "node:assert/strict";
import https from "node:https";
import { after, before, beforeEach, describe, test } from "node:test";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import sharp from "sharp";
import prisma from "../app/db.server";
import { createImport, getImport, ImportError, importProblemReport, refreshAnalysis, resolveProductMatch, runImport } from "../app/lib/import.server";
import { fetchRemoteImage, isPublicAddress, RemoteImageError, type Transport } from "../app/lib/remote-image.server";
import { withTenant } from "../app/lib/tenant.server";
import { action as detailAction, loader as detailLoader } from "../app/routes/app.imports.$id";
import { loader as reportLoader } from "../app/routes/app.imports.$id_.report";
import { action as uploadAction } from "../app/routes/app.imports._index";
import { adminRequest, args, installMerchant, owner, resetDb, run, type Merchant } from "./helpers";

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
    await runImport(A.shopId, jobId);
    job = (await getImport(A.shopId, jobId))!;
    assert.equal((job.counts as { imported: number }).imported, 2);
    const m = job.matches.find((x) => x.method === "manual")!;
    assert.equal(m.productId, mug.id);
    assert.ok(await owner.review.findFirst({ where: { shopId: A.shopId, importJobId: jobId, productId: mug.id } }));
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
    await runImport(B.shopId, j);
    assert.equal(await owner.review.count({ where: { shopId: B.shopId, sourceReviewId: { in: ["re-1", "re-2"] } } }), 1);
    const before = await owner.review.findFirstOrThrow({ where: { shopId: B.shopId, sourceReviewId: "re-1" } });
    await resolveProductMatch(B.shopId, j, JSON.stringify({ id: "", handle: "renamed-lamp", sku: "", title: "" }), (await productOf(B, LAMP.id)).id, "x");
    const res = await run(() => detailAction(args<ActionFunctionArgs>(post(B, `/app/imports/${j}`, { intent: "reimport" }), { id: j })));
    const next = res.response!.headers.get("Location")!.split("/").pop()!;
    await runImport(B.shopId, next);
    const c = (await getImport(B.shopId, next))!.counts as Record<string, number>;
    assert.deepEqual([c.imported, c.alreadyImported], [1, 1]);
    assert.deepEqual(await owner.review.findFirstOrThrow({ where: { shopId: B.shopId, sourceReviewId: "re-1" } }), before);
  });
});

describe("Problem report and column mapping", () => {
  test("the report lists every unimported row with a plain-English reason, never the review text; shop-scoped", async () => {
    const { jobId } = await createImport(A.shopId, { csv: csv([row({ product_handle: MUG.handle, rating: "9", body: "SECRET BODY TEXT" }), row({ product_handle: MUG.handle, image_files: "http://example.com/x.jpg" })]), options: { publishMode: "publish" }, actor: "test" });
    const res = await run(() => reportLoader(args<LoaderFunctionArgs>(adminRequest(A.domain, `/app/imports/${jobId}/report`), { id: jobId })));
    const r = res.response!;
    assert.equal(r.headers.get("Content-Type"), "text/csv; charset=utf-8");
    assert.match(r.headers.get("Content-Disposition")!, /attachment/);
    const text = await r.text();
    assert.match(text, /^record,review_id,product_id,product_handle,sku,product_title,problem,explanation\n/);
    assert.match(text, /invalid_rating,The rating must be a whole number from 1 to 5\./);
    assert.match(text, /insecure_url,Photo links must start with https:\/\/\./);
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

describe("Remote images (SSRF-safe)", () => {
  test("only globally routable unicast addresses are allowed", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "2a00:1450:4009::200e"]) assert.equal(isPublicAddress(ip), true, ip);
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.51.100.7", "203.0.113.5",
      "::1", "::", "fc00::1", "fd12::3", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2001:db8::1", "2002:a00:1::", "not-an-ip", "1.2.3"]) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
  });

  const png = () => sharp({ create: { width: 30, height: 30, channels: 3, background: "#468" } }).png().toBuffer();
  const fake = (o: { addrs?: Record<string, string[]>; responses?: Record<string, { status: number; location?: string; body?: Buffer; length?: number }> }) => {
    const seen: { host: string; address: string }[] = [];
    const t: Transport = {
      lookup: async (host) => (o.addrs?.[host] ?? ["93.184.216.34"]).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
      get: async ({ url, address }) => {
        seen.push({ host: url.hostname, address });
        const r = o.responses?.[url.href] ?? { status: 404 };
        return { status: r.status, location: r.location, length: r.length, body: (async function* () { if (r.body) yield r.body; })(), abort: () => {} };
      },
    };
    return { t, seen };
  };

  test("downloads over https from public addresses, pinned to the vetted address; follows safe redirects", async () => {
    const img = await png();
    const { t, seen } = fake({ responses: { "https://cdn.example.com/a.png": { status: 302, location: "/b.png" }, "https://cdn.example.com/b.png": { status: 200, body: img } } });
    assert.deepEqual(await fetchRemoteImage("https://cdn.example.com/a.png", { maxBytes: 1e6, transport: t }), img);
    assert.deepEqual(seen.map((s) => s.address), ["93.184.216.34", "93.184.216.34"]);
  });

  test("refuses private/rebinding DNS answers, private redirects, http, other ports, credentials, oversize, loops", async () => {
    const big = Buffer.alloc(2_000);
    const cases: [string, Parameters<typeof fake>[0], string][] = [
      ["https://internal.example.com/x.png", { addrs: { "internal.example.com": ["10.1.2.3"] } }, "blocked_address"],
      ["https://mixed.example.com/x.png", { addrs: { "mixed.example.com": ["93.184.216.34", "127.0.0.1"] } }, "blocked_address"],
      ["https://169.254.169.254/latest/meta-data", {}, "blocked_address"],
      ["https://[::1]/x.png", {}, "blocked_address"],
      ["https://cdn.example.com/r", { responses: { "https://cdn.example.com/r": { status: 301, location: "https://10.0.0.5/x.png" } } }, "blocked_address"],
      ["https://cdn.example.com/r2", { responses: { "https://cdn.example.com/r2": { status: 302, location: "http://cdn.example.com/x.png" } } }, "insecure_url"],
      ["http://cdn.example.com/x.png", {}, "insecure_url"],
      ["https://cdn.example.com:8443/x.png", {}, "invalid_port"],
      [`https://user:pw${"@"}cdn.example.com/x.png`, {}, "invalid_url"], // credentials in the URL
      ["https://cdn.example.com/big", { responses: { "https://cdn.example.com/big": { status: 200, length: 5_000_000 } } }, "too_large"],
      ["https://cdn.example.com/stream", { responses: { "https://cdn.example.com/stream": { status: 200, body: big } } }, "too_large"],
      ["https://cdn.example.com/missing", {}, "http_404"],
      ["https://cdn.example.com/loop", { responses: { "https://cdn.example.com/loop": { status: 302, location: "/loop" } } }, "too_many_redirects"],
    ];
    for (const [url, o, code] of cases) {
      await assert.rejects(fetchRemoteImage(url, { maxBytes: 1_000, transport: fake(o).t }), (e: unknown) => e instanceof RemoteImageError && e.code === code, url);
    }
  });

  test("imports photos referenced by https URL; failures are reported per row without the URL", async () => {
    const img = await png();
    const fetchImage = async (url: string) => { if (url.endsWith("/ok.png")) return img; throw new RemoteImageError("blocked_address"); };
    const { jobId } = await createImport(A.shopId, { csv: csv([row({ product_handle: MUG.handle, image_files: "https://cdn.example.com/ok.png;https://cdn.example.com/private.png" })]), options: { publishMode: "publish" }, actor: "test" });
    await runImport(A.shopId, jobId, { fetchImage });
    const c = (await getImport(A.shopId, jobId))!.counts as Record<string, number>;
    assert.deepEqual([c.mediaAccepted, c.mediaRejected], [1, 1]);
    const report = (await importProblemReport(A.shopId, jobId))!;
    assert.match(report, /remote_blocked_address,The photo link could not be downloaded safely \(blocked address\)\./);
    assert.ok(!report.includes("cdn.example.com"));
  });

  test("the test network guard also blocks raw https sockets", async () => {
    await assert.rejects(new Promise((resolve, reject) => { https.get("https://example.com/", resolve).on("error", reject); }), /network access blocked in tests/);
  });
});
