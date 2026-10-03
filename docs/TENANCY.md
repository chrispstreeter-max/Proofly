# Proofly — Tenant isolation and shop lifecycle (Checkpoints 1–4)

Every Shopify store that installs Proofly is an independent tenant (`shops` row). Merchant data never crosses tenants.

## Identity

| Entry point | How the shop is determined |
|---|---|
| Embedded admin | `authenticate.admin` validates the App Bridge session token → `session.shop` → active `shops` row (`requireAdminTenant`) |
| Storefront (app proxy) | `authenticate.public.appProxy` verifies Shopify's HMAC → stored offline session for that signed shop → active `shops` row → signed `path_prefix` must equal that shop's configured proxy path (`requireProxyTenant`) |
| Public media | No tenant input at all: an opaque asset id → `proofly_public_media_key()` → storage key only while the photo is public |
| Webhooks | `authenticate.webhook` verifies Shopify's HMAC → `shop` → `shops` row (product webhooks: active shops only; body fields such as shop ids are ignored) |
| Install / reinstall | Shopify-managed installation → token exchange → `afterAuth` hook → Admin API `shop { id name myshopifyDomain primaryDomain }` → create or reactivate tenant (`upsertShopFromAuth`); refused if the reported domain differs from the session's |
| Uninstall | `app/uninstalled` → sessions deleted, `uninstalled_at` set (idempotent); admin and storefront stop serving the tenant; data retained until `shop/redact` |

Never used as tenant authority: shop domains, shop ids or tenant ids in query strings, bodies or headers; hard-coded or
development store domains (the fictional dev shop exists only behind `NODE_ENV=development`).

## Install, authentication and session lifecycle (Checkpoint 2)

- **Install**: Shopify-managed installation only (`use_legacy_install_flow = false`). Merchants install from the App
  Store and open the app from their admin. No OAuth redirect flow, no `/auth/login`, no "enter your shop domain"
  form. The public landing page only forwards Shopify's `?shop=&host=` to `/app`, which re-verifies via the session token.
- **Authenticate**: every embedded request carries an App Bridge session token. With no valid offline session the
  library performs a token exchange, stores the (expiring) offline token encrypted, and runs `afterAuth`. Running
  `afterAuth` again on refresh keeps the same tenant and refreshes the name and storefront hosts; routine refreshes write no audit record (only install, reinstall, uninstall and merchant actions are audited).
- **Scopes**: `read_products,write_products` only. No order or customer scopes and no order webhooks; storefront
  submissions ignore `logged_in_customer_id` and store no customer identity.
- **Onboarding**: a new tenant starts empty (default settings only). The dashboard shows a setup checklist with
  theme-editor deep links (the merchant saves; the app never edits themes) until "Finish setup" sets
  `shop_settings.onboarding_completed_at`, which is kept across reinstall.
- **Uninstall / reinstall**: uninstall deletes the shop's sessions and deactivates the tenant. Reinstall reactivates
  the same tenant id with its data and onboarding state.
- **Startup**: the server refuses to start without `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`
  and `TOKEN_ENCRYPTION_KEY`.

## Barriers

1. **Application scoping** — all merchant data access goes through `withTenant(shopId, fn)`; every query filters by
   `shopId`. Route files cannot import the database client (ESLint `no-restricted-imports`).
2. **Row-level security** — merchant tables have RLS enabled and forced; policies compare `shop_id` with the
   per-transaction `app.shop_id` set by `withTenant`. No setting → no rows (fail closed). The app connects as
   `proofly_app` (no superuser, no BYPASSRLS); migrations run as the schema owner.
3. **Database constraints** — composite foreign keys `(shop_id, id)` between products, reviews, images, replies,
   requests and moderation actions; uniques are per shop: `(shop_id, shopify_product_id)`, `(shop_id, source, source_review_id)`.
4. **Storage** — object keys are prefixed `s/<shop_id>/` internally. Public URLs expose only an opaque per-photo id.
   The one cross-tenant read is the SECURITY DEFINER `proofly_public_media_key()` (owner-only SELECT policies). It
   returns nothing but a storage key for an already-public photo; the app role may only EXECUTE it.
5. **Same response for missing and foreign** — admin detail/actions return the same 404; storefront endpoints return
   the same empty result for unknown and other-shop products.
6. **Secrets** — Shopify access/refresh tokens are encrypted at rest (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`).
7. **Per-shop limits, origins and proxy paths** — rate-limit keys include the shop; the storefront Origin check uses only
   that shop's own hosts; each shop's proxy path is its own (no global default accepted).
8. **Shopify writes are per shop** — catalogue sync, rating-cache sync and reconciliation use the shop's own Admin API
   client and only that shop's (RLS-scoped) rows; Proofly writes rating metafields only for its `proofly_managed`
   products.

## Tests (`npm test`)

`tests/database.test.ts` (RLS + constraints), `tests/isolation.test.ts` (the required cases 1–10 through real route
handlers with signed session tokens / proxy requests), `tests/lifecycle.test.ts` (new merchant starts empty;
install → authenticate → onboard → uninstall → reinstall with a bystander merchant proven unchanged; install/auth
configuration), `tests/storefront.test.ts`, `tests/sync.test.ts` (product sync, webhooks, aggregation, rating
ownership and reconciliation, proxy paths, public media), `tests/security.test.ts`, `tests/unit.test.ts`.

## Production database setup (later checkpoint)

Create the application role with `NOSUPERUSER NOBYPASSRLS`, point `DATABASE_URL` at it and `DIRECT_DATABASE_URL` at
the schema owner; the RLS migration grants table privileges to `proofly_app` when the role exists.
