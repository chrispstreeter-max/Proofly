-- Tenant row-level security (second barrier behind application-level shop scoping).
-- Every merchant-owned table is restricted to rows whose shop_id equals the per-transaction setting
-- app.shop_id (set by app/lib/tenant.server.ts via set_config(..., true)). When the setting is absent the
-- expression is NULL and NO rows are visible or writable (fail closed).
-- FORCE applies the policies to the table owner too. Superusers and BYPASSRLS roles are never used by the
-- application: it connects as proofly_app (see scripts/db.sh and docs).

ALTER TABLE "shop_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shop_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shop_settings"
  USING (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid);

ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "subscriptions"
  USING (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid);

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "products"
  USING (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid);

ALTER TABLE "reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reviews" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reviews"
  USING (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid);

ALTER TABLE "review_images" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_images" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "review_images"
  USING (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid);

ALTER TABLE "review_replies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_replies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "review_replies"
  USING (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid);

ALTER TABLE "review_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "review_requests"
  USING (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid);

ALTER TABLE "moderation_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "moderation_actions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "moderation_actions"
  USING (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid);

ALTER TABLE "import_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "import_jobs"
  USING (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid);

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_log"
  USING (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = NULLIF(current_setting('app.shop_id', true), '')::uuid);

-- Privileges for the application role, when it exists (created by environment setup, not by migrations).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'proofly_app') THEN
    GRANT USAGE ON SCHEMA public TO proofly_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO proofly_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO proofly_app;
    REVOKE ALL ON "_prisma_migrations" FROM proofly_app;
  END IF;
END $$;
