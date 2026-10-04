# Proofly

**Proofly** is a Shopify App Store app for product reviews: bring your existing reviews with you, manage them in one
place, and display them beautifully across your store.

> Status: **Checkpoint 10 — V1 code complete offline** (multi-tenancy, installation, storefront, product sync and rating
> cache, billing and entitlements, import engine, review management, guided import, privacy/retention/export, production
> readiness). Real-Shopify validation is next: [docs/LAUNCH.md](docs/LAUNCH.md) §4. Nothing is deployed, installed or connected to a Shopify store. Import: [docs/IMPORT.md](docs/IMPORT.md) · Billing:
> [docs/BILLING.md](docs/BILLING.md) · Privacy and retention: [docs/PRIVACY.md](docs/PRIVACY.md).
> Import rule: title is never an automatic product-matching key (ID → handle → SKU → other exact identifiers →
> merchant-confirmed manual match; exact titles are suggestions only). See [docs/ARCHITECTURE.md §11](docs/ARCHITECTURE.md).

- Brand: [docs/BRAND.md](docs/BRAND.md)
- Product spec (V1): [docs/PRODUCT-SPEC-V1.md](docs/PRODUCT-SPEC-V1.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Roadmap / checkpoints: [docs/PUBLIC-APP-ROADMAP.md](docs/PUBLIC-APP-ROADMAP.md)

## Local development

```bash
npm install
cp .env.example .env                    # fill local values (TOKEN_ENCRYPTION_KEY: openssl rand -base64 32)
./scripts/db.sh start                   # project-local Postgres on :54330
./scripts/db.sh setup                   # databases + proofly_app role (no superuser, no RLS bypass)
set -a; . ./.env; set +a; npx prisma migrate deploy   # runs as the schema owner (DIRECT_DATABASE_URL)
npx react-router dev --port 3000
npm run dev:seed                        # optional: fictional dev shop + reviews, then open /dev/preview
```

The app connects as `proofly_app`, so Postgres row-level security applies to every query. Merchant data is reachable
only through `withTenant()` in `app/lib/tenant.server.ts` (enforced by lint). See [docs/TENANCY.md](docs/TENANCY.md).

## Checks (also run in CI)

```bash
npm run typecheck && npm run lint && npm run build
npm run check:theme                                   # Shopify Theme Check, theme-app-extension rules
npm run check:graphql                                 # every Admin GraphQL operation vs Shopify's 2026-10 schema (network)
npm test                                              # unit, integration, tenant-isolation, security (proofly_test DB)
npm run fixtures:generate && npm run fixtures:check   # synthetic, fictional dataset — no real merchant data
npm run scan:merchant-data                            # fails if merchant/customer data could ship
```

Scheduled job (production: hourly): `npm run maintenance` — import-file retention, stalled imports, orphaned
storage, rate-limit counters ([docs/PRIVACY.md](docs/PRIVACY.md)).

Real merchant datasets never live in this repository. Authorised local testing against a private dataset uses files
outside the repo and, optionally, a private hashed denylist (`PROOFLY_PRIVATE_DENYLIST`).
