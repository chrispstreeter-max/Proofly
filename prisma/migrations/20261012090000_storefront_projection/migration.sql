-- Storefront projection (docs/SHOPIFY-DATA.md, Phase 2): set when a product's public reviews changed and its projection
-- metafield in Shopify has not been confirmed written since; cleared on a successful write.
ALTER TABLE "products" ADD COLUMN "projection_stale_since" TIMESTAMP(3);
