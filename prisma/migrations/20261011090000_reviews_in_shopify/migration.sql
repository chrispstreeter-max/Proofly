-- Reviews now live in each merchant's Shopify store as entries of the merchant-owned metaobject type proofly_review
-- (docs/SHOPIFY-DATA.md, Phase 1). Proofly no longer stores review content. Moderation history is Proofly's audit log;
-- review counts are a per-shop cache. No production data exists.
DROP TABLE "moderation_actions";
DROP TABLE "review_replies";
DROP TABLE "review_requests";
DROP TABLE "reviews";
DROP TYPE "ReviewStatus";
DROP TYPE "HoldReason";
ALTER TABLE "shop_settings" ADD COLUMN "review_stats" JSONB NOT NULL DEFAULT '{}';
