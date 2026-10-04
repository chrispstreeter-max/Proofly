// Locked rule (checkpoint 6): TITLE IS NEVER AN AUTOMATIC PRODUCT-MATCHING KEY.
// Hierarchy: Shopify product ID → handle → SKU → other exact identifiers (none yet) → merchant-confirmed manual match
// (checkpoint 8). An exact (trimmed, case-insensitive) title match is only ever a suggestion for the merchant.
// "When identity is uncertain, Proofly does not guess."
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import * as importModule from "../app/lib/import.server";
import { createImport, getImport, matchProduct, runImport } from "../app/lib/import.server";
import { withTenant } from "../app/lib/tenant.server";
import { action as importsAction } from "../app/routes/app.imports._index";
import { loader as proxyList } from "../app/routes/proxy.products.$id.reviews";
import { adminRequest, args, installMerchant, owner, proxyRequest, resetDb, reviewsIn, run, type Merchant } from "./helpers";

let A: Merchant, B: Merchant;
const MUG = { id: 9_850_000_000_001n, handle: "north-example-mug", title: "North Example Mug" };
const TOTE = { id: 9_850_000_000_002n, handle: "south-sample-tote", title: "South Sample Tote" };
const TWIN1 = { id: 9_850_000_000_003n, handle: "twin-demo-lamp-1", title: "Twin Demo Lamp" };
const TWIN2 = { id: 9_850_000_000_004n, handle: "twin-demo-lamp-2", title: "Twin Demo Lamp" };
let n = 0;
const csv = (rows: Record<string, string>[]) => {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return Buffer.from([cols.join(","), ...rows.map((r) => cols.map((c) => r[c] ?? "").join(","))].join("\n"));
};
const row = (o: Record<string, string>) => ({ review_id: `t${++n}`, rating: "5", body: `Body ${n}`, reviewer_name: "Kim Example", review_date: "2025-03-01", ...o });
async function importRows(m: Merchant, rows: Record<string, string>[]) {
  const { jobId } = await createImport(m.shopId, { csv: csv(rows), options: { publishMode: "publish" }, actor: "test" });
  await runImport(m.api, jobId);
  return (await getImport(m.shopId, jobId))!;
}
type Cand = { productId: string; title: string; handle: string; via: string };

before(async () => {
  await resetDb();
  A = await installMerchant("proofly-test-ta.myshopify.com", "TA");
  B = await installMerchant("proofly-test-tb.myshopify.com", "TB");
  for (const m of [A, B]) {
    await withTenant(m.shopId, ({ db, shopId }) => db.product.createMany({ data: [MUG, TOTE, TWIN1, TWIN2].map((p) => ({ shopId, shopifyProductId: p.id, handle: p.handle, title: p.title, status: "active" })) }));
  }
});
after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

const productIdsOf = async (m: Merchant) => new Set((await owner.product.findMany({ where: { shopId: m.shopId }, select: { id: true } })).map((p) => p.id));

describe("Title is never an automatic product-matching key", () => {
  test("1. exact title-only match → unmatched; that product is a suggestion; no association", async () => {
    const j = await importRows(A, [row({ product_title: "  north EXAMPLE mug " })]);
    const [m] = j.matches;
    assert.deepEqual([m.status, m.method, m.productId, m.reason], ["unmatched", null, null, "title_only_needs_confirmation"]);
    const c = m.candidates as Cand[];
    assert.deepEqual(c.map((x) => [x.handle, x.via]), [[MUG.handle, "title"]]);
    assert.ok((await productIdsOf(A)).has(c[0].productId));
    assert.equal((await reviewsIn(A.api)).filter((r) => r.importJobId === j.id).length, 0);
  });

  test("2. several exact title matches → unmatched with every candidate (all this shop's), none selected", async () => {
    const j = await importRows(A, [row({ product_title: "Twin Demo Lamp" })]);
    const [m] = j.matches;
    assert.equal(m.status, "unmatched");
    assert.equal(m.productId, null);
    const c = m.candidates as Cand[];
    assert.deepEqual(c.map((x) => x.handle).sort(), [TWIN1.handle, TWIN2.handle]);
    const mine = await productIdsOf(A);
    assert.ok(c.every((x) => mine.has(x.productId)));
    assert.equal((await reviewsIn(A.api)).filter((r) => r.importJobId === j.id).length, 0);
  });

  test("3. a title never overrides a stronger identifier: handle → MUG wins over title → TOTE", async () => {
    const j = await importRows(A, [row({ product_handle: MUG.handle, product_title: TOTE.title })]);
    const [m] = j.matches;
    assert.deepEqual([m.status, m.method], ["matched", "handle"]);
    const mug = await owner.product.findFirstOrThrow({ where: { shopId: A.shopId, shopifyProductId: MUG.id } });
    assert.equal(m.productId, mug.id);
    const r = (await reviewsIn(A.api)).find((x) => x.importJobId === j.id)!;
    assert.equal(r.productId, MUG.id); // the review references the Shopify product the handle matched
    // And a failed or ambiguous identifier is never rescued by a title.
    const j2 = await importRows(A, [row({ product_id: "9850000000999", product_title: MUG.title }), row({ product_handle: "no-such-handle", product_title: MUG.title })]);
    assert.ok(j2.matches.every((x) => x.status !== "matched" && x.productId === null));
    assert.equal((await reviewsIn(A.api)).filter((r) => r.importJobId === j2.id).length, 0);
  });

  test("4. near / fuzzy titles: no match and no suggestion", async () => {
    for (const t of ["North Example Mugs", "North-Example Mug", "Nort Example Mug", "Example North Mug", "North Example"]) {
      const res = matchProduct(JSON.stringify({ id: "", handle: "", sku: "", title: t }), [{ id: "p", shopifyProductId: MUG.id, handle: MUG.handle, title: MUG.title, deletedAt: null }], null);
      assert.deepEqual([res.status, res.productId, res.candidates.length], ["unmatched", null, 0], t);
    }
  });

  test("5. cross-tenant title collision: A's suggestions are only A's products; B's never appear", async () => {
    const j = await importRows(A, [row({ product_title: MUG.title }), row({ product_title: TWIN1.title })]);
    const bIds = await productIdsOf(B);
    const aIds = await productIdsOf(A);
    for (const m of j.matches) for (const c of m.candidates as Cand[]) { assert.ok(aIds.has(c.productId)); assert.ok(!bIds.has(c.productId)); }
    assert.ok(!JSON.stringify(await getImport(A.shopId, j.id)).includes(B.shopId));
  });

  test("6. row order never turns a title-only row into a match", async () => {
    const rows = [row({ product_title: MUG.title }), row({ product_handle: TOTE.handle }), row({ product_title: TWIN1.title }), row({ product_id: String(MUG.id) })];
    const outcome = async (rs: typeof rows) => (await importRows(B, rs.map((r) => ({ ...r, review_id: `${r.review_id}-${rs === rows ? "f" : "r"}` })))).matches
      .map((m) => [JSON.stringify(m.ref), m.status, m.method]).sort();
    assert.deepEqual(await outcome(rows), await outcome([...rows].reverse()));
  });

  test("7. a title-only review can never appear on the storefront", async () => {
    const j = await importRows(A, [row({ product_title: MUG.title, body: "Title-only storefront probe" })]);
    assert.equal(j.matches[0].status, "unmatched");
    const res = await proxyList(args<LoaderFunctionArgs>(proxyRequest(A.domain, `products/${MUG.id}/reviews`), { id: String(MUG.id) }));
    assert.ok(!(await res.text()).includes("Title-only storefront probe"));
    assert.equal((await reviewsIn(A.api)).filter((r) => r.body === "Title-only storefront probe").length, 0);
  });

  // Updated in checkpoint 8: the manual-match function now exists (resolveProductMatch), as this decision anticipated —
  // so the test proves explicit confirmation is the ONLY way a title-only row gets associated, and only with a product
  // of the same shop.
  test("8. merchant-confirmed manual match: the only way to associate, and only with this shop's product", async () => {
    assert.equal(typeof importModule.resolveProductMatch, "function");
    const j = await importRows(A, [row({ product_title: MUG.title })]);
    const stored = await owner.importProductMatch.findFirstOrThrow({ where: { shopId: A.shopId, importJobId: j.id } });
    assert.equal(stored.status, "unmatched");
    assert.equal((stored.candidates as Cand[]).length, 1);
    const job = await owner.importJob.findUniqueOrThrow({ where: { id: j.id } });
    assert.ok(job.fileKey && job.fileKey.includes(`/imports/${j.id}/`)); // the source rows stay retrievable privately
    assert.ok(((job.analysis as { problems: { code: string }[] }).problems).some((p) => p.code === "product_unmatched"));
    const bMug = await owner.product.findFirstOrThrow({ where: { shopId: B.shopId, shopifyProductId: MUG.id } });
    await assert.rejects(importModule.resolveProductMatch(A.shopId, j.id, stored.sourceProductRef, bMug.id, "x"), /Choose one of your store's products/);
    const aMug = await owner.product.findFirstOrThrow({ where: { shopId: A.shopId, shopifyProductId: MUG.id } });
    await importModule.resolveProductMatch(A.shopId, j.id, stored.sourceProductRef, aMug.id, "staff:9");
    const after = await owner.importProductMatch.findFirstOrThrow({ where: { id: stored.id } });
    assert.deepEqual([after.status, after.method, after.productId], ["matched", "manual", aMug.id]);
  });

  test("security: a client cannot submit a product id (any shop's) as the selected match", async () => {
    const bTote = await owner.product.findFirstOrThrow({ where: { shopId: B.shopId, shopifyProductId: TOTE.id } });
    const aTote = await owner.product.findFirstOrThrow({ where: { shopId: A.shopId, shopifyProductId: TOTE.id } });
    const fd = new FormData();
    fd.set("intent", "upload"); fd.set("publishMode", "publish");
    for (const [k, v] of Object.entries({ productId: bTote.id, product_id: bTote.id, match: bTote.id, selectedProductId: aTote.id, shopId: B.shopId })) fd.set(k, v);
    fd.set("csv", new File([csv([row({ review_id: "sec-1", product_title: TOTE.title }), row({ review_id: "sec-2", product_title: TOTE.title, selected_product_id: aTote.id, matched_product: bTote.id })])], "r.csv"));
    const res = await run(() => importsAction(args<ActionFunctionArgs>(adminRequest(A.domain, "/app/imports", { method: "POST", body: fd }))));
    assert.equal(res.response?.status, 302);
    const job = await owner.importJob.findFirstOrThrow({ where: { shopId: A.shopId }, orderBy: { createdAt: "desc" } });
    const a = job.analysis as { validRows: number; unmatchedRows: number };
    assert.deepEqual([a.validRows, a.unmatchedRows], [0, 2]);
    await runImport(A.api, job.id);
    for (const m of [A, B]) assert.equal((await reviewsIn(m.api)).filter((r) => ["sec-1", "sec-2"].includes(r.sourceReviewId)).length, 0);
  });
});
