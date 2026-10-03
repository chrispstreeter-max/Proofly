# Proofly — Tenant isolation (Checkpoint 1)

Every Shopify store that installs Proofly is an independent tenant (`shops` row). Merchant data never crosses tenants.

## Identity

| Entry point | How the shop is determined |
|---|---|
| Embedded admin | `authenticate.admin` validates the App Bridge session token → `session.shop` → active `shops` row (`requireAdminTenant`) |
| Storefront (app proxy) | `authenticate.public.appProxy` verifies Shopify's HMAC → stored offline session for that signed shop → active `shops` row (`requireProxyTenant`) |
| Webhooks | `authenticate.webhook` verifies Shopify's HMAC → `shop` → `shops` row |
| Install / reinstall | Shopify `afterAuth` hook → Admin API `shop { id name myshopifyDomain primaryDomain }` → create or reactivate tenant (`upsertShopFromAuth`) |
| Uninstall | `app/uninstalled` → sessions deleted, `uninstalled_at` set; admin and storefront stop serving the tenant; data retained until `shop/redact` |

Never used as tenant authority: shop domains, shop ids or tenant ids in query strings, bodies or headers; hard-coded or
development store domains (the fictional dev shop exists only behind `NODE_ENV=development`).

## Barriers

1. **Application scoping** — all merchant data access goes through `withTenant(shopId, fn)`; every query filters by
   `shopId`. Route files cannot import the database client (ESLint `no-restricted-imports`).
2. **Row-level security** — merchant tables have RLS enabled and forced; policies compare `shop_id` with the
   per-transaction `app.shop_id` set by `withTenant`. No setting → no rows (fail closed). The app connects as
   `proofly_app` (no superuser, no BYPASSRLS); migrations run as the schema owner.
3. **Database constraints** — composite foreign keys `(shop_id, id)` between products, reviews, images, replies,
   requests and moderation actions; uniques are per shop: `(shop_id, shopify_product_id)`, `(shop_id, source, source_review_id)`.
4. **Storage** — object keys are prefixed `s/<shop_id>/`.
5. **Same response for missing and foreign** — admin detail/actions return the same 404; storefront endpoints return
   the same empty result for unknown and other-shop products.
6. **Secrets** — Shopify access/refresh tokens are encrypted at rest (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`).
7. **Per-shop limits and origins** — rate-limit keys include the shop; the storefront Origin check uses only that
   shop's own hosts.

## Tests (`npm test`)

`tests/database.test.ts` (RLS + constraints), `tests/isolation.test.ts` (the required cases 1–10 through real route
handlers with signed session tokens / proxy requests), `tests/security.test.ts`, `tests/unit.test.ts`.

## Production database setup (later checkpoint)

Create the application role with `NOSUPERUSER NOBYPASSRLS`, point `DATABASE_URL` at it and `DIRECT_DATABASE_URL` at
the schema owner; the RLS migration grants table privileges to `proofly_app` when the role exists.
