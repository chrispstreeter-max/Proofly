// Database-level barriers: row-level security + composite tenant foreign keys, independent of application code.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import prisma from "../app/db.server";
import { withTenant } from "../app/lib/tenant.server";
import { DOMAIN_A, DOMAIN_B, installMerchant, owner, resetDb, SAME_PRODUCT_ID, SAME_SOURCE_REVIEW_ID, type Merchant } from "./helpers";

let A: Merchant, B: Merchant;
before(async () => {
  await resetDb();
  A = await installMerchant(DOMAIN_A, "A");
  B = await installMerchant(DOMAIN_B, "B");
});
after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

const TABLES = ["shop_settings", "billing_state", "subscriptions", "products", "reviews", "review_images", "review_replies", "review_requests", "moderation_actions", "import_jobs", "import_product_matches", "audit_log"];

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

test("without a tenant context the application sees NO merchant rows (fail closed)", async () => {
  assert.equal(await prisma.review.count(), 0);
  assert.equal(await prisma.product.count(), 0);
  assert.equal(await prisma.reviewImage.count(), 0);
  assert.equal(await prisma.shopSettings.count(), 0);
  assert.equal(await prisma.importJob.count(), 0);
  assert.equal(await prisma.moderationAction.count(), 0);
});

test("inside shop A's context, even UNFILTERED queries only return shop A's rows", async () => {
  await withTenant(A.shopId, async ({ db }) => {
    for (const [name, rows] of Object.entries({
      reviews: await db.review.findMany(), products: await db.product.findMany(), images: await db.reviewImage.findMany(),
      replies: await db.reviewReply.findMany(), settings: await db.shopSettings.findMany(), jobs: await db.importJob.findMany(),
      moderation: await db.moderationAction.findMany(), audit: await db.auditLog.findMany(),
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
    upd: await db.review.updateMany({ where: { id: B.reviewId }, data: { status: "hidden" } }),
    del: await db.reviewReply.deleteMany({ where: { reviewId: B.reviewId } }),
  }));
  assert.equal(res.upd.count, 0);
  assert.equal(res.del.count, 0);
  const b = await owner.review.findUniqueOrThrow({ where: { id: B.reviewId }, include: { reply: true } });
  assert.equal(b.status, "published");
  assert.ok(b.reply);
});

test("composite foreign keys forbid linking shop A's review to shop B's product (even bypassing RLS)", async () => {
  await assert.rejects(
    owner.review.create({
      data: { shopId: A.shopId, productId: B.productId, source: "csv", sourceReviewId: "cross-shop", rating: 5, body: "x", reviewerName: "x", reviewDate: new Date() },
    }),
    /Foreign key|foreign key/,
  );
  await assert.rejects(
    owner.reviewImage.create({
      data: { shopId: A.shopId, reviewId: B.reviewId, originalFilename: "x", storageKey: "x", thumbKey: "x", largeKey: "x", contentType: "image/jpeg", fileSize: 1, sha256: "1".repeat(64) },
    }),
    /Foreign key|foreign key/,
  );
});

test("identical Shopify product ids and source review ids in two shops never collide", async () => {
  const products = await owner.product.findMany({ where: { shopifyProductId: SAME_PRODUCT_ID } });
  const reviews = await owner.review.findMany({ where: { sourceReviewId: SAME_SOURCE_REVIEW_ID } });
  assert.equal(products.length, 2);
  assert.equal(reviews.length, 2);
  assert.equal(new Set(products.map((p) => p.shopId)).size, 2);
});
