-- Checkpoint 7: shared rate limits (replaces the per-process in-memory limiter). Hashed keys only; not merchant data.
-- CreateTable
CREATE TABLE "rate_limits" (
    "key" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("key")
);

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'proofly_app') THEN GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_limits" TO proofly_app; END IF; END $$;
