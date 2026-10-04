-- Phase 4 (docs/SHOPIFY-DATA.md): import CSVs live in the database while an import may need them; no file storage
-- (S3/R2) any more. Files of existing jobs stay where they were (no production data exists); such a job can't resume.
-- AlterTable
ALTER TABLE "import_jobs" DROP COLUMN "file_key";

-- CreateTable
CREATE TABLE "import_files" (
    "import_job_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_files_pkey" PRIMARY KEY ("import_job_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "import_files_shop_id_import_job_id_key" ON "import_files"("shop_id", "import_job_id");

-- AddForeignKey
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_shop_id_import_job_id_fkey" FOREIGN KEY ("shop_id", "import_job_id") REFERENCES "import_jobs"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant isolation (same policy as every merchant table).
ALTER TABLE "import_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_files" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "import_files"
  USING (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'proofly_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "import_files" TO proofly_app;
  END IF;
END $$;
