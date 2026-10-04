# Proofly — Production readiness and V1 definition of done (Checkpoint 10)

Nothing here has been deployed. This is what a deployment needs, what is proven offline, and what only a real Shopify
store can prove.

## 1. Deployment

**Runtime:** the `Dockerfile` builds in one stage and runs in a second one. The runtime stage has production
dependencies and the build output only, and runs as the non-root `node` user. `.dockerignore` keeps `.env*`, `.pgdata`,
`storage*`, fixtures, tests and `.git` out of every image.
- Web process: `npm run docker-start`. This runs `prisma migrate deploy` as the schema owner (`DIRECT_DATABASE_URL`),
  then serves on port 3000.
- Scheduler: `npm run maintenance`, hourly ([PRIVACY.md](PRIVACY.md)). Use the same image and the same environment.
- Health check: `GET /healthz` returns `200 ok`, or `503` if the database is unreachable. It never reveals tenant data.

**Environment:** the app refuses to start when the environment is incomplete (`envProblems` in `app/shopify.server.ts`).
- Always required: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`, `TOKEN_ENCRYPTION_KEY` (32
  bytes, base64).
- Required in production:
  - `DATABASE_URL` (the `proofly_app` role).
  - `IP_HASH_SALT` (at least 32 characters).
  - `SHOPIFY_APP_HANDLE`.
  - `MEDIA_DRIVER=s3`, with a private `S3_BUCKET_PRIVATE` bucket (import CSVs only), plus `S3_ACCESS_KEY_ID` and
    `S3_SECRET_ACCESS_KEY`.
  - An `https` app URL.
- Optional: `S3_ENDPOINT` and `S3_REGION`, for R2 or another S3-compatible store.

**Database:** Postgres 15 or later.
1. Create the schema owner, which runs migrations.
2. Create `proofly_app` with `LOGIN NOSUPERUSER NOBYPASSRLS`. Grant it `USAGE` on the schema, and set default privileges
   `SELECT, INSERT, UPDATE, DELETE` from the owner.
3. Run migrations. They enable RLS, add the composite foreign keys, and make `shop_deletions` insert-only for the app
   role.

**Storage:**
- One private bucket, never public. It holds only merchants' import CSVs. Proofly has no review photos and serves no
  stored file to anyone.
- Do not add lifecycle rules that delete objects: retention is done by `npm run maintenance`.

**Partner Dashboard:**
- Link the configuration with `shopify app config link`, which fills in `client_id` and the URLs.
- Create the five Shopify App Pricing plans with the handles `free`, `starter`, `growth`, `pro` and `scale`, at the
  prices in `app/lib/plans.ts` ([BILLING.md](BILLING.md)).
- `shopify app deploy` publishes the app proxy (`/apps/proofly`), the webhooks (including the compliance topics) and the
  theme app extension from `shopify.app.toml`.

**CI** (`.github/workflows/ci.yml`) runs:
- typecheck, lint and build;
- the full offline test suite against Postgres with a non-superuser app role;
- fixture generation and check;
- the merchant-data scan;
- Theme Check;
- the GraphQL schema check;
- `npm audit --omit=dev --audit-level=critical`.

## 2. Known risks and advisories

- **`deepmerge-ts` < 8 (high, GHSA-ggr8-5vv4-36mx)** comes in through `prisma` → `@prisma/config` (and
  `@shopify/shopify-app-session-storage-prisma`).
  - It is reachable only when the Prisma CLI loads Proofly's own configuration. No request data is ever deep-merged.
  - The only offered fix is a breaking Prisma downgrade, so the current version is kept. Re-check on every Prisma release.
- **Development tooling advisories** (minimatch, braces, lodash in lint and codegen tooling) are not in the production image.
- **iCloud Drive:** the working copy is in `~/Documents`, which iCloud syncs. iCloud has created duplicate files ending
  in " 2" (including under `.git/`).
  - `git fsck` is clean.
  - Generated duplicates were removed. `.dockerignore` excludes the remaining patterns.
  - Recommended: move the repository out of iCloud-synced folders before production work.
- **Imports run in the web process.** If an instance restarts mid-import, the import page offers **Resume** at once (the
  worker heartbeat goes stale after 10 minutes). Maintenance marks it failed within the hour. Nothing is duplicated.
- **Orphan sweep:** for each shop it lists every object under that shop's prefix. If a shop ever holds very many imports, make
  it incremental. This is marked in the code.

## 3. V1 definition of done — offline evidence

| Requirement | Evidence (all offline, `npm test` unless noted) |
|---|---|
| New merchant starts empty | `lifecycle`: install creates the shop with no data; `import` 1 |
| Merchant A cannot access Merchant B | `isolation` (30 cases: library, admin, storefront, database, webhooks); `database` (RLS, composite FKs) |
| Shopify identity controls the tenant; relationships tenant-safe | `lifecycle`: tenant from the session token, not `?shop=`; mismatched identity refused; `database` composite FKs |
| Install, reinstall, uninstall | `lifecycle`: install → onboard → uninstall (dark, sessions deleted) → reinstall (same tenant), with a bystander byte-for-byte unchanged |
| Product sync; rating metafields correct | `sync`: all statuses, resume, throttling, webhooks; aggregate = metafields; reconciliation; third-party ratings untouched |
| Review widget and card ratings | `storefront`: Theme Check, blocks, budgets, widget, summary, card embed; `isolation` storefront cases |
| Plans and entitlements | `billing` (30 cases): prices, handles, Shopify-verified upgrades only, cancel → Free, unreleased features never available |
| Imports resumable and idempotent; matching never guesses; title never auto-attaches | `import` 8, 9, 43–44, 15–20; `title-matching` 1–8; `guided-import` |
| Replies retained and gated | `replies`: Free stores but hides; downgrade hides without deleting; upgrade restores |
| Plan limits never delete; upgrade never silently publishes; downgrade never deletes | `billing`: at/above limit nothing deleted; upgrade publishes nothing until "Publish eligible reviews"; downgrade grandfathered |
| No photos; public responses expose no private fields | `security`: photos refused or ignored, no photo columns, no media route; `storefront` exact allow-listed fields |
| Moderation | `admin`: bulk approve/hide/reject/restore through the allowance; `isolation`: no cross-shop moderation |
| Manual product resolution | `guided-import`; `title-matching` 8 (only the shop's own products) |
| Errors understandable | `guided-import`: plain-English explanations and problem report; `import` 4–5, 16 |
| Retention | `privacy`: import-file retention, orphan sweep, stale imports, `shop/redact`, compliance topics |
| No real merchant data; no references to the private archive or its providers | `security`: merchant-data scan (repository + build, committed and private denylists); fixtures are synthetic; `git grep` clean |
| Production build clean; security scans pass | gates: typecheck, lint, build, Theme Check, scans, secret scans, network guard |
| Production configuration | `production`: environment checks, health check, image contents |

## 4. REAL-SHOPIFY VALIDATION REQUIRED

None of the items below can be proven offline. Each one needs explicit authorisation and a development store, never a
live merchant store.

1. **Install:** Shopify-managed install, token exchange, and `afterAuth` creating the tenant from the real Admin API
   identity. Then reinstall, and uninstall with the storefront going dark.
2. **Shopify App Pricing:** the five plans and their handles, the hosted plan page, test charges (trial, upgrade,
   downgrade, cancel, reinstall), and `currentAppInstallation` handles mapping to plans.
3. **Embedded admin:** every page renders in Shopify admin (App Bridge, Polaris web components, navigation). Downloads
   (problem report, review export) work through App Bridge's authenticated fetch.
4. **Product sync:** a 250-product store, rate limits, and `products/*` webhook delivery including `include_fields`.
5. **Metafields:** `reviews.rating` and `reviews.rating_count` writes, and themes reading them (card stars). The
   `proofly.proxy_path` and `proofly.storefront` app-data metafields are read by Liquid.
6. **Theme app extension:** Theme Editor deep links (add block, activate embed), Dawn plus three other themes, zero
   console errors.
7. **App proxy:** signed requests, a changed `path_prefix`, customer-locale paths, and the 64 KB submission size limit
   through Shopify's proxy.
8. **Webhooks:** `app/uninstalled`, `app/scopes_update`, the compliance topics (including `shop/redact` timing), and
   HMAC verification with the real secret.
9. **Storage:** the private S3 or R2 bucket for import CSVs, and maintenance list and delete against it.
10. **Performance:** Lighthouse and Web Vitals on a product page with the widget, within the storefront budget.
11. **Deployment:** building the container image (Docker was not available locally), migrations against managed
    Postgres with the `proofly_app` role, `/healthz` on the host, and the hourly scheduler.
12. **Import QA:** only where explicitly authorised, and only on a development store.
13. **App Store submission:** listing, screenshots, demo store and reviewer walk-through ([APP-STORE.md](APP-STORE.md)).
