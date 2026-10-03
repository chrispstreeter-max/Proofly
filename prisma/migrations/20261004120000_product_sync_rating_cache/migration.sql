-- Checkpoint 4: product sync, rating-cache ownership, opaque public media ids, per-merchant proxy path.

CREATE TYPE "RatingOwnership" AS ENUM ('unmanaged', 'proofly_managed');

ALTER TABLE "products"
  ADD COLUMN "shopify_updated_at" TIMESTAMP(3),
  ADD COLUMN "last_seen_at" TIMESTAMP(3),
  ADD COLUMN "deleted_at" TIMESTAMP(3),
  ADD COLUMN "photo_review_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rating_ownership" "RatingOwnership" NOT NULL DEFAULT 'unmanaged',
  ADD COLUMN "rating_managed_at" TIMESTAMP(3),
  ADD COLUMN "rating_synced_at" TIMESTAMP(3),
  ADD COLUMN "rating_sync_error" TEXT;
-- Pre-release rows: Proofly owns the rating where it already has public reviews or has written the metafields before.
UPDATE "products" SET "rating_ownership" = 'proofly_managed', "rating_managed_at" = now()
  WHERE "review_count" > 0 OR "synced_count" IS NOT NULL;

-- Opaque public asset id: 128 random bits (gen_random_uuid without dashes), unique, unrelated to any database id.
ALTER TABLE "review_images" ADD COLUMN "public_id" TEXT NOT NULL DEFAULT replace((gen_random_uuid())::text, '-'::text, ''::text);
CREATE UNIQUE INDEX "review_images_public_id_key" ON "review_images"("public_id");

-- proxy_path is set explicitly per shop by the application; the default below only backfills existing rows.
ALTER TABLE "shop_settings"
  ADD COLUMN "proxy_path" TEXT NOT NULL DEFAULT '/apps/proofly',
  ADD COLUMN "proxy_path_published" TEXT,
  ADD COLUMN "catalog_sync_status" TEXT NOT NULL DEFAULT 'never',
  ADD COLUMN "catalog_sync_cursor" TEXT,
  ADD COLUMN "catalog_sync_started_at" TIMESTAMP(3),
  ADD COLUMN "catalog_sync_finished_at" TIMESTAMP(3),
  ADD COLUMN "catalog_sync_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "catalog_sync_error" TEXT;
ALTER TABLE "shop_settings" ALTER COLUMN "proxy_path" DROP DEFAULT;

-- Public media resolver: the ONLY cross-tenant read. A public URL carries just an opaque asset id; this function maps
-- it to the internal storage key ONLY when the photo is currently public (published media of a published, un-held
-- review, on a live product, of an installed shop). It returns nothing else — no ids, no tenant, no review data.
-- It runs as the schema owner (SECURITY DEFINER); the owner-only SELECT policies below let it see across tenants under
-- FORCE ROW LEVEL SECURITY. The application role (proofly_app) gets EXECUTE on the function and nothing more.
CREATE POLICY media_resolver_read ON "review_images" FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY media_resolver_read ON "reviews" FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY media_resolver_read ON "products" FOR SELECT TO CURRENT_USER USING (true);

CREATE FUNCTION proofly_public_media_key(p_public_id text, p_size int) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE p_size WHEN 320 THEN i.thumb_key WHEN 1600 THEN i.large_key END
  FROM review_images i
  JOIN reviews r ON r.shop_id = i.shop_id AND r.id = i.review_id
  JOIN products p ON p.shop_id = r.shop_id AND p.id = r.product_id
  JOIN shops s ON s.id = i.shop_id
  WHERE i.public_id = p_public_id
    AND i.media_status = 'published'
    AND r.status = 'published' AND r.hold_reason IS NULL
    AND p.deleted_at IS NULL
    AND s.uninstalled_at IS NULL
$$;
REVOKE ALL ON FUNCTION proofly_public_media_key(text, int) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'proofly_app') THEN
    GRANT EXECUTE ON FUNCTION proofly_public_media_key(text, int) TO proofly_app;
  END IF;
END $$;
