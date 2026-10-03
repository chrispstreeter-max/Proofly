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
CREATE TABLE "products" (
    "id" UUID NOT NULL,
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
    "source_review_id" TEXT NOT NULL,
    "shopify_product_id" BIGINT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "reviewer_name" TEXT NOT NULL,
    "review_date" TIMESTAMP(3) NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'pending',
    "verified_purchase" BOOLEAN NOT NULL DEFAULT false,
    "imported" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
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
    "review_id" UUID NOT NULL,
    "reply" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_requests" (
    "id" UUID NOT NULL,
    "shopify_customer_id" BIGINT,
    "shopify_order_id" BIGINT NOT NULL,
    "shopify_product_id" BIGINT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "review_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "products_shopify_product_id_key" ON "products"("shopify_product_id");

-- CreateIndex
CREATE INDEX "products_handle_idx" ON "products"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_source_review_id_key" ON "reviews"("source_review_id");

-- CreateIndex
CREATE INDEX "reviews_shopify_product_id_status_review_date_idx" ON "reviews"("shopify_product_id", "status", "review_date" DESC);

-- CreateIndex
CREATE INDEX "reviews_status_review_date_idx" ON "reviews"("status", "review_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "review_images_review_id_sha256_key" ON "review_images"("review_id", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "review_replies_review_id_key" ON "review_replies"("review_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_requests_review_id_key" ON "review_requests"("review_id");

-- CreateIndex
CREATE INDEX "review_requests_token_hash_idx" ON "review_requests"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "review_requests_shopify_order_id_shopify_product_id_key" ON "review_requests"("shopify_order_id", "shopify_product_id");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_shopify_product_id_fkey" FOREIGN KEY ("shopify_product_id") REFERENCES "products"("shopify_product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_images" ADD CONSTRAINT "review_images_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;
