# Proofly — Real-Shopify validation and production readiness

Validation log for everything the offline suite cannot prove. Every row has one status:
**PASS** · **FAIL** · **BLOCKED** · **UNVERIFIED** · **NOT RUN**. A local or offline test is never recorded as a
real-Shopify PASS: the **Env** column says where each result came from.

- **Store:** Proofly Test (`proofly-test-g3yjndjl.myshopify.com`, development store, org My Store 2), published theme
  Horizon 4.2.0. App: Proofly Dev (development app), plan Free (no subscription; no charges of any kind).
- **App server:** local dev server behind a Cloudflare quick tunnel; API version 2026-10.
- **Date:** 2026-10-04 (live checks ran against the code up to commit `d880888`; later changes: CSV formula neutralisation now also covers a leading `-` and the problem report (offline-tested), CI step order, documentation).
- **Test data (locked decision):** the fictional reviews on Proofly Test are kept for later validation. They are
  synthetic; no customer data was used anywhere.

Env: **Shopify** = real Shopify (Admin API, webhooks, storefront, Shopify Admin) · **Public URL** = real HTTP requests
to the app's public URL · **Local prod** = production build run locally (no Docker) · **Local DB** = local Postgres 17.

## Summary

| Status | Count |
|---|---|
| PASS | 67 (Shopify 53 · Public URL 4 · Local prod 4 · Local DB 5 · Offline 1 · see Env column) |
| FAIL | 0 (four defects were found during this validation, fixed with regression tests and re-verified: F11, H4, I4, J2) |
| BLOCKED | 7 |
| UNVERIFIED | 7 |
| NOT RUN | 12 |

## A. Install and authentication

| # | Check | Status | Env | Evidence |
|---|---|---|---|---|
| A1 | Shopify-managed installation | PASS | Shopify | Installed from Shopify on 2026-10-04 (legacy install flow disabled); `afterAuth` created the tenant |
| A2 | Token exchange; offline token storage | PASS | Shopify | Offline expiring token with refresh token; both stored encrypted (`enc:v1`) |
| A3 | Shop identity from the Admin API | PASS | Shopify | `shop.id` 85802418397 = tenant `shopify_shop_id` |
| A4 | Reinstall keeps the tenant and the merchant's reviews | PASS | Shopify | Phase 0: uninstall + reinstall; same tenant; 230 merchant-owned entries intact |
| A5 | Reinstall republishes app-owned data (fix `b2d9820`) | NOT RUN | — | Needs an uninstall of the app on Proofly Test (authorisation required). Offline regression tests pass |
| A6 | Free plan recognition | PASS | Shopify | `currentAppInstallation` has no subscription → Free confirmed (100 published allowance) |
| A7 | Session lifecycle: expired access token refreshed | PASS | Shopify | The access token expired at 15:39:52Z; the next Admin API call refreshed it with the stored refresh token (new expiry 16:40:11Z); same tenant |
| A8 | Uninstall: storefront goes dark | NOT RUN | — | Needs an uninstall (authorisation required) |

## B. Product sync

| # | Check | Status | Env | Evidence |
|---|---|---|---|---|
| B1 | Fields stored: id, handle, title, status, updated time | PASS | Shopify | Synthetic product rows match the Admin API |
| B2 | Full catalogue sync over 250 products (paged) | PASS | Shopify | 252 products, 3 pages of 100, in 1 s; database count = `productsCount` |
| B3 | SKU lookup through the Admin API | PASS | Shopify | Unique SKU matched one product; a shared SKU returned two (see F4, F7) |
| B4 | Stale-update protection | NOT RUN | — | Shopify's delivery order cannot be forced; offline-tested |
| B5 | Duplicate webhook delivery | NOT RUN | — | Redelivery cannot be triggered on demand; offline-tested |

## C. Rating metafields (`reviews.rating`, `reviews.rating_count`)

| # | Check | Status | Env | Evidence |
|---|---|---|---|---|
| C1 | Managed product written correctly | PASS | Shopify | Harbour Mug: `5.0` / `1` |
| C2 | Final public review removed → only Proofly's value removed | PASS | Shopify | Hidden → `rating_count` `0`, `reviews.rating` deleted; re-approved → `5.0` / `1` again |
| C3 | Unmanaged product untouched | PASS | Shopify | Synthetic product with another app's rating (`4.5` / `7`, written to simulate it): unchanged after sync, recompute-all and reconcile |
| C4 | Reconcile across managed products | PASS | Shopify | 2 checked, 2 ok, 0 mismatches, 0 repairs |
| C5 | Theme reads them (widget summary) | PASS | Shopify | Horizon product page shows `5.0`, "Based on 1 review" from the metafields |
| C6 | Card stars (app embed) | NOT RUN | — | Needs the app embed activated in the theme (no theme changes in this phase) |

## D. App-owned metafields

| # | Check | Status | Env | Evidence |
|---|---|---|---|---|
| D1 | Write: proxy path, storefront switch, projection | PASS | Shopify | Read back through the Admin API |
| D2 | Read by the theme extension | PASS | Shopify | Liquid renders `data-api="/apps/proofly"` and the `$app:proofly.reviews` projection |
| D3 | Missing values fail closed | PASS | Shopify | With no proxy path (Phase 2 finding) the widget rendered the projection only and made no requests |
| D4 | Another shop cannot read them | BLOCKED | — | No second authorised store with the app installed (the other store cannot install the development app) |

## E. App proxy

| # | Check | Status | Env | Evidence |
|---|---|---|---|---|
| E1 | Valid Shopify-signed request | PASS | Shopify | Storefront → `/apps/proofly/…` → 200, `Cache-Control: public, max-age=60` |
| E2 | Missing or invalid signature | PASS | Public URL | 400 |
| E3 | Signature valid for one shop, shop parameter swapped | PASS | Public URL | 400 |
| E4 | Validly signed, unknown shop | PASS | Public URL | 404 `not_found` (signed with the development app's secret) |
| E5 | Validly signed, wrong `path_prefix` | PASS | Public URL | 404 |
| E6 | Uninstalled shop | NOT RUN | — | Needs an uninstall; offline-tested |
| E7 | Configured proxy path | PASS | Shopify | `/apps/proofly` |
| E8 | Changed proxy path | NOT RUN | — | Needs a store configuration change; offline-tested |
| E9 | Locale-prefixed path | NOT RUN | — | Needs a second published language; offline-tested |
| E10 | Response privacy | PASS | Shopify | Fields exactly: rating, title, body, name, date, verified, reply. No email, customer, order, IP, ids, status, flags or source |
| E11 | 64 KB submission limit through Shopify's proxy | PASS | Shopify | 70 KB body → 413 |
| E12 | Storefront submission | PASS | Shopify | 201; stored pending; not public |

## F. Import (synthetic data only)

| # | Check | Status | Env | Evidence |
|---|---|---|---|---|
| F1 | CSV stored in PostgreSQL (`import_files`), no external storage | PASS | Shopify | Byte-for-byte; no S3/R2 in the code or the environment |
| F2 | Shopify product id match | PASS | Shopify | `matched / id` |
| F3 | Handle match | PASS | Shopify | `matched / handle` |
| F4 | SKU match | PASS | Shopify | `matched / sku` (real SKU lookup) |
| F5 | Title only stays a suggestion | PASS | Shopify | `unmatched`, `title_only_needs_confirmation`, 1 candidate |
| F6 | Unmatched stays unmatched | PASS | Shopify | `no_matching_product` |
| F7 | Ambiguous stays unmatched | PASS | Shopify | Shared SKU → `ambiguous`, 2 candidates |
| F8 | Plan limit (Free, allowance full) | PASS | Shopify | Published rows stored held; not public |
| F9 | Imported replies stored, hidden on Free | PASS | Shopify | `repliesVisible` 0; public JSON `reply: null` |
| F10 | Pending reviews stay private | PASS | Shopify | Stored pending; not in the projection or the proxy |
| F11 | Resume after an interruption | PASS | Shopify | **First run FAILED:** resumed seconds later, the report counted 1 held review instead of 3 (search lag). Fixed in `3ac5474`; re-run: 4 imported = 2 held + 2 pending |
| F12 | Retention metadata | PASS | Shopify | `finished_at` set; file kept (unresolved products); `files_deleted_at` null |
| F13 | Large import through bulk operations | PASS | Shopify | Phase 3: 300 rows, one bulk operation, 25 s on Shopify's side; counts matched a full recount |

## G. Webhooks

| # | Topic | Status | Env | Evidence |
|---|---|---|---|---|
| G1 | `products/create` | PASS | Shopify | 240 deliveries processed (12 → 252 rows) |
| G2 | `products/update` | PASS | Shopify | Rename reflected with Shopify's `updatedAt` within seconds |
| G3 | `products/delete` | PASS | Shopify | Row marked deleted (kept, never re-attached) |
| G4 | HMAC verification with the real secret | PASS | Shopify | All product deliveries accepted by `authenticate.webhook` |
| G5 | `app/uninstalled` | NOT RUN | — | Needs an uninstall (authorisation required) |
| G6 | `customers/data_request` | UNVERIFIED | Shopify | `shopify app webhook trigger` enqueued a sample delivery (sample shop, so nothing to record); a real customer event needs a customer and an admin request |
| G7 | `customers/redact` | UNVERIFIED | Shopify | As G6 |
| G8 | `shop/redact` | NOT RUN | — | Not triggered by design; offline-tested |
| G9 | `app/scopes_update` | NOT RUN | — | Needs a scope change and a deploy |

## H. Admin UI (embedded in Shopify Admin)

Pages were checked by the heading each page hands to Shopify's title bar (only rendered after its loader succeeds).
The browser pane was hidden, so no screenshots and no access to the app frame's console.

| # | Page | Status | Env | Evidence |
|---|---|---|---|---|
| H1 | Authentication and embedding | PASS | Shopify | Loads inside Shopify Admin; App Bridge navigation registered |
| H2 | Dashboard | PASS | Shopify | Renders |
| H3 | Reviews (list, filtered) | PASS | Shopify | Renders |
| H4 | Review detail | PASS | Shopify | **First check FAILED:** every storefront-submitted review crashed the page. Fixed in `b5a31b2`; re-checked live |
| H5 | Imports and import detail | PASS | Shopify | Renders ("Import · completed with warnings") |
| H6 | Products | PASS | Shopify | Renders |
| H7 | Plan | PASS | Shopify | Renders |
| H8 | Settings and storefront connection | PASS | Shopify | Renders |
| H9 | Export: data | PASS | Shopify | 313 rows, 16 columns, no email, customer or order id |
| H10 | Export and problem-report downloads in Admin | UNVERIFIED | — | Needs the browser pane visible to click the download |
| H11 | Error states (unknown review or import id) | UNVERIFIED | Shopify | Server answers 404 and the error page renders without a title; content not visible |
| H12 | Loading states | UNVERIFIED | — | Needs a visible pane |
| H13 | No console errors in the app frame | UNVERIFIED | — | The app frame's console is not readable here. Shopify Admin's own console shows two React Router 404 lines that cannot be attributed to Proofly |
| H14 | Theme Editor deep link (add block) | PASS | Shopify | The owner added the Review widget to Horizon through the deep link (Phase 2) |

## I. Production container, startup and database

| # | Check | Status | Env | Evidence |
|---|---|---|---|---|
| I1 | Build the production image | BLOCKED | — | Docker is not installed (not installed for this purpose) |
| I2 | Image contents (no `.env`, database, fixtures, tests, storage, secrets) | BLOCKED | — | Needs a built image. `.dockerignore` and the runtime stage are checked offline |
| I3 | Runs as the non-root user | BLOCKED | — | Needs a built image. Dockerfile `USER node` checked offline |
| I4 | Start command works as the non-root user | PASS | Local prod | **Defect found by review:** the start command regenerated the Prisma client as `node` (root-owned `node_modules` → EACCES). Fixed in `d880888`; the fixed command applied 16 migrations to a fresh database and served |
| I5 | Startup refuses an incomplete production environment | PASS | Local prod | Exit 1 with all six problems listed (no `.env` present) |
| I6 | Startup succeeds with safe configuration; `/healthz` | PASS | Local prod | `200 ok`, `no-store`; landing 200; `/app` without Shopify auth refused (410) |
| I7 | Maintenance entry point runs in the production environment | PASS | Local prod | Exit 0 on a fresh database |
| I8 | Migrations apply to a fresh database | PASS | Local DB | 16 migrations |
| I9 | Migrations are idempotent | PASS | Local DB | Second run: no pending migrations |
| I10 | RLS forced on every table with `shop_id`, with a tenant policy | PASS | Local DB | 9 tables, including `import_files` |
| I11 | App role cannot bypass RLS | PASS | Local DB | `proofly_app`: not superuser, no BYPASSRLS |
| I12 | Deletion records protected | PASS | Local DB | App role has INSERT and SELECT only on `shop_deletions` |
| I13 | Cross-tenant isolation suite | PASS | Offline | Part of the 246-test suite (isolation, database, privacy) |
| I14 | Managed PostgreSQL | BLOCKED | — | No managed database provisioned |
| I15 | Hosting, hourly scheduler | BLOCKED | — | No hosting provisioned |

## J. Maintenance

| # | Check | Status | Env | Evidence |
|---|---|---|---|---|
| J1 | Real run against the dev database (Shopify recount) | PASS | Shopify | Proofly Test recounted from Shopify |
| J2 | Partial failure (one shop's Shopify calls fail) | PASS | Shopify | **First run FAILED:** a shop whose token Shopify refused (404) crashed the whole run. Fixed in `92c95f3`; now skipped and reported (`failedShops`), others maintained, exit 1 for alerting |
| J3 | Repeat execution | PASS | Shopify | Second run: no second recount |
| J4 | No external file storage expected | PASS | Shopify | No S3/R2 code, settings or orphan sweep (removed in Phase 4) |
| J5 | Stalled imports, 30-day retention, unresolved-product exception, rate-limit purge, deleted shops | NOT RUN | — | No such data was due on the dev database; offline-tested |

## K. Performance

| # | Check | Status | Env | Evidence |
|---|---|---|---|---|
| K1 | Lighthouse (performance, accessibility, best practices, SEO) | BLOCKED | — | Lighthouse is not installed, and the development storefront is password-protected |
| K2 | Web Vitals on a product page with the widget | UNVERIFIED | Shopify | Indicative only (hidden pane): LCP 908 ms, CLS 0, DOMContentLoaded 770 ms; Proofly JS 9.2 KB and CSS 10.5 KB (uncompressed); 10 reviews rendered from the projection; 0 requests to Proofly |

## Store state after this phase

- **Products created:** 240 synthetic draft products ("Proofly Synthetic 001–240", tag `proofly-synthetic`).
- **Products modified:** 5 synthetic (001 renamed; 002 given a simulated other-app rating; 005–007 given SKUs).
- **Products deleted:** 1 synthetic (240).
- **Themes changed:** no (in this phase).
- **Billing charges:** $0 (no subscription, no test charges).
- **Imports created:** 2 synthetic (`validationcsv`: 7 rows; `validation2csv`: 4 rows).
- **Test reviews created:** 9 (1 storefront submission, 8 imported). Total fictional reviews in the store: 313.
- **Customer data used:** no.

## Remaining items: offline coverage and the minimum action to verify

Every item below is covered offline by the test named, except where stated; none has a regression gap that justifies
more tests.
What is missing is only the real-world run.

| Items | Offline coverage | Minimum action | Who |
|---|---|---|---|
| A5, A8, E6, G5 (uninstall, reinstall) | `lifecycle`, `projection` (uninstall/reinstall), `isolation` | Uninstall Proofly Dev on Proofly Test, open a product page (widget gone), reinstall, open the app; then run maintenance once and reload the page (widget renders from the projection again) | You (Shopify admin), then me |
| G6, G7 (customer webhooks) | `privacy` (compliance topics) | Create a synthetic customer on Proofly Test; use "Request customer data" and "Erase personal data"; I check the audit log | You (Shopify admin) |
| G9 (`app/scopes_update`) | `lifecycle` checks the scope configuration; the handler is Shopify's template (updates the stored session's scope), not tested separately | Only when the scopes next change: deploy and approve | You (deploy) |
| G8 (`shop/redact`) | `privacy` (redact) | Not run by design (deletes the tenant 48 h after an uninstall) | — |
| C6 (card stars) | `storefront` (card embed) | Turn on the "Product card stars" app embed on a theme, view a collection page | You (Theme Editor) |
| E8, E9 (changed / locale proxy path) | `sync` (proxy paths), `storefront` (locale) | Change the app proxy path in the store; publish a second language | You (store settings) |
| B4, B5 (stale / duplicate webhooks) | `sync` (stale updates, idempotent webhooks) | None: Shopify cannot be made to produce them on demand | — |
| D4 (another shop) | `isolation`; app-owned metafields are per app and shop (Shopify) | A second development store with the app installed | You (create a store) |
| H10–H13 (downloads, error and loading states, frame console) | `privacy` (export route), `guided-import` (report), `isolation` (404s) | Keep the browser pane visible during one admin pass | You (show the pane) |
| K1, K2 (Lighthouse, Web Vitals) | `storefront` (JS/CSS budgets) | Run Lighthouse on a product page of a storefront without a password (production or a demo store) | Infrastructure |
| I1–I3 (image), I14, I15 (managed DB, scheduler) | `production` (image contents, start command, environment) | Build the image where Docker exists; provision hosting and managed Postgres; schedule `npm run maintenance` hourly and alert on exit 1 | Infrastructure |
| J5 (maintenance cases with nothing due) | `privacy` (retention, stale imports, rate limits) | None: they run as data becomes due | — |

## Authorisation needed for the remaining items

- **Uninstall and reinstall Proofly Dev on Proofly Test** (A5, A8, E6, G5): uninstalling deletes the app's own data in
  Shopify (projections, app settings); merchant-owned reviews stay.
- **Theme changes** (C6 card stars embed; other themes): activating the app embed, or installing more themes.
- **Store configuration** (E8, E9): changing the app proxy path; publishing a second language.
- **A synthetic customer** (G6, G7): create one in Shopify admin, then use "Request customer data" and "Erase
  personal data".
- **Visible browser pane** (H10–H13, K2): no authorisation, just the pane on screen for screenshots.
- **Docker, managed Postgres, hosting** (I1–I3, I14, I15).

## L. Production app on Render (2026-10-08)

Production app "Proofly" (CHRISPSDesign, version proofly-2) on `https://proofly-22x6.onrender.com` (Render + Neon),
installed on the development store **Proofly Demo** (`proofly-demo.myshopify.com`, CHRISPSDesign; created for this
and for the listing demo). Shopify assigned the app handle **`proofly-8`** (Render `SHOPIFY_APP_HANDLE` updated).

| # | Check | Result |
|---|---|---|
| L1 | Install consent shows only products + custom data (+ default store-owner view) | PASS |
| L2 | First open after install | **FAIL → fixed** (`2cdff37`): concurrent first requests raced in `registerShop` (P2002, "Application Error"); retry-once + `ON CONFLICT DO NOTHING`, regression test added |
| L3 | Dashboard after fix: Free plan, allowance 100, zero reviews | PASS |
| L4 | Plan page reconciles with live Shopify billing ("Free · confirmed with Shopify") | PASS |
| L5 | "Change plan in Shopify" opens `/charges/proofly-8/pricing_plans` with the 5 plans, 7-day trials, "Free to test" on a dev store | PASS |
| L6 | Choose Growth (monthly, $0 test) → approve → return `/app/plan?plan_handle=growth` → "confirmed with Shopify: Growth", allowance 5,000 | PASS |
| L7 | Test subscription labelled "test subscription (no charge)" | UNVERIFIED: label absent; Shopify's dev-store "free to test" subscription may not set `test: true`. Dev stores only |
| L8 | Review widget block added to Proofly Demo's product template (theme editor deep link) and rendered | PASS |
| L9 | Widget in the narrow product-info column | **FAIL → fixed** (`a835291`, released as proofly-3): viewport media query forced the ~720px header and clipped "Write a review"; now an `@container` query |
| L10 | Demo catalogue (6 products, `docs/app-store/demo-catalogue.json`) created with `shopify app execute` (productSet); `products/*` webhooks delivered (all 200) | PASS |
| L11 | Reviewer sample CSV import: 8 rows → 6 imported (handle ×4, SKU ×1), 5 published, 1 pending; title-only row asks for a manual decision; unknown handle unmatched | PASS |
| L12 | Moderation: approve the pending review → "Review published. Storefront rating updated." | PASS |
| L13 | Storefront (theme preview): Stoneware Mug shows 4.5 ★ "Based on 2 reviews" with the distribution | PASS |
| L14 | Manual match of the title-only row | NOT RUN: native `<select>` inside the admin iframe can't be driven from the automation pane |
