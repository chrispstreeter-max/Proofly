-- Checkpoint 8: merchant-confirmed manual product matches (re-used across imports of the same source).
-- CreateTable
CREATE TABLE "product_match_confirmations" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "source_product_ref" TEXT NOT NULL,
    "product_id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_match_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_match_confirmations_shop_id_source_source_product_r_key" ON "product_match_confirmations"("shop_id", "source", "source_product_ref");

-- AddForeignKey
ALTER TABLE "product_match_confirmations" ADD CONSTRAINT "product_match_confirmations_shop_id_product_id_fkey" FOREIGN KEY ("shop_id", "product_id") REFERENCES "products"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "product_match_confirmations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_match_confirmations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "product_match_confirmations"
  USING (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid);
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'proofly_app') THEN GRANT SELECT, INSERT, UPDATE, DELETE ON "product_match_confirmations" TO proofly_app; END IF; END $$;
