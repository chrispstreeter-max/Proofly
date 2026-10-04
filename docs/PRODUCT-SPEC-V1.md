# Proofly — Product Specification V1

> **STATUS: SPECIFICATION ONLY. Not implemented; the public-app refactor is not authorised.** No Shopify connection,
> credentials, Partner app, billing, hosting or deployment exists. No merchant store or theme has been touched. Sequencing: [PUBLIC-APP-ROADMAP.md](PUBLIC-APP-ROADMAP.md).
> Brand: [BRAND.md](BRAND.md).

**Proofly** is the product. The first launch merchant is an ordinary installation — never a hard-coded tenant or
special case. Legacy review providers exist in Proofly only as optional import *source adapters*; Proofly depends on
none of them.

---

## 1. Product

Proofly is a public Shopify App Store app for product reviews and review management. Merchants import their existing
reviews from another provider, match them accurately to Shopify products (with photos), display them in a fast,
native-looking storefront component, collect new reviews, moderate and respond, export their data and see basic
analytics. Multi-tenant from day one.

## 2. Target merchant

- Shopify merchants on Online Store 2.0 themes who already have reviews they don't want to lose — switching from
  another review app, recovering from a failing one, or consolidating exports.
- Small to established brands (tens to a few thousand products; up to ~10,000 reviews per store in V1).
- Merchants who care about storefront speed, accuracy and a premium on-brand look more than marketing automation.

## 3. Core problem

Changing review providers is risky: exports arrive in inconsistent formats, product mappings break, photos stay on the
old provider's servers, duplicates appear, and years of social proof can be lost. Many review widgets also look like
third-party add-ons and slow product pages down.

## 4. Value proposition

> **Bring your existing reviews with you.**

Proofly moves your reviews safely — every review on the right product, every photo preserved, every skipped row
explained — then shows them beautifully and lets you manage them in one place.

## 5. Competitive differentiation

Positioning only; no claims about specific competitors are made in product or listing copy without verification.

- **Migration as the product, not a footnote:** analysis before import, explicit product matching (ID → handle → SKU →
  merchant-confirmed), duplicate detection, idempotent re-imports, downloadable error reports.
- **Accuracy you can audit:** every import has a report; nothing is silently dropped, merged or guessed.
- **Photos come with you:** images are copied into Proofly storage (private originals + optimised storefront copies),
  so nothing depends on the old provider.
- **Native, fast storefront:** theme-inheriting, white-label by default, a few KB of JavaScript, no iframes.
- **Privacy-minimal:** no reviewer email, IP or customer data needed for V1.
- **Focused:** reviews only — no bundled marketing platform.

## 6. V1 feature set

**Storefront:** star ratings · review count · review summary · rating distribution · review list · sorting ·
filtering · photo reviews · review photo gallery · review submission · merchant responses · responsive layouts ·
product-card ratings · search/collection ratings where the theme exposes product cards · empty, loading and error
states. Review list previews render a 10-review snapshot from Shopify; further pages load on demand.

**Admin:** dashboard · reviews · moderation · products · import · export · analytics (dashboard metrics on all plans; advanced analytics on Growth+) · settings · plan.

**Migration:** CSV import · source presets/adapters · product matching with manual resolution · validation ·
duplicate detection · image import · import progress · import summary · error reporting · safe/idempotent
re-import.

**Infrastructure:** multi-tenant PostgreSQL · Shopify authentication · GraphQL Admin API · Shopify Billing ·
Theme App Extensions · object storage + CDN · background jobs · webhooks · uninstall handling · GDPR deletion ·
audit logging.

## 7. V1 exclusions

AI-generated reviews · AI review writing · AI moderation · SMS marketing · email marketing · loyalty · rewards ·
CRM · customer segmentation · marketing automation · advanced customer profiles · verified purchase · automated
review-request emails · order-based review requests (V1.1) · Q&A · headless support.

V1 requests **no** protected customer data and no order or customer API access.

---

## 8. User journeys

### 8.1 Install → migrate → live
1. Merchant installs Proofly from the App Store → Shopify OAuth/managed install → Proofly opens in Shopify admin.
2. **Welcome:** “Bring your existing reviews with you.” Primary: **Import reviews**. Secondary: Start fresh.
3. Products sync in the background (progress visible).
4. **Choose source:** CSV (generic template) or a supported provider export preset.
5. **Upload** the export (+ optional images ZIP).
6. **Analysis:** reviews found · products found · images found · potential duplicates · unmatched products ·
   invalid records.
7. **Review matches:** confirm automatic matches, resolve unmatched products manually or skip them.
8. **Import:** choose “publish imported reviews” or “hold for moderation” → live progress.
9. **Import complete:** imported · published · pending · skipped · errors · products matched · images imported;
   download the report.
10. **Add to theme:** deep link to the theme editor with the Proofly Reviews block; enable the card-ratings embed if
    needed; screenshots and instructions.
11. **Publish checklist** → “Your reviews are live.” Plan selection appears only when a feature or limit needs it.

### 8.2 Shopper
Sees stars + count on product cards and near the product title → opens the reviews section → filters (stars, with
photos), sorts, browses photos in the gallery → writes a review (rating, title, review, name, optional photos) →
“Thanks — your review will appear once it's checked” (or immediately when moderation is off).

### 8.3 Merchant daily use
Dashboard shows pending reviews → moderate (approve, reject, hide, restore) → reply publicly → counts update on the
storefront immediately; Shopify compatibility fields re-sync in the background.

### 8.4 Export / uninstall
Export reviews to CSV at any time. On uninstall, storefront components stop serving data immediately, Shopify stops
billing, data is retained until Shopify's `shop/redact`, then deleted.

---

## 9. Admin information architecture

Embedded in Shopify admin (latest App Bridge, Polaris web components). Navigation: **Dashboard · Reviews · Products ·
Import · Analytics · Settings** (+ Plan, Export within Reviews/Settings).

| Page | Contents |
|---|---|
| **Dashboard** | Onboarding checklist until complete · total, published, pending, with photos, average rating, products with reviews · pending shortcut · latest import status |
| **Reviews** (moderation) | Table: rating, reviewer, product, date, status, photos, flags, source · filters: product, rating, status, has photos, flagged, source, date range, search · bulk approve/reject/hide · **Export** filtered/all to CSV |
| **Review detail** | Text, photos, flags, source + import metadata, moderation history · approve / reject / hide / restore · reply (add/edit/remove) |
| **Products** | Product, review count, average rating, latest review, status · product detail lists its reviews |
| **Import** | New import wizard (§11) · history with reports, error CSVs, re-run (idempotent) |
| **Analytics** | All plans: dashboard metrics. Growth+ (advanced analytics): reviews over time · rating distribution · reviews by product · average rating by product · photo-review % · published vs pending vs plan-limited · import history · review growth · top-reviewed products. No AI analytics |
| **Settings** | Widget appearance (colours, star colour, density, heading) · submission (on/off, photos on/off, minimum length) · moderation (manual / auto-publish) · display (default sort, reviews per page, distribution, photos, structured data) · optional storefront attribution (off by default) |
| **Plan** | Current plan · published / allowance · plan-limited · public media used / allowance · storage-limited media · plan features (released only) · “You have N eligible reviews ready to publish.” + **Publish eligible reviews** after an upgrade · link to Shopify's hosted plan page for upgrade/downgrade |

## 10. Storefront information architecture

| Component | Delivery | Contents |
|---|---|---|
| **Product review block** | App block (product template) | Heading · average + stars + “Based on N reviews” · rating distribution (clickable filters) · Write a review · With photos · filter pills (All, 5★…1★) · sort (Most recent, Highest, Lowest) · review cards · load more |
| **Review card** | — | Stars · title · body (plain text, line breaks kept) · reviewer display name · date (shopper locale) · Verified Purchase badge only when V1.1 evidence exists · photos · merchant response (“Response from {shop name}”) |
| **Review gallery** | Within the block | Photo strip/grid of all review photos → lightbox with the originating review |
| **Review submission** | Dialog in the block | Rating (required) · title · review (required) · display name (required) · photos (optional, plan-gated) · no email · spam protection |
| **Rating summary** | Small app block for product info areas | Stars + count, links to the review block |
| **Product-card rating** | Proofly theme app extension (primary) using Shopify-native rating data (`reviews.rating` / `reviews.rating_count`) where the theme renders it | “★★★★★ 70 reviews” per product on collection, search, featured and recommendation cards where the theme renders cards; one batched request per page when needed; no theme code edits or merchant-specific markup |
| **States** | All components | Empty (“No reviews yet — be the first”) · loading (skeletons, no layout shift) · error (quiet retry message; never breaks the page) |
| **Structured data** | Review block setting | Product + AggregateRating from visible published reviews only |

White-label: no “Powered by Proofly” unless the merchant explicitly enables attribution (and only where Shopify's
storefront-branding rules allow).

---

## 11. Migration workflow

> **Checkpoint 6 status:** the import engine (upload → validation + matching → resumable batched import → date-ordered
> admission) is implemented with a minimal admin page. Steps 3–4's merchant UI (manual matching), safe `https` image
> fetching, error-CSV download and the guided wizard are checkpoint 8. Engine details: [IMPORT.md](IMPORT.md).

1. **Source** — generic CSV template or a provider preset (adapters): legacy-provider recovery exports, Judge.me, Loox,
   Okendo and others where their official exports allow. Adapters only map columns; no scraping, no calls to other
   providers' private APIs. The merchant confirms they are authorised to use the data.
2. **Upload** — CSV (UTF-8, ≤ 50 MB V1) + optional images ZIP; stored privately per shop, deleted after retention.
3. **Analyse** (background) — reviews found, products referenced, images referenced/found, potential duplicates,
   unmatched products, invalid records.
4. **Match products** (never blind):
   1. Shopify product ID where the source has it
   2. Product handle (exact)
   3. SKU (exact, any variant) where available
   4. Other exact identifiers the source provides
   5. **Controlled manual matching:** merchant picks the Shopify product for each unmatched source product; choices
      are saved per import and re-used on re-runs
   Ambiguous or unmatched → **flagged**, never guessed; unresolved rows are skipped and reported.
5. **Validate** — rating 1–5, body present, date parseable, lengths, image references resolvable, duplicates.
6. **Confirm** — publish now or hold for moderation; imported reviews are always unverified.
7. **Import** — background job with live progress; batched writes; images from the ZIP (implemented) or `https` URLs fetched safely (checkpoint 8)
   (public addresses only, size/type limits, timeouts) → private original + optimised WebP copies.
8. **Summary** — imported, published, pending, skipped, errors, products matched, images imported; downloadable error
   report.

**Idempotency:** reviews keyed by `(shop, source, source_review_id)`; when absent, a deterministic id from source
product + reviewer + date + body (SHA-256, [IMPORT.md §4](IMPORT.md)). Re-imports never duplicate and never overwrite
moderation decisions. A source id that appears twice with different content is imported for neither row (order-independent).
**Duplicates:** same reviewer + body on the same product and cross-product repeats are imported but **flagged** for
review, never silently dropped.

## 12. Data model (V1)

**PostgreSQL is canonical.** Shopify holds only derived data written from Proofly: the standard rating/count fields
and (planned, not built yet) a per-product snapshot of the first page of published reviews (see [ARCHITECTURE.md](ARCHITECTURE.md)
for the full data-placement decisions):

```
PROOFLY DATABASE → published review count/rating → Shopify compatibility fields → native theme display
```

| Table | Columns |
|---|---|
| `shops` | id, shopify_shop_id (uniq), shop_domain (uniq), shop_name, access_token_encrypted, scopes, plan_id, subscription_status, installed_at, uninstalled_at, redact_requested_at, deleted_at, created_at, updated_at |
| `shop_settings` | shop_id (PK), widget_enabled, review_submission_enabled, photo_reviews_enabled, moderation_enabled, attribution_enabled (default false), theme_settings jsonb, display_settings jsonb, created_at, updated_at |
| `subscriptions` | id, shop_id, shopify_subscription_id, plan_id, status, trial_ends_at, current_period_end, created_at, updated_at |
| `products` | id, shop_id, shopify_product_id, handle, title, status, image, review_count, average_rating, rating_1…rating_5, synced_count, synced_average, deleted_at, created_at, updated_at · **unique (shop_id, shopify_product_id)** |
| `reviews` | id, shop_id, product_id, source, source_review_id, source_product_ref, rating, title, body, reviewer_name, review_date, status (pending/published/rejected/hidden), hold_reason (moderation/plan_limit), imported, import_job_id, flags text[], content_hash, verified_purchase (false in V1), moderated_at, moderated_by, created_at, updated_at · **unique (shop_id, source, source_review_id)** |
| `review_images` | id, shop_id, review_id, media_status (published/storage_limited/processing/failed), storage_key (private original), thumb_key, large_key, original_filename, original_url, content_type, file_size, sha256, width, height, position, created_at |
| `review_replies` | id, shop_id, review_id (uniq), reply, created_at, updated_at |
| `import_jobs` | id, shop_id, source, status, mapping jsonb, file_key, images_key, analysis jsonb, counts jsonb, report jsonb, created_at, finished_at |
| `import_product_matches` | id, shop_id, import_job_id, source_product_ref, status (matched/unmatched/ambiguous), method (id/handle/sku/manual), product_id (null unless matched), reason, candidates jsonb (suggestions, incl. exact-title — never automatic), rows, created_at |
| `audit_log` | id, shop_id, actor, action, entity_type, entity_id, metadata jsonb, created_at |
| `moderation_actions` | id, shop_id, review_id, action, from_status, to_status, actor, note, created_at |
| `usage_counters` | shop_id, published_reviews, storage_bytes, updated_at (entitlement metering) |
| `rate_limits` | key (hashed), window_start, count — expires within minutes, never linked to reviews |
| `sessions` | Shopify session storage with encrypted access tokens |

Product handle/title for a review come from `products` (current) and `source_product_ref` (as imported, for audit).
**Not stored in V1:** reviewer email, IP (not even hashed alongside reviews), country, customer IDs, order IDs,
customer account data. V1.1 adds `review_requests` and verification fields (§21).

## 13. Tenant architecture

```
SHOPIFY → PROOFLY AUTHENTICATION → SHOP (tenant) → POSTGRESQL (reviews, products, images, settings,
subscriptions, audit log, imports, analytics) → STOREFRONT EXTENSIONS
```

- Shop resolved first, only from Shopify-verified context (admin session token, HMAC-signed app proxy, HMAC-signed
  webhook). Browser-supplied shop/product/review IDs are never trusted for scoping.
- Repository layer: every data function requires `shopId`; routes cannot use the DB client directly (lint rule);
  lookups are `id AND shop_id`; misses return 404, never revealing other shops' data.
- **Row-level security** on every merchant table (per-transaction `app.shop_id`) as a second barrier.
- Storage keys prefixed `s/<shop_id>/`.
- **Mandatory, merge-blocking CI isolation tests** (A ↔ B reviews, products, images, moderation, replies, imports,
  exports; colliding Shopify and source IDs; uninstalled shop serves nothing).
- No global queries, no default/fallback shop.

## 14. Shopify architecture

| Concern | Decision |
|---|---|
| Distribution | Public App Store app. No custom distribution, no store-specific bypass. |
| Lifecycle | Local development → Shopify development store → App Store testing → Shopify app review → first launch-merchant installation (ordinary merchant) → public installs |
| Auth | Shopify-managed installation, token exchange, session tokens; OAuth immediately on install/reinstall |
| API | GraphQL Admin API only |
| Scopes (V1) | `read_products` (catalogue + SKUs) and `write_products` (only for the standard rating/count fields) |
| Product sync | Bulk operation on install; `products/create`, `products/update`, `products/delete` webhooks |
| Webhooks | `app/uninstalled`, `app/scopes_update`, `products/*`, compliance topics (no billing webhook: Shopify App Pricing sends none; plan state is read from the Admin API) |
| Storefront API | App proxy, HMAC-verified per request; proxy path passed from Liquid (merchants can customise it) |
| Environments | Development, staging, production — separate Partner apps, databases, buckets, secrets; explicit production deploys |

## 15. Billing architecture

- Shopify App Pricing only (five public plans, monthly with a yearly option). No Stripe; no Billing API unless App
  Pricing cannot support a requirement.
- **Launch pricing:** Free $0 (100 published) · Starter $9/mo or $90/yr (1,000) · Growth $19/mo or $190/yr (5,000,
  shown as “Most popular” in Proofly) · Pro $39/mo or $390/yr (25,000) · Scale $79/mo or $790/yr (100,000). Yearly ≈ two
  months free (save 17%). Public/optimised media storage: 500 MB / 2 / 10 / 50 / 250 GB (Free → Scale). Products
  unlimited on all plans. API access reserved for Pro/Scale but not advertised until it exists.
- Plan state: Shopify's hosted plan page → redirect with `plan_handle` (re-check trigger only) → verified from the
  shop's Admin API (`currentAppInstallation.activeSubscriptions` → `planHandle`); re-checked on token exchange, on
  return, when stale (10 min) and on demand. Shopify App Pricing sends no subscription webhooks since 28 April 2026.
  API failures never change the plan. **Implemented in checkpoint 5:** [BILLING.md](BILLING.md).
- Central entitlement service (`app/lib/entitlements.server.ts`); features not yet built are never exposed regardless
  of plan. Shown today: review display, photo reviews and moderation on every plan; public replies from Starter;
  priority support from Growth. Imported replies are retained regardless of plan. Public reply visibility is feature-gated. Plans without Replies store imported replies privately and suppress them from storefront responses. Upgrading restores eligibility without requiring re-import.
- **Data retention rule (resolved):** plan limits cap published/displayed reviews and public media, never data
  ownership. Imports are never truncated; excess reviews are preserved as plan-limited and excess media as
  storage-limited, with counts shown to the merchant. **Upgrade:** explicit “Publish eligible reviews” action (no
  automatic publication in V1). **Downgrade:** grandfathered — published reviews and media stay visible; the lower
  allowance applies to future publishing. Selection is chronological only, never by rating or sentiment. Details:
  ARCHITECTURE §6.3, §6.3a, §9.
- Full plan matrix, limit behaviour and open pricing questions: [ARCHITECTURE.md §6, §9](ARCHITECTURE.md).

## 16. Security

Tenant isolation (§13) · Shopify authentication and signed request validation (session tokens, proxy and webhook
HMAC) · rate limiting · secure session handling · encrypted Shopify access tokens (AES-256-GCM, rotatable keys) ·
input validation and plain-text storage · output escaping (Liquid escaping, `textContent`-only rendering) · image
validation (magic bytes, size limits, re-encoding) and SSRF-safe URL fetching · audit logging of moderation, replies,
imports, settings and plan changes · GDPR deletion and uninstall cleanup · no credential leakage (secrets manager,
no stack traces in production, logs without personal data) · dependency/secret scanning in CI · encrypted backups.
V1.1 adds hashed, single-use, expiring review-request tokens.

## 17. Privacy

- Minimal data: rating, title, body, reviewer display name, product, date, optional photos. No email, IP, country or
  customer account data in V1.
- Public photo copies are re-encoded with metadata (including GPS) stripped; originals stay private and are deleted
  with their review or shop.
- Compliance webhooks: `customers/data_request` / `customers/redact` — V1 holds no customer identifiers; requests are
  recorded and answered accordingly. `shop/redact` — all shop data and storage objects deleted, completion audited.
- Uninstall: storefront dark immediately; data kept only until `shop/redact`.
- Retention: import files deleted after the report window; rate-limit counters expire in minutes.

## 18. Theme extensions

Proofly theme extension (Theme App Extension; no theme code edits):

| Block | Target | Purpose |
|---|---|---|
| Proofly Reviews | `section` (product template) | Review block with summary, distribution, filters, sorting, cards, gallery, submission |
| Proofly Rating | `section` | Rating summary for product info areas |
| Proofly Card Ratings | app embed | Batched product-card ratings via a documented hook; themes with native rating support use Shopify's standard fields and need no JS |

No reliance on any particular theme, legacy review-app markup (e.g. `.shopify-product-reviews-badge`) or merchant-specific markup (a legacy-markup
compatibility mode may exist only as an explicit opt-in). Scoped CSS, theme fonts, configurable colours, strings in
`locales/`, no default branding, error-free in the theme editor, tested on Dawn and at least three popular OS 2.0
themes.

## 19. Performance requirements

| Metric | Budget |
|---|---|
| Card ratings (non-product pages) | ≤ 2 KB gzipped JS + CSS (reference build: 1.4 KB) |
| Product page review component | ≤ 10 KB gzipped JS + CSS (reference: ~6 KB) |
| Requests | One batched ratings request per page; review list fetched when the section nears the viewport |
| Images | Lazy-loaded WebP thumbnails (320 px), 1600 px on demand, CDN with immutable caching — never multi-MB originals |
| Rendering | Server-rendered summary, deferred scripts, nothing render-blocking, no layout shift |
| Storefront impact | Lighthouse performance drop ≤ 10 points on a reference theme |
| API | p95 ≤ 300 ms for ratings and review pages |
| Admin | Shopify embedded-app Web Vitals guidance |

## 20. App Store requirements

Latest App Bridge · embedded admin · GraphQL Admin API only · OAuth on install/reinstall, redirect to app UI ·
Shopify Billing with self-serve plan changes · Theme App Extensions with onboarding instructions · minimal scopes ·
compliance webhooks honoured · accurate data sync · functional, error-free UI · uninstall handling · honest reviews
(no fake or incentivised reviews, neutral language, no false verified badges) · no storefront app branding by
default · no ads in admin · data exportable · listing with privacy policy, support, screenshots, demo store.

## 21. V1.1

Requires Shopify protected customer data approval (Level 1 for orders; Level 2 only if email delivery needs customer
email), requested only when ready:

- Verified purchase (evidence-based only; never inferred; no manual “verified” without evidence + audit)
- Automated review-request emails (neutral wording, opt-out respected)
- Order-based review requests and review-request links (hashed, single-use, expiring tokens)
- Customer/order verification
- Adds `review_requests`, `reviews.verification_source`, `reviews.verified_at`, scope `read_orders`,
  webhook `orders/fulfilled`; verified-review % in analytics.

## 22. Future roadmap (not committed)

More provider adapters · review Q&A · multi-language widget content · Google Shopping / Merchant Center review
feeds · richer analytics · email-platform integrations · headless/Hydrogen · video reviews. AI-generated or
AI-written reviews will never be built; any other AI feature requires a separate policy and ethics review.

---

### Test data and acceptance

Every newly installed merchant starts with **zero** reviews, imported products/reviews, images, moderation records and
analytics history, in a tenant created from the shop identity Shopify provides at installation. Merchants import their
own data through the generic importer. Automated tests use the synthetic fixture (`scripts/fixtures/`), equivalent in
size and structure to a real recovery export, with 0 unexplained mismatches required. Real merchant datasets never
enter this repository, CI, seed data or shared hosting; they are used only in authorised local or development-store
testing from storage outside the repository. See [ARCHITECTURE.md §10](ARCHITECTURE.md) and
[BASELINE.md](BASELINE.md).
