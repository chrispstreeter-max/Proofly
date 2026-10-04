-- Checkpoint 6: import engine (resumable jobs, per-import product matches, review provenance).

-- AlterTable
ALTER TABLE "import_jobs" ADD COLUMN     "actor" TEXT,
ADD COLUMN     "analysis" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "cancel_requested_at" TIMESTAMP(3),
ADD COLUMN     "cursor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "file_key" TEXT,
ADD COLUMN     "finalized_at" TIMESTAMP(3),
ADD COLUMN     "heartbeat_at" TIMESTAMP(3),
ADD COLUMN     "images_key" TEXT,
ADD COLUMN     "options" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "started_at" TIMESTAMP(3),
ADD COLUMN     "total_rows" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "status" SET DEFAULT 'queued';

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN     "content_hash" TEXT,
ADD COLUMN     "import_job_id" UUID,
ADD COLUMN     "source_product_ref" TEXT;

-- CreateTable
CREATE TABLE "import_product_matches" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "import_job_id" UUID NOT NULL,
    "source_product_ref" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "method" TEXT,
    "product_id" UUID,
    "reason" TEXT,
    "candidates" JSONB NOT NULL DEFAULT '[]',
    "rows" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_product_matches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "import_product_matches_shop_id_import_job_id_source_product_key" ON "import_product_matches"("shop_id", "import_job_id", "source_product_ref");

-- CreateIndex
CREATE UNIQUE INDEX "import_jobs_shop_id_id_key" ON "import_jobs"("shop_id", "id");

-- CreateIndex
CREATE INDEX "reviews_shop_id_import_job_id_idx" ON "reviews"("shop_id", "import_job_id");

-- CreateIndex
CREATE INDEX "reviews_shop_id_content_hash_idx" ON "reviews"("shop_id", "content_hash");

-- AddForeignKey
ALTER TABLE "import_product_matches" ADD CONSTRAINT "import_product_matches_shop_id_import_job_id_fkey" FOREIGN KEY ("shop_id", "import_job_id") REFERENCES "import_jobs"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant isolation for the new merchant table (same policy as every merchant table).
ALTER TABLE "import_product_matches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_product_matches" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "import_product_matches"
  USING (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'proofly_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "import_product_matches" TO proofly_app;
  END IF;
END $$;
