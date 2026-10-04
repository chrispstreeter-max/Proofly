-- Product decision (2026-10-04): Proofly has no review photos — no storefront uploads, no photo import, no photo
-- display. Removes the photo table, its public-media resolver and every photo column. No production data exists.
DROP FUNCTION IF EXISTS proofly_public_media_key(text, int);
DROP TABLE "review_images";
DROP TYPE "MediaStatus";
ALTER TABLE "products" DROP COLUMN "photo_review_count";
ALTER TABLE "shop_settings" DROP COLUMN "photo_reviews_enabled";
ALTER TABLE "import_jobs" DROP COLUMN "images_key";
