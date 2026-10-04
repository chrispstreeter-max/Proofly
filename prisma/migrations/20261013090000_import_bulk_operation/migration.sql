-- Large imports write through Shopify bulk operations (docs/SHOPIFY-DATA.md, Phase 3): the running operation is
-- recorded so a resumed import collects its results instead of writing the chunk again.
ALTER TABLE "import_jobs" ADD COLUMN "bulk_operation" JSONB;
