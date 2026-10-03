-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('pending', 'published', 'rejected', 'hidden');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "id" UUID NOT NULL,
    "shopify_shop_id" BIGINT,
    "shop_domain" TEXT NOT NULL,
    "shop_name" TEXT,
    "storefront_hosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "plan_id" TEXT NOT NULL DEFAULT 'free',
    "subscription_status" TEXT NOT NULL DEFAULT 'none',
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_settings" (
    "shop_id" UUID NOT NULL,
    "widget_enabled" BOOLEAN NOT NULL DEFAULT true,
    "review_submission_enabled" BOOLEAN NOT NULL DEFAULT true,
    "photo_reviews_enabled" BOOLEAN NOT NULL DEFAULT true,
    "moderation_enabled" BOOLEAN NOT NULL DEFAULT true,
    "theme_settings" JSONB NOT NULL DEFAULT '{}',
    "display_settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_settings_pkey" PRIMARY KEY ("shop_id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "shopify_subscription_id" TEXT,
    "plan_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "current_period_end" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "shopify_product_id" BIGINT NOT NULL,
    "shopify_variant_id" BIGINT,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "image" TEXT,
    "status" TEXT,
    "review_count" INTEGER NOT NULL DEFAULT 0,
    "average_rating" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "rating_1" INTEGER NOT NULL DEFAULT 0,
    "rating_2" INTEGER NOT NULL DEFAULT 0,
    "rating_3" INTEGER NOT NULL DEFAULT 0,
    "rating_4" INTEGER NOT NULL DEFAULT 0,
    "rating_5" INTEGER NOT NULL DEFAULT 0,
    "synced_count" INTEGER,
    "synced_average" DECIMAL(3,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "source_review_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "reviewer_name" TEXT NOT NULL,
    "review_date" TIMESTAMP(3) NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'pending',
    "verified_purchase" BOOLEAN NOT NULL DEFAULT false,
    "imported" BOOLEAN NOT NULL DEFAULT false,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewer_email" TEXT,
    "shopify_customer_id" BIGINT,
    "shopify_order_id" BIGINT,
    "submitter_ip_hash" TEXT,
    "source_date_raw" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_images" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "original_filename" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "thumb_key" TEXT NOT NULL,
    "large_key" TEXT NOT NULL,
    "original_url" TEXT,
    "content_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_replies" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "reply" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_requests" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "shopify_customer_id" BIGINT,
    "shopify_order_id" BIGINT NOT NULL,
    "shopify_product_id" BIGINT NOT NULL,
    "token_hash" TEXT,
    "sent_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "review_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_actions" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "from_status" "ReviewStatus" NOT NULL,
    "to_status" "ReviewStatus" NOT NULL,
    "actor" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "counts" JSONB NOT NULL DEFAULT '{}',
    "report" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "shops_shopify_shop_id_key" ON "shops"("shopify_shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "shops_shop_domain_key" ON "shops"("shop_domain");

-- CreateIndex
CREATE INDEX "subscriptions_shop_id_idx" ON "subscriptions"("shop_id");

-- CreateIndex
CREATE INDEX "products_shop_id_handle_idx" ON "products"("shop_id", "handle");

-- CreateIndex
CREATE UNIQUE INDEX "products_shop_id_shopify_product_id_key" ON "products"("shop_id", "shopify_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_shop_id_id_key" ON "products"("shop_id", "id");

-- CreateIndex
CREATE INDEX "reviews_shop_id_product_id_status_review_date_idx" ON "reviews"("shop_id", "product_id", "status", "review_date" DESC);

-- CreateIndex
CREATE INDEX "reviews_shop_id_status_review_date_idx" ON "reviews"("shop_id", "status", "review_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reviews_shop_id_source_source_review_id_key" ON "reviews"("shop_id", "source", "source_review_id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_shop_id_id_key" ON "reviews"("shop_id", "id");

-- CreateIndex
CREATE INDEX "review_images_shop_id_review_id_idx" ON "review_images"("shop_id", "review_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_images_review_id_sha256_key" ON "review_images"("review_id", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "review_replies_review_id_key" ON "review_replies"("review_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_replies_shop_id_review_id_key" ON "review_replies"("shop_id", "review_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_requests_review_id_key" ON "review_requests"("review_id");

-- CreateIndex
CREATE INDEX "review_requests_shop_id_token_hash_idx" ON "review_requests"("shop_id", "token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "review_requests_shop_id_shopify_order_id_shopify_product_id_key" ON "review_requests"("shop_id", "shopify_order_id", "shopify_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_requests_shop_id_review_id_key" ON "review_requests"("shop_id", "review_id");

-- CreateIndex
CREATE INDEX "moderation_actions_shop_id_review_id_created_at_idx" ON "moderation_actions"("shop_id", "review_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "import_jobs_shop_id_created_at_idx" ON "import_jobs"("shop_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_shop_id_entity_entity_id_idx" ON "audit_log"("shop_id", "entity", "entity_id");

-- AddForeignKey
ALTER TABLE "shop_settings" ADD CONSTRAINT "shop_settings_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_shop_id_product_id_fkey" FOREIGN KEY ("shop_id", "product_id") REFERENCES "products"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_images" ADD CONSTRAINT "review_images_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_images" ADD CONSTRAINT "review_images_shop_id_review_id_fkey" FOREIGN KEY ("shop_id", "review_id") REFERENCES "reviews"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_shop_id_review_id_fkey" FOREIGN KEY ("shop_id", "review_id") REFERENCES "reviews"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_shop_id_review_id_fkey" FOREIGN KEY ("shop_id", "review_id") REFERENCES "reviews"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_shop_id_review_id_fkey" FOREIGN KEY ("shop_id", "review_id") REFERENCES "reviews"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

