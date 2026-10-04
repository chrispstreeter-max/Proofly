// Database-level barriers: row-level security + composite tenant foreign keys, independent of application code.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import prisma from "../app/db.server";
import { withTenant } from "../app/lib/tenant.server";
import { DOMAIN_A, DOMAIN_B, installMerchant, owner, resetDb, reviewsIn, SAME_PRODUCT_ID, SAME_SOURCE_REVIEW_ID, type Merchant } from "./helpers";

let A: Merchant, B: Merchant;
before(async () => {
  await resetDb();
  A = await installMerchant(DOMAIN_A, "A");
  B = await installMerchant(DOMAIN_B, "B");
});
after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

const TABLES = ["shop_settings", "billing_state", "subscriptions", "products", "import_jobs", "import_product_matches", "product_match_confirmations", "audit_log"];

test("the application role is not a superuser and cannot bypass RLS", async () => {
  const [r] = await prisma.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
  assert.deepEqual(r, { rolsuper: false, rolbypassrls: false });
});

test("RLS is enabled and forced on every merchant-owned table", async () => {
  const rows = await owner.$queryRaw<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
    select relname, relrowsecurity, relforcerowsecurity from pg_class where relname = any(${TABLES})`;
  assert.equal(rows.length, TABLES.length);
  for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity, r.relname);
});

test("Proofly's database holds no review content: reviews live in the merchant's Shopify store", async () => {
  const tables = await owner.$queryRaw<{ t: string }[]>`select table_name as t from information_schema.tables where table_schema = 'public' and table_name ~ 'review'`;
  assert.deepEqual(tables, []);
  const cols = await owner.$queryRaw<{ c: string }[]>`select table_name || '.' || column_name as c from information_schema.columns
    where table_schema = 'public' and column_name in ('body', 'reviewer_name', 'reply', 'rating', 'submitter_ip_hash', 'shopify_customer_id')`;
  assert.deepEqual(cols, []);
});

test("without a tenant context the application sees NO merchant rows (fail closed)", async () => {
  assert.equal(await prisma.product.count(), 0);
  assert.equal(await prisma.shopSettings.count(), 0);
  assert.equal(await prisma.importJob.count(), 0);
  assert.equal(await prisma.auditLog.count(), 0);
});

test("inside shop A's context, even UNFILTERED queries only return shop A's rows", async () => {
  await withTenant(A.shopId, async ({ db }) => {
    for (const [name, rows] of Object.entries({
      products: await db.product.findMany(), settings: await db.shopSettings.findMany(), jobs: await db.importJob.findMany(),
      billing: await db.billingState.findMany(), audit: await db.auditLog.findMany(),
    })) {
      assert.ok(rows.length > 0, `${name} visible to owner shop`);
      assert.ok(rows.every((r: { shopId: string }) => r.shopId === A.shopId), `${name} only shop A`);
    }
  });
});

test("RLS rejects writing a row for another shop from shop A's context", async () => {
  await assert.rejects(
    withTenant(A.shopId, ({ db }) => db.importJob.create({ data: { shopId: B.shopId, source: "csv" } })),
    /row-level security|violates/i,
  );
});

test("RLS makes unfiltered UPDATE/DELETE from shop A unable to touch shop B", async () => {
  const res = await withTenant(A.shopId, async ({ db }) => ({
    upd: await db.importJob.updateMany({ where: { id: B.importJobId }, data: { status: "failed" } }),
    del: await db.auditLog.deleteMany({ where: { shopId: B.shopId } }),
  }));
  assert.equal(res.upd.count, 0);
  assert.equal(res.del.count, 0);
  assert.equal((await owner.importJob.findUniqueOrThrow({ where: { id: B.importJobId } })).status, "finished");
  assert.ok(await owner.auditLog.count({ where: { shopId: B.shopId } }) > 0);
});

test("composite foreign keys forbid linking shop A's records to shop B's product (even bypassing RLS)", async () => {
  await assert.rejects(
    owner.productMatchConfirmation.create({ data: { shopId: A.shopId, source: "csv", sourceProductRef: "{}", productId: B.productId, actor: "x" } }),
    /Foreign key|foreign key/,
  );
});

test("identical Shopify product ids and source review ids in two shops never collide", async () => {
  const products = await owner.product.findMany({ where: { shopifyProductId: SAME_PRODUCT_ID } });
  assert.equal(products.length, 2);
  assert.equal(new Set(products.map((p) => p.shopId)).size, 2);
  // Same source + source review id in both shops: one review in EACH shop's own store.
  for (const m of [A, B]) assert.deepEqual((await reviewsIn(m.api)).map((r) => r.sourceReviewId), [SAME_SOURCE_REVIEW_ID]);
});
