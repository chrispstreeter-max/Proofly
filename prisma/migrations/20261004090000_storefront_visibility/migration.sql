-- Checkpoint 3: storefront visibility. Plan-limited reviews (hold_reason = plan_limit) and non-published media
-- (media_status <> published) are stored but never served publicly. Both tables already have RLS + tenant_isolation.
CREATE TYPE "HoldReason" AS ENUM ('moderation', 'plan_limit');
CREATE TYPE "MediaStatus" AS ENUM ('published', 'storage_limited', 'processing', 'failed');
ALTER TABLE "reviews" ADD COLUMN "hold_reason" "HoldReason";
ALTER TABLE "review_images" ADD COLUMN "media_status" "MediaStatus" NOT NULL DEFAULT 'published';
