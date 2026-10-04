# Proofly — Public App Roadmap

From the validated single-store prototype to **Proofly**, a multi-tenant Shopify
App Store app. Brand: [BRAND.md](BRAND.md) · V1 scope: [PRODUCT-SPEC-V1.md](PRODUCT-SPEC-V1.md).

> **STATUS: AUDIT + PLAN ONLY. Nothing in this document has been implemented. The commercial refactor has
> not been approved.** No Shopify connection, credentials, Partner app, billing, hosting or deployment exists.
> No merchant store or theme has been touched.
>
> **Decisions recorded 2026-10-03** (§0). V1 scope, data model and architecture are specified in
> [PRODUCT-SPEC-V1.md](PRODUCT-SPEC-V1.md); this roadmap covers the audit and implementation sequence.

---

## 0. Decisions (2026-10-03)

| Topic | Decision |
|---|---|
| Distribution | **Public Shopify App Store distribution.** No merchant-specific production app, config or bypass. |
| Sequence | **Local → Shopify development store → App Store review → first launch-merchant installation (ordinary merchant, same production app) → public merchant installs.** |
| Brand | **Proofly** (locked 2026-10-03). Official logo `brand/proofly-logo.png`, guidelines in BRAND.md. Legacy providers are only import source adapters. Never customer-facing: prototype, merchant or legacy-provider names. Storefront white-label by default. |
| Source of truth | **PostgreSQL is canonical.** Shopify `reviews.rating` / `reviews.rating_count` metafields are compatibility/cache data only, written from the DB and never read back as the review database: *our database → Shopify rating/count compatibility layer → storefront.* |
| Reviewer data | No reviewer email by default. Never collect or expose reviewer IP, country, customer account information or other unnecessary personal data. Core review data: rating, title, body, reviewer name, product, date, optional images. Email/customer data only when a specific future feature needs it. |
| Verified purchase | **Moved to V1.1** together with automated review requests and order-based review request links. V1 works with **no** order/customer access and **no** protected customer data. Request protected-data access only when V1.1 is ready. |
| V1 scope | As listed in PRODUCT-SPEC-V1 §4 (storefront, admin incl. export, dashboard metrics and Growth+ advanced analytics, migration, infrastructure). |
| V1 exclusions | AI review generation/moderation, automated review-request email, SMS, verified purchase, AI analytics, loyalty, rewards, CRM, email marketing. No scope creep into a marketing platform. |
| Positioning | **Review migration + review management + storefront reviews.** Onboarding makes migration first-class: “Bring your existing reviews with you” → upload → match products → validate → import → add review block → publish. Only data the merchant is authorised to export/use. |
| Storefront design | Premium, clean, fast, theme-compatible, responsive, native-looking, configurable. No iframe aesthetic, no forced “Powered by”. |
| Images | Originals in private object storage; storefront gets optimised WebP via CDN. The offline backup stays completely separate from production storage. |
| Hosting | Managed Node hosting, managed PostgreSQL, Cloudflare R2, Cloudflare CDN. Primary region Canada or US. No multi-region in V1. |
| Test data | Real merchant datasets are private test data only — never bundled, seeded, uploaded as shared data or referenced by production code; synthetic fixtures in CI; every new merchant starts at zero (ARCHITECTURE §10). |
| Tenant isolation | Every merchant table tenant-scoped; shop resolved before any data access; **database row-level security required** as a second barrier; tenant-isolation tests **mandatory and merge-blocking in CI**. |
| Billing | **Shopify App Pricing** for the App Store subscription; no Stripe. Launch prices decided (Free / $9 / $19 / $39 / $79, yearly ≈ 2 months free) — see ARCHITECTURE §6. Entitlements centralised. |
| Storefront architecture | Shopify-native first: ratings, summary and the first page of reviews render from Shopify metafields with no Proofly call; backend only for interaction, writes, management, migration, images. See ARCHITECTURE.md. |

The decisions above resolve D1–D6 of the original audit (see §11).

---

## 1. Starting point

The commercial codebase starts from the validated prototype's generic engineering (Shopify React Router app, Prisma/
Postgres, theme app extension, app proxy, media pipeline, moderation, submission validation). Carried-forward,
excluded and generalised components are listed in [BASELINE.md](BASELINE.md). Remaining refactor work is organised in
the checkpoints below: tenant boundary, encrypted sessions, generic importer, entitlements and billing, product sync,
compliance processing, per-environment configuration, V1.1 feature removal from the V1 build, and listing material.

---

## 2. Target architecture

```
Shopify App Store ─► OAuth / managed install ─► Embedded admin (App Bridge, Polaris web components)
                                                     │ session token (JWT) → shop resolved server-side
Storefront (any OS 2.0 theme)                        ▼
  ├─ App block "Product reviews" ──┐        Node app (React Router 7) ── tenant repository ── Postgres
  ├─ App embed "Product card stars"├─ /apps/<proxy>/* (HMAC) ─►  shop resolved from signed `shop` param
  └─ Native theme ratings ◄── reviews.rating metafields (synced per shop)       │
                                                     ├─ Jobs: product sync, imports, metafield sync, GDPR deletion
                                                     ├─ Storage: R2 private originals / public WebP (s/<shop>/…)
                                                     └─ Billing: Shopify App Pricing → subscriptions → entitlements
```

Data flow: **PostgreSQL (canonical) → Shopify rating/count metafields (compatibility cache) → storefront.**

Environments: **development** (local Postgres, dev stores, `shopify app dev`), **staging** (separate Partner app +
DB + buckets, dev stores only), **production** (App Store app). Each has its own `shopify.app.<env>.toml`,
secrets, database and buckets. No environment can reach another's data. Hosting: managed Node + managed
PostgreSQL + Cloudflare R2 + Cloudflare CDN, single primary region (Canada or US); no multi-region in V1.

---

## 3. Database changes

All merchant tables gain `shop_id uuid not null references shops(id)` and indexes that lead with `shop_id`.

| Table | Key changes |
|---|---|
| `shops` (new) | `id`, `shopify_shop_id` (unique), `shop_domain` (unique), `shop_name`, `access_token_encrypted`, `scopes`, `plan_id`, `subscription_status`, `installed_at`, `uninstalled_at`, `redact_requested_at`, `deleted_at`, timestamps |
| `shop_settings` (new) | `shop_id` PK; `widget_enabled`, `review_submission_enabled`, `photo_reviews_enabled`, `moderation_enabled` (auto-publish when false), `theme_settings` jsonb, `display_settings` jsonb, timestamps (V1.1 adds `verified_purchase_enabled`, `email_settings`) |
| `products` | + `shop_id`; unique `(shop_id, shopify_product_id)`; + `deleted_at` (product removed in Shopify: reviews kept, hidden) |
| `reviews` | + `shop_id`; `product_id` FK → `products.id` (internal uuid, replaces FK on Shopify id); unique `(shop_id, source, source_review_id)`; + `content_hash` (duplicate detection), `import_job_id`; keep `flags`, `imported`, `verified_purchase` (always false in V1); **drop** `reviewer_email`, `shopify_customer_id`, `shopify_order_id`, `submitter_ip_hash`. V1.1 adds `verification_source`, `verified_at` |
| `review_images` | + `shop_id`; keys prefixed `s/<shop_id>/` |
| `review_replies` | + `shop_id` |
| `review_requests` | **Not in V1** (dropped from the V1 schema). V1.1: `shop_id`, `product_id`, `customer_reference`, `order_reference` (Shopify GIDs only, no PII), `token_hash`, `sent_at`, `completed_at`, `expires_at`; unique `(shop_id, order_reference, product_id)` |
| `subscriptions` (new) | `shop_id`, `shopify_subscription_id`, `plan_id`, `status`, `trial_ends_at`, `current_period_end`, timestamps |
| `audit_log` | + `shop_id` (nullable only for platform events); `entity` → `entity_type`, `details` → `metadata` |
| `import_jobs` (new) | `shop_id`, `status`, `source_preset`, `mapping` jsonb, counts, `report` jsonb, `file_key`, timestamps |
| `rate_limits` (new, or Redis) | `key`, `window_start`, `count` |
| `Session` (template) | Replaced by encrypted session storage (same shape, `accessToken` encrypted) |

**Local development database only (never staging/production):** schema migrations contain no merchant data. Any private
dataset used locally lives in a development tenant created by a local-only script.

---

## 4. Shopify changes

| Topic | Plan |
|---|---|
| Distribution | **Public** (decided; cannot be changed later). Separate Partner apps for staging and production. |
| Release sequence | Local → development store → App Store review → first launch-merchant installation (ordinary merchant) → public installs |
| Auth | Keep template: Shopify-managed installation + token exchange + session tokens; OAuth immediately on install/reinstall; redirect into app UI. No custom merchant login. |
| Scopes (core) | `read_products` (sync), `write_products` (only to write `reviews.rating` / `reviews.rating_count` standard metafields; justify in listing). Nothing else for core. |
| Scopes (V1.1 only) | `read_orders` for verified purchase / review requests — **Level 1** protected customer data (IDs + line items only, no name/email/address/phone fields queried); Level 2 only if review-request email needs customer email. Not requested in V1. `read_customers` never needed. |
| Product sync | Initial bulk operation (`products` id/handle/title/status/featured image) on install/onboarding; `products/create`, `products/update`, `products/delete` webhooks; handle renames update automatically; deleted products soft-delete. |
| Webhooks | `app/uninstalled`, `app/scopes_update`, `products/*`, compliance (`customers/data_request`, `customers/redact`, `shop/redact`). `orders/fulfilled` only in V1.1. |
| App proxy | Keep (`/apps/<subpath>`); every handler resolves the shop from the HMAC-signed `shop` param and rejects inactive shops (uninstalled → empty 404). Proxy path passed to JS from Liquid because merchants can customise it per store. |
| Metafields | Keep standard `reviews.*` definitions (enable per shop on install); **compatibility cache only** — written from Postgres per shop in a job, batched (25 per `metafieldsSet`), throttle-aware; never read back as review data. |
| API version | Pin one supported version everywhere; quarterly upgrade checklist. |

---

## 5. Multi-tenant security changes

1. **Tenant context first.** A single `requireShop(request)` per entry point:
   admin → `authenticate.admin` → `session.shop` → active `shops` row;
   proxy → `authenticate.public.appProxy` (HMAC) → signed `shop` param → active row;
   webhooks → `authenticate.webhook` → `shop` header → row.
   Browser-supplied shop/product/review IDs are never trusted for scoping.
2. **Repository layer.** `app/lib/db/*.server.ts` functions all take `shopId` as the first argument and put it in every
   `where`. Route files stop importing `prisma` directly (lint rule: `no-restricted-imports` of `db.server` outside
   `app/lib/db`). Lookups by id use `findFirst({ where: { id, shopId } })` → `404` when missing (never `403`, so
   existence isn't leaked).
3. **Defence in depth:** Postgres row-level security on merchant tables using `SET LOCAL app.shop_id` inside a
   transaction per request (Prisma `$transaction` + `set_config`). **Required** (decision): policies created in CP1,
   enforced and tested in CP11.
4. **Storage:** object keys prefixed by `shop_id`; public URLs unguessable; originals never public.
5. **Isolation test suite (mandatory, merge-blocking in CI):** two synthetic shops A/B with overlapping Shopify IDs and source review IDs. Tests:
   A reads B's review/product/image by id → 404; A moderates/replies to B's review → 404 and B unchanged; A's proxy
   `ratings?handles=` with B's products → empty; A's import cannot create rows under B; identical `source_review_id`
   in A and B both import; uninstalled shop's proxy → 404; GDPR redact for A touches only A.
6. Tokens: access tokens encrypted at rest (AES-256-GCM, key rotation supported); per-env secrets; no secrets in logs.
7. Rate limits keyed by `shop_id` + transient hashed IP, stored centrally with short expiry; IPs are never stored with
   reviews or exposed.

---

## 6. Theme app extension changes

| Item | Change |
|---|---|
| Naming | Proofly theme extension; blocks “Proofly Reviews”, “Proofly Rating”, “Proofly Card Ratings”; all customer-facing copy in `locales/*.json` (en first); internal `pf` prefixes renamed during the refactor |
| Product reviews block | Same UI; `Response from {{ shop.name }}`; write-review form without email field; Verified Purchase badge component kept but never shown in V1 (no verified reviews until V1.1); block settings: heading, star colour, show photos, show sort/filters, show write-review, JSON-LD on/off, proxy path (default `/apps/<subpath>`) |
| Theme inheritance | Keep inheriting font; colours via CSS custom properties exposed as block settings; all selectors prefixed and scoped under the block root (no global resets) |
| Product card ratings | **Implemented (CP3–4), deterministic hierarchy:** (1) standard `reviews.rating` metafields kept correct for Proofly-managed products; (2) Rating summary app block placed by the merchant in the Theme Editor (product auto-filled); (3) Product card stars app embed as the automatic fallback; (4) never theme code. See [ARCHITECTURE.md §11.8](ARCHITECTURE.md) |
| Star rating block | Small app block for product info sections (stars + count linking to the widget) — works in any OS 2.0 product section that accepts app blocks |
| Branding | No “Powered by” in storefront components (App Store rule: app branding only where customers directly interact with branded elements) |
| QA | Test in Dawn + 3 popular free themes in the theme editor and storefront; no console errors; Lighthouse impact measured |

---

## 7. Billing changes

- **Shopify App Pricing (managed pricing)**: plans defined in the Partner Dashboard (max 8 public plans; trials per
  plan). Merchant selects/approves on the Shopify-hosted page
  `admin.shopify.com/store/<handle>/charges/<app_handle>/pricing_plans`; app is redirected back with `plan_handle`.
  App must not call `appSubscriptionCreate` when managed pricing is on.
- **Implemented (checkpoint 5):** state comes from the shop's Admin API (`currentAppInstallation`, `planHandle`),
  triggered by the `plan_handle` redirect, token exchange, staleness and on demand (no subscription webhooks since
  2026-04-28) → writes `billing_state` + `subscriptions` (row-level security). Partner API optional. See
  [BILLING.md](BILLING.md).
Checkpoint 6 (import engine + CSV importer: validation and matching before writes, resumable batches, idempotent
re-imports, date-ordered admission, ZIP photos) complete locally — see [IMPORT.md](IMPORT.md). The wizard, manual
matching and remote image fetching remain checkpoint 8.
**Title is never an automatic product-matching key.** The hierarchy is ID → handle → SKU → other exact identifiers →
merchant-confirmed manual match. Exact-title matches are suggestions only and require explicit merchant confirmation
(manual matching UI: checkpoint 8, not built yet). Near, fuzzy or similar titles are never used — not even as suggestions.
Checkpoint 6 decision (reply visibility): Imported replies are retained regardless of plan. Public reply visibility is feature-gated. Plans without Replies store imported replies privately and suppress them from storefront responses. Upgrading restores eligibility without requiring re-import.
- **Entitlement service**: one plan config (fields and per-plan values in ARCHITECTURE §6.2 — limits for
  published reviews, imports, storage; replies, advanced customisation, advanced analytics, API access, review
  requests, verified purchase, each behind a `released` flag) read by `entitlements.server.ts`. All gating calls go through the entitlement layer; no plan names, prices or allowances elsewhere in code (test-enforced).
- Over-limit behaviour: never delete or hide genuine reviews; new reviews are stored but not auto-published past the
  limit, with an admin banner to upgrade (avoids “hiding reviews” concerns while staying fair).
- Plans: **launch pricing** Free $0 (100) · Starter $9 / $90 yr (1,000) · Growth $19 / $190 yr (5,000) · Pro $39 / $390 yr
  (25,000) · Scale $79 / $790 yr (100,000) — details, storage and open questions in ARCHITECTURE §6/§9.
  Unbuilt features (API access, review requests, verified purchase) are never listed until shipped. Resolved rules
  (grandfathered downgrades, explicit publish after upgrade, 500 MB Free media, unlimited products): ARCHITECTURE §9.
- Upgrade/downgrade self-serve (App Store requirement); downgrade keeps data, applies limits going forward.
- No Stripe or off-platform billing.

---

## 8. App Store compliance gaps (acceptance criteria)

| Requirement | Current | Gap / action |
|---|---|---|
| Latest App Bridge, embedded admin | ✅ template | Keep updated; Polaris web components |
| GraphQL Admin API only | ✅ | Keep |
| OAuth immediately on install/reinstall, redirect to app UI | ✅ template | Test reinstall path explicitly |
| Shopify billing for charges, self-serve plan changes | ❌ | CP9 |
| Theme app extensions only, no theme code edits, onboarding instructions | ⚠️ embed relies on existing theme markup | CP5 + onboarding deep links |
| Minimal scopes | ✅ `read_products`, `write_products` only (CP2) | V1.1 asks for order/customer scopes when built |
| Protected customer data | ⚠️ current build reads orders/customers | V1 uses none; apply for Level 1 only when V1.1 is ready |
| Compliance webhooks actually honoured | ⚠️ shop/redact only logs | CP10 |
| No fake/incentivised reviews; neutral request wording | ✅ no incentives | Keep request copy neutral; no “review for discount” features; verified only with evidence |
| Merchants cannot fake “verified” | ✅ no UI to set it | Keep; any future merchant-evidence path requires evidence + audit |
| Storefront branding rules | ✅ none | Keep none |
| Data returned to merchant admin | ✅ reviews live in admin | Add CSV export of reviews |
| Functional, error-free UI; performance | ⚠️ admin never run in Shopify | CP3/CP13: run on dev stores, Lighthouse/Web Vitals budget (storefront ≤ ~10 KB gz product page, ~2 KB elsewhere) |
| Listing: privacy policy, support contact, screenshots, demo store | ❌ | CP13 |

---

## 9. Checkpoints

Each checkpoint ends with: typecheck + lint + build, unit + integration + tenant-isolation tests, the **new-merchant-
starts-empty** test, the importer test against the **synthetic equivalent-size fixture** (CI) — plus, locally, the
private-dataset validator when explicitly authorised — a production-artefact scan proving no fixture data ships, a commit
and a short report. No checkpoint touches a live merchant store.

| # | Checkpoint | Scope | Exit criteria | Size |
|---|---|---|---|---|
| 1 | Multi-tenant database | §3 schema, backfill migration of local data, repository layer skeleton | New tenant starts empty; composite uniques enforced; local fixture (dev tenant) still validates | M |
| 2 | Shopify authentication | Encrypted session storage, `requireShop()`, shop lifecycle rows on install, remove login page from prod nav | Install/reinstall on a dev store creates/reactivates `shops`; tokens encrypted at rest | S |
| 3 | Embedded admin | Home dashboard, Reviews (table/filters/actions), Products, Settings shells — all scoped | All pages render in Shopify admin on a dev store; no cross-shop data | M |
| 4 | GraphQL sync | Bulk product sync, `products/*` webhooks, metafield definition + sync job | 250-product dev store syncs; handle rename + delete handled; throttle-safe | M |
| 5 | Theme app extensions | Rename, locales, settings, proxy-path setting, star-rating block, card-star strategy (§6) | Works in Dawn + 3 themes; zero console errors; size budget held | M |
| 6 | Review storefront | Scope proxy routes to shop; inactive-shop handling; JSON-LD per block setting | Two dev stores show only their own reviews/ratings | S |
| 7 | Review submission | Shop settings respected (photos/moderation/submission), central rate limit, no email field, verified-purchase and review-request code removed from V1 | Submission works with only `read_products`/`write_products`; no personal data beyond reviewer name stored | M |
| 8 | Import system (migration-first onboarding) | In-app CSV importer + mapping + product matching + preview/validation/duplicate detection/report, image ZIP + SSRF-safe URL fetch, legacy-provider presets, review CSV export, onboarding flow | Equivalent-size synthetic dataset imports with 0 unexplained mismatches; where explicitly authorised, a private dataset imports locally into a fresh development tenant with 0 mismatches vs its source | L |
| 9 | Billing | Five App Pricing plans (launch prices), Admin API verification + reconciliation (Partner API optional), entitlements service, limit holds/releases, Plan page — **done locally as the user's checkpoint 5** | Trial/upgrade/downgrade/cancel/reinstall tested on dev store test charges | M |
| 10 | Privacy / uninstall | Uninstall lifecycle, real `shop/redact` deletion (DB + storage), `customers/redact`, `customers/data_request` output | Deletion job verified; audit trail; storefront dark after uninstall | S |
| 11 | Security isolation | Isolation suite in CI, RLS enabled, lint rule, dependency audit, secrets review | All isolation tests green; RLS on; no unscoped queries (lint) | M |
| 12 | Development-store import QA | Only where explicitly required: a development store with test products; the private fixture *copy* (or synthetic data) imported through the generic importer — never via seed data, no live-store access, deleted afterwards | 0 unexplained mismatches; owner review | S |
| 13 | App Store readiness | Listing, privacy policy, support, screenshots, performance report, reviewer test plan, demo store | Internal pre-submission checklist 100% | M |
| — | After approval | App Store review → **the first launch merchant installs the production app as an ordinary merchant** (explicit owner authorisation; theme redesign finished) → public merchant installs | Owner sign-off at each step | — |

**Progress:** Checkpoint 1 (multi-tenant foundation, incl. shop lifecycle, encrypted sessions and the isolation suite) complete locally — see [TENANCY.md](TENANCY.md).
Checkpoint 2 (Shopify-managed installation + token exchange, manual login removed, onboarding, session lifecycle, V1 scopes reduced to `read_products,write_products`, order/customer code paths removed) complete locally; dev-store install verification still pending explicit authorisation.
Checkpoint 3 (Shopify-native storefront: Review widget + Rating summary app blocks, Product card stars app embed,
published-only / plan-limited visibility, handle-batched card ratings) complete locally — see [STOREFRONT.md](STOREFRONT.md).
Note: the user-approved order puts the storefront extension here; roadmap rows 5–6 are largely covered by it (locales,
multi-theme verification remain; the proxy-path setting landed in CP4).
Checkpoint 4 (product catalogue sync + `products/*` webhooks, canonical aggregate, rating-cache ownership
(`unmanaged` / `proofly_managed`), metafield sync + reconciliation, per-merchant proxy path, opaque public media ids,
API version 2026-10) complete locally — see [ARCHITECTURE.md §11](ARCHITECTURE.md). Real-store verification remains.
Checkpoint 5 in the user-approved sequence (= roadmap row 9, billing): Shopify App Pricing reconciliation, canonical
plan configuration, entitlement service, plan-limited / storage-limited admission (date order only), grandfathered
downgrades, explicit "Publish eligible reviews", Plan page, generic import core — complete locally; see
[BILLING.md](BILLING.md).

Recommended order: 1 → 2 → 11 (isolation tests early, then kept green) → 3 → 4 → 6 → 5 → 7 → 8 → 10 → 9 → 12 → 13.

---

## 10. First launch merchant (decided)

The first launch merchant runs the identical code, settings model and storefront as every merchant, starts with zero
data at installation and imports its own export. No custom-distribution app and no bypass: installation happens only
after App Store approval and explicit owner authorisation.

---

## 11. Decisions and risks

| # | Item | Status |
|---|---|---|
| D1 | Commercial app name and brand | **Decided: Proofly** (brand lock 2026-10-03). Still needed from the brand owner: SVG master, mark-only App Store icon (1200×1200), reversed version. Proxy subpath and extension handle fixed during CP5 |
| D2 | First launch merchant | **Decided:** development store, then App Store approval, then ordinary-merchant install. No bypass. |
| D3 | Hosting + data region | **Decided:** managed Node + managed PostgreSQL + Cloudflare R2/CDN; Canada or US; single region. Provider choice open. |
| D4 | Reviewer email | **Decided:** not collected by default; no IP/country/customer data |
| D5 | Pricing | **Decided:** launch pricing in ARCHITECTURE §6.1; open details P1–P7 (§9 there) |
| D6 | Verified purchase | **Decided:** V1.1, with automated review requests and order-based links |
| R1 | Merchant-customised proxy path | Mitigated by proxy-path setting passed from Liquid |
| R2 | Card stars on themes without metafield support or hooks | Native metafield path + documented hook + legacy mode; onboarding explains |
| R3 | Bulk imports of large catalogues | Background jobs with progress, batched writes, resumable |
| R4 | Shopify API/library churn | Quarterly version upgrades; integration tests on dev stores |
| R5 | V1.1 review-request emails need customer email (Level 2) | V1 has no review requests; in V1.1 deliver via the merchant's own Shopify email tooling or apply for Level 2 |

---

## 12. Out of scope for V1

AI review generation, AI review moderation, automated review-request email, SMS, verified purchase, order-based
review request links, AI analytics, loyalty, rewards, CRM, email marketing, usage-based billing, multi-region
infrastructure, multi-language widget beyond locale files, Q&A, social sharing, Google Shopping review feeds,
third-party integrations, headless/Hydrogen support. V1.1 and later items: PRODUCT-SPEC-V1 §19–20.
