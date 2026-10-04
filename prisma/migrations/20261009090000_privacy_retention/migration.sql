-- Checkpoint 9: import file retention marker + non-personal shop deletion log.
-- AlterTable
ALTER TABLE "import_jobs" ADD COLUMN     "files_deleted_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "shop_deletions" (
    "id" UUID NOT NULL,
    "domain_hash" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "shop_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shop_deletions_domain_hash_idx" ON "shop_deletions"("domain_hash");

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'proofly_app') THEN GRANT SELECT, INSERT ON "shop_deletions" TO proofly_app; END IF; END $$;
-- Append-only for the application role (default privileges would otherwise also grant UPDATE/DELETE).
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'proofly_app') THEN REVOKE UPDATE, DELETE, TRUNCATE ON "shop_deletions" FROM proofly_app; END IF; END $$;
