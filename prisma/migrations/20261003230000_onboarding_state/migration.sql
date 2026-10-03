-- First-run onboarding state (checkpoint 2). shop_settings already has RLS + tenant_isolation from 20261003215600.
ALTER TABLE "shop_settings" ADD COLUMN "onboarding_completed_at" TIMESTAMP(3);
