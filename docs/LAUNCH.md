# Proofly — Production readiness and V1 definition of done (Checkpoint 10; reviews in Shopify since Phase 1)

Nothing here has been deployed. This is what a deployment needs, what is proven offline, and what only a real Shopify
store can prove.

**Status (2026-10-04):** real-Shopify validation on the development store Proofly Test is logged in
[REAL-SHOPIFY-VALIDATION.md](REAL-SHOPIFY-VALIDATION.md) (four defects found there and fixed). Production container:
**blocked** (no Docker locally; the production build was started locally instead). Managed Postgres and the hourly
scheduler: **blocked** (nothing provisioned). Performance: Lighthouse **blocked** (not installed; password-protected
development storefront), indicative in-browser numbers only.

**Locked:** PostgreSQL is the only persistence and storage dependency (no S3/R2); RLS is mandatory; import CSVs are
stored in Postgres.

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
  - An `https` app URL.
- No file storage: Proofly uses no S3/R2 bucket (import CSVs are kept in the database while needed).

**Database:** Postgres 15 or later.
1. Create the schema owner, which runs migrations.
2. Create `proofly_app` with `LOGIN NOSUPERUSER NOBYPASSRLS`. Grant it `USAGE` on the schema, and set default privileges
   `SELECT, INSERT, UPDATE, DELETE` from the owner.
3. Run migrations. They enable RLS, add the composite foreign keys, and make `shop_deletions` insert-only for the app
   role.

**Storage:** none besides Postgres. Merchants' import CSVs are stored in the `import_files` table (RLS, deleted by
`npm run maintenance` 30 days after an import finishes, and with the shop on `shop/redact`). Size the database for up
to 50 MB per import in progress.

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
- **Development tooling advisories** (29 high in the full tree on 2026-10-04: lodash, minimatch and others in lint,
  build and codegen tooling) are not in the production image. `npm audit --omit=dev`: 4 high, all the `deepmerge-ts`
  chain above.
- **Prisma loads a `.env` file** from the working directory when one exists. The image excludes `.env*`; never mount
  one in production (the startup check then validates exactly the platform's environment).
- **Maintenance exits 1 when any shop failed** (others are still maintained); alert on it.
- **iCloud Drive:** the working copy is in `~/Documents`, which iCloud syncs. iCloud has created duplicate files ending
  in " 2" (including under `.git/`).
  - `git fsck` is clean.
  - Generated duplicates were removed. `.dockerignore` excludes the remaining patterns.
  - Recommended: move the repository out of iCloud-synced folders before production work.
- **Imports run in the web process.** If an instance restarts mid-import, the import page offers **Resume** at once (the
  worker heartbeat goes stale after 10 minutes). Maintenance marks it failed within the hour. Nothing is duplicated.

## 3. V1 definition of done — offline evidence

| Requirement | Evidence (all offline, `npm test` unless noted) |
|---|---|
| New merchant starts empty | `lifecycle`: install creates the shop with no data; `import` 1 |
| Merchant A cannot access Merchant B | `isolation` (29 cases: store, admin, storefront, database, webhooks) — reviews live in each shop's own Shopify store and are reached only through that shop's Admin API; `database` (RLS, composite FKs, no review content in Proofly's database) |
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
| Retention | `privacy`: import-file retention (files in Postgres), per-shop failure isolation, stale imports, `shop/redact`, compliance topics |
| No real merchant data; no references to the private archive or its providers | `security`: merchant-data scan (repository + build, committed and private denylists); fixtures are synthetic; `git grep` clean |
| Production build clean; security scans pass | gates: typecheck, lint, build, Theme Check, scans, secret scans, network guard |
| Production configuration | `production`: environment checks, health check, image contents |

## 4. REAL-SHOPIFY VALIDATION REQUIRED

> Status of every item below: [REAL-SHOPIFY-VALIDATION.md](REAL-SHOPIFY-VALIDATION.md) (authoritative); launch
> tracking: [V1-LAUNCH-CHECKLIST.md](V1-LAUNCH-CHECKLIST.md) (master tracker).

**Reviews stored in Shopify (Phase 1):** every review read and write goes through the merchant's Shopify store. In
addition to the items below, validate on a development store: review creation from the storefront, moderation and
replies from the admin, an import of a few hundred rows, the daily recount, and a review edited in Shopify admin
staying hidden until re-approved.

Results so far: [REAL-SHOPIFY-VALIDATION.md](REAL-SHOPIFY-VALIDATION.md). None of the items below can be proven offline. Each one needs explicit authorisation and a development store, never a
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
9. **Import files:** a large CSV (tens of MB) stored and read back from managed Postgres within the request limits.
10. **Performance:** Lighthouse and Web Vitals on a product page with the widget, within the storefront budget.
11. **Deployment:** building the container image (Docker was not available locally), migrations against managed
    Postgres with the `proofly_app` role, `/healthz` on the host, and the hourly scheduler.
12. **Import QA:** only where explicitly authorised, and only on a development store.
13. **App Store submission:** listing, screenshots, demo store and reviewer walk-through ([APP-STORE.md](APP-STORE.md)).

## 5. LAUNCH HANDOFF (2026-10-04)

1. **Current commit:** `78df03e` (validated code; this section is documentation only). Not pushed, not deployed.
2. **Offline gates passed:** 247/247 tests (network guard active), typecheck, lint, production build, Theme Check, 16
   fixture checks, GraphQL 23/23 operations plus 2 input checks against 2026-10, both merchant-data scans, secret scans
   (0 hits), lockfile unchanged.
3. **Real-Shopify validation completed** on the development store Proofly Test
   ([REAL-SHOPIFY-VALIDATION.md](REAL-SHOPIFY-VALIDATION.md)): 93 checks — 67 PASS, 0 FAIL, 7 BLOCKED, 7 UNVERIFIED,
   12 NOT RUN. Four defects found there were fixed with regression tests and re-verified.
4. **Remaining external validations:**
   - uninstall → storefront dark → reinstall → projections republished; `app/uninstalled` delivery;
   - `customers/data_request` and `customers/redact` from a real (synthetic) customer;
   - one admin pass with the browser visible: downloads, error and loading states, app-frame console;
   - card-stars app embed on a theme; a changed app proxy path; a locale-prefixed path;
   - a second store confirming app-owned data is not shared;
   - Shopify App Pricing: the five plans and test charges (upgrade, downgrade, cancel);
   - container image build and run; `/healthz` on the host; hourly maintenance; Lighthouse on a public storefront.
5. **Required infrastructure:**
   - managed Node hosting running the `Dockerfile` image (web: `npm run docker-start`; scheduler: `npm run maintenance`
     hourly from the same image, alert when it exits 1; monitor `/healthz`);
   - managed PostgreSQL 15+ with a schema owner (`DIRECT_DATABASE_URL`, runs migrations) and the `proofly_app` role
     (`NOSUPERUSER NOBYPASSRLS`, `DATABASE_URL`). PostgreSQL is the only storage (no S3/R2); RLS is mandatory;
   - production secrets: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL` (https), `SCOPES`,
     `TOKEN_ENCRYPTION_KEY`, `IP_HASH_SALT` (32+ characters), `SHOPIFY_APP_HANDLE`; no `.env` file in the image;
   - a separate production Shopify app (its own `shopify.app.<env>.toml`) with App Pricing plans using the handles in
     `app/lib/plans.ts`.
6. **Required App Store decisions** ([APP-STORE.md](APP-STORE.md)): legal entity, address, contact email and governing
   law **[decide]**; privacy policy public URL **[decide]**; support email, page and response time **[decide]**;
   listing copy and screenshots **[decide]**; demo store and the reviewer sample CSV for it **[decide]**; hosting
   provider and region **[decide]**.
7. **Known risks:** `deepmerge-ts` advisory through Prisma (production audit: 4 high; no non-breaking fix); a review
   moderated during a large bulk publish stays private but is shown as edited outside Proofly until re-approved; two
   overlapping publishes can double-count until the daily recount; imports run in the web process (restart → Resume,
   nothing duplicated); the working copy sits in an iCloud-synced folder; the CI workflow change is unexercised until
   the first push.
8. **Recommended order of operations:**
   1. Uninstall/reinstall and synthetic-customer checks on Proofly Test; one visible admin pass.
   2. Owner decisions: hosting provider and region, legal and contact details, support.
   3. Provision managed PostgreSQL (roles as above) and hosting; build the image; deploy with production secrets.
   4. Verify `/healthz`, migrations and the hourly scheduler on the host.
   5. Create the production Shopify app and App Pricing plans; deploy its configuration and theme extension.
   6. Install on a demo development store with synthetic data; test charges; Lighthouse on its storefront.
   7. Screenshots, listing and privacy policy; submit for App Store review.
