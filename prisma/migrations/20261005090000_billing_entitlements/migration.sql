-- Checkpoint 5: Shopify App Pricing entitlements. Shopify is the billing authority; these tables cache its state per shop.
-- The never-used placeholders shops.plan_id / shops.subscription_status (shops has no RLS) move to the RLS-protected
-- billing_state table. subscriptions had no rows (nothing ever wrote it), so its new NOT NULL columns need no backfill.
DELETE FROM "subscriptions";

-- CreateEnum
CREATE TYPE "PlanKey" AS ENUM ('FREE', 'STARTER', 'GROWTH', 'PRO', 'SCALE');

-- AlterTable
ALTER TABLE "review_images" ADD COLUMN     "public_bytes" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "shops" DROP COLUMN "plan_id",
DROP COLUMN "subscription_status";

-- AlterTable
ALTER TABLE "subscriptions" DROP COLUMN "plan_id",
ADD COLUMN     "currency_code" TEXT,
ADD COLUMN     "interval" TEXT,
ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "plan" "PlanKey",
ADD COLUMN     "plan_handle" TEXT,
ADD COLUMN     "price_amount" DECIMAL(10,2),
ADD COLUMN     "shopify_created_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "test" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trial_days" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "shopify_subscription_id" SET NOT NULL;

-- CreateTable
CREATE TABLE "billing_state" (
    "shop_id" UUID NOT NULL,
    "plan" "PlanKey" NOT NULL DEFAULT 'FREE',
    "interval" TEXT,
    "verification" TEXT NOT NULL DEFAULT 'unverified',
    "shopify_status" TEXT NOT NULL DEFAULT 'none',
    "shopify_subscription_id" TEXT,
    "plan_handle" TEXT,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "trial_days" INTEGER NOT NULL DEFAULT 0,
    "current_period_end" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "check_error" TEXT,
    "plan_changed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_state_pkey" PRIMARY KEY ("shop_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_shop_id_shopify_subscription_id_key" ON "subscriptions"("shop_id", "shopify_subscription_id");

-- AddForeignKey
ALTER TABLE "billing_state" ADD CONSTRAINT "billing_state_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- No backfill: a shop's billing_state row is created on first use (Free, unverified until reconciled with Shopify).

-- Tenant isolation (same policy as every merchant table, 20261003215600_tenant_rls).
ALTER TABLE "billing_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_state" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing_state"
  USING (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'proofly_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_state" TO proofly_app;
  END IF;
END $$;
