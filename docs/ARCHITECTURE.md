# Proofly — Architecture

> **STATUS:** decision record (§1–§10) plus the implemented foundation (§11, checkpoints 1–4, local only).
> No production Shopify app, hosting or credentials exist. Where §1–§10 describe something not built yet, it says so;
> §11 is authoritative for what the code does today.
> **Commercial rules resolved 2026-10-03 (§9). Test-data policy: §10.**

> **Decision 2026-10-04 — no review photos.** Proofly has no photos anywhere: no storefront uploads, no photo import
> (ZIP or links), no photo display, no media storage allowance in plans. Every passage below that describes photos,
> media, storage-limited media or public media ids is superseded (removed in code; see ARCHITECTURE §11.16).

**Principle:** Shopify hosts and serves everything it is good at; Proofly stores and processes only what Shopify
cannot appropriately provide. The storefront must render ratings and reviews **without depending on a Proofly server
being reachable**; Proofly's backend handles writes, management, migration and image processing.

Related: [PRODUCT-SPEC-V1.md](PRODUCT-SPEC-V1.md) · [PUBLIC-APP-ROADMAP.md](PUBLIC-APP-ROADMAP.md) · [BRAND.md](BRAND.md)

---

## 1. Baseline origin

This architecture was decided after auditing a validated single-store prototype (kept as a private archive, not part
of this repository). What was carried forward, excluded and generalised is recorded in [BASELINE.md](BASELINE.md).
Findings from that audit that still shape this design: storefront card ratings and review lists depended on a backend
request; the card-rating integration relied on one legacy theme's markup; the storefront proxy path was hard-coded;
no billing, entitlement or tenant boundary existed yet.

---

## 2. Data placement — decision table

Questions applied to every data type: native Shopify storage possible? appropriate? query capability sufficient?
cross-product queries? moderation/history/audit? private? files? analytics? API/rate-limit/performance cost?

| Data | Shopify-native option | Decision | Reasoning |
|---|---|---|---|
| Product catalogue (id, handle, title, status) | Shopify products (source of truth) | **Shopify canonical**; Proofly keeps a **synced lookup copy** | Matching, filtering and analytics need joins in Proofly; kept fresh via paginated catalogue sync + `products/*` webhooks (§11.4) |
| Review records (all statuses) | Metaobjects (1M entries/definition, 40 fields) | **Proofly Postgres (canonical)** | Needs cross-product filtering/sorting/search, pending/rejected states that must never be storefront-visible, moderation history, idempotent import keys, 100k-review plans; metaobject writes are rate-limited GraphQL mutations; merchant-editable Shopify content would undermine audit integrity; uninstall/redaction behaviour of app-owned entries is unproven |
| Product rating + count | Standard metafields `reviews.rating`, `reviews.rating_count` | **Shopify (derived cache)** | Written only from Postgres, and only for products whose rating Proofly owns (§11.2); used by Proofly's blocks for server-rendered stars/JSON-LD; themes may also read them, but Proofly does not depend on that (§11.8) |
| Published-review first page per product | App-owned JSON product metafield (≤ 128 KB for new apps) | **Shopify (derived snapshot) — planned, not built yet** | Would let the block render the first ~10 reviews in Liquid with zero Proofly calls. Today the list loads lazily from Postgres via the app proxy (§11.6) |
| Rating distribution + photo-review count | Inside the snapshot metafield | **Shopify (derived)** | Needed for first render only |
| Further pages, filters, sorting | Not feasible in Liquid (no ad-hoc querying) | **Proofly via app proxy** | Interactive and on demand; storefront degrades gracefully if unavailable |
| Review submissions (shopper writes) | No anonymous Shopify write path for app data | **Proofly via app proxy** | Validation, spam/rate limits, image processing, moderation |
| Review images: originals | Shopify Files (merchant-visible, merchant-deletable, no per-app quota) | **Proofly private object storage (R2)** | Must stay recoverable and private; quotas per plan; per-shop isolation; deletion control |
| Review images: storefront copies | Shopify Files CDN | **Proofly storage (WebP), served by the `/media` resolver behind a CDN, opaque asset ids only** (§11.7) | Plan storage quotas, guaranteed deletion on `shop/redact`, takedown when a review is hidden, merchant cannot break reviews by cleaning their Files library |
| Merchant replies | Inside snapshot for displayed reviews | **Postgres canonical**, mirrored in snapshot | Editable, audited |
| Moderation actions / audit log | — | **Postgres** | Private history, never storefront-visible |
| Import jobs, files, matches, reports | — | **Postgres + private storage** | Large files, background processing, private |
| Analytics | — | **Postgres** (aggregation queries) | Cross-product, time-series |
| Storefront appearance (colours, layout, toggles) | Theme editor block settings | **Shopify** | Native per theme; no backend needed |
| Shop operational settings (moderation mode, submission on/off, photos on/off) | App-data metafields (`app.metafields` in theme extensions) | **Postgres canonical**, mirrored to app-data metafields | Backend enforces; Liquid reads the mirror to show/hide UI |
| Plan entitlements needed by the storefront (e.g. photo uploads allowed) | App-data metafields + block `available_if` | **Derived mirror** of the entitlement service | Storefront gating without a server call; backend still enforces |
| Subscription / plan state | Shopify App Pricing (Admin API `currentAppInstallation`; Partner API optional) | **Shopify canonical**, cached in Postgres (`billing_state`, `subscriptions`) | Shopify bills; Proofly caches for entitlements |
| Shopify access tokens / sessions | — | **Postgres, encrypted** | Secrets never belong in Shopify-readable storage |
| Storefront assets (JS/CSS/Liquid) | Theme app extension assets (Shopify CDN) | **Shopify** | Already the case |

**Reconciliation:** Postgres always wins, for Proofly-owned ratings only. After every change the affected values are
synced; reconciliation reads Shopify's values back for Proofly-managed products and rewrites any drift (e.g. Shopify
67 / 4.39 vs Proofly 68 / 4.41 → 68 / 4.41). Shopify values are never written back into Postgres, and products whose
rating Proofly does not own are never touched (§11.2–11.3). Today reconciliation runs on demand (merchant action); a
scheduled run arrives with the job runner.

---

## 3. What can live entirely on Shopify / what cannot

**Entirely on Shopify (no Proofly server at request time):**
product catalogue · star rating + count on product pages and native-theme product cards · review summary,
distribution and the first page of published reviews (+ replies, thumbnails) · structured data · storefront
appearance settings · storefront feature flags (mirror) · extension assets · plan selection and billing.

**Cannot live on Shopify:**
canonical review database (all statuses) · moderation and audit history · imports (files, analysis, matching, reports)
· original images and optimised copies with quotas · analytics · shopper submissions · secrets and sessions ·
billing-state verification (server-side Admin API read) · GDPR processing.

**PostgreSQL stays** as the canonical store. **A backend is genuinely required** — but only for admin, writes,
migration, images, sync and compliance. Storefront display never waits on it.

---

## 4. Revised architecture

```
                         ┌───────────────────────────── SHOPIFY ─────────────────────────────────┐
 Shopper ───────────────►│ Theme (any OS 2.0) + Proofly theme app extension (assets on Shopify CDN)│
                         │  • Proofly Reviews block ── Liquid renders from product metafields:     │
                         │      reviews.rating / reviews.rating_count (standard, cache)            │
                         │      $app proofly.snapshot  (summary, distribution, first ~10 reviews)  │
                         │  • Proofly Rating block ─── Liquid from reviews.* metafields            │
                         │  • Native theme card ratings ◄─ reviews.* metafields (zero JS)          │
                         │  • Proofly Card Ratings embed (extension; 1 batched request when needed)│
                         │  • app-data metafields (submission/photos flags, entitlement mirror)    │
                         │                                                                         │
                         │ App proxy /apps/<path>/* (HMAC) — ONLY for: more pages, filter, sort,   │
                         │   submit, fallback card ratings                                         │
 Merchant ──────────────►│ Shopify Admin ─ embedded Proofly (App Bridge, session tokens)           │
                         │ Shopify App Pricing (hosted plan page, billing) · Webhooks · Admin API  │
                         └──────────────┬──────────────────────────────┬──────────────────────────┘
                                        │ HMAC proxy / session tokens  │ webhooks, GraphQL Admin API
                                        ▼                              ▼
                         ┌───────────────────────── PROOFLY ───────────────────────────────────────┐
                         │ Node service (React Router, Shopify app library) — stateless             │
                         │   tenant resolution → repository (shop_id everywhere) → Postgres + RLS   │
                         │ Background jobs (Postgres-backed queue, same codebase):                  │
                         │   product sync · import/analysis · image processing (sharp) ·            │
                         │   metafield/snapshot sync + reconciliation · plan sync (Admin API) ·     │
                         │   GDPR deletion · usage metering (reviews, storage)                      │
                         │ Managed PostgreSQL (canonical) · Cloudflare R2: private originals,       │
                         │   WebP copies served by /media/<opaque-id> (internal keys s/<shop>/…)    │
                         └─────────────────────────────────────────────────────────────────────────┘
```

Request paths:

| Storefront action | Path | Proofly server involved? |
|---|---|---|
| Product page stars, count, summary | Liquid ← Shopify metafields | **No** |
| Review list (first page included, today), photos | App proxy, lazily; photos via `/media` (CDN-cacheable) | Yes (the first-page snapshot is planned, see §2) |
| Product cards | Rating summary block placed by the merchant (Liquid), or the card embed: inline Liquid data + ≤1 batched request (§11.8) | Only for cards Liquid can't see |
| Load more / filter / sort | App proxy | Yes, on interaction |
| Write a review | App proxy | Yes (write) |

If the Proofly backend is unavailable, product pages still show ratings and the first page of reviews; interactive
controls show a quiet “temporarily unavailable” state.

**Infrastructure actually required (V1):** one managed Node service (min 1 instance; stateless, horizontally
scalable), the same codebase running job workers, managed PostgreSQL (backups, at-rest encryption), Cloudflare R2
(two buckets per environment) + Cloudflare CDN, secrets manager, error monitoring. **Not required:** Redis, a separate
queue service, multi-region, a separate frontend host, serverless edge functions.

---

## 5. Database model (multi-tenant)

Tables: `shops`, `shop_settings`, `subscriptions` (cache of Shopify App Pricing state), `products`, `reviews`,
`review_images`, `review_replies`, `moderation_actions`, `import_jobs`, `import_product_matches`, `audit_log`,
`usage_counters`, `rate_limits`, `sessions` (encrypted). Every merchant-owned table carries `shop_id`; composite
uniques `(shop_id, shopify_product_id)` and `(shop_id, source, source_review_id)`; Postgres row-level security keyed on
a per-transaction `app.shop_id`; repository layer requires `shopId`; merge-blocking isolation tests.

Scale: indexes lead with `shop_id`; review listing uses `(shop_id, product_id, status, review_date desc)`. Merchants with
1,000 / 20,000 / 100,000 reviews share the same schema; no per-merchant tables. Partitioning by `shop_id` hash is a
later option, not needed for V1.

`reviews.status` = `pending | published | rejected | hidden`, plus `hold_reason` = `moderation | plan_limit | null`
so plan-limit holds are distinguishable from moderation (§6.3). Image rows keep review id, product id, image id,
original filename, original MIME type, original SHA-256, private original key and optimised asset keys.

---

## 6. Pricing implementation plan

### 6.1 Launch plans (Shopify App Pricing, five public plans, monthly with yearly option)

| Handle | Monthly | Yearly | Published-review limit | Storage | Notes |
|---|---|---|---|---|---|
| `free` | $0 | $0 | 100 | 500 MB | Review import (100 publishable), CSV export, photos, moderation, basic customisation |
| `starter` | $9 | $90 | 1,000 | 2 GB | + Replies, advanced widget customisation, migration within plan allowance |
| `growth` | $19 | $190 | 5,000 | 10 GB | “Most popular” (Proofly UI/listing copy, see §7) · + unlimited migration, advanced analytics (§6.6), priority support |
| `pro` | $39 | $390 | 25,000 | 50 GB | + advanced customisation; API access* (reserved) |
| `scale` | $79 | $790 | 100,000 | 250 GB | Review requests 25,000/month* |

\* Reserved entitlements — not listed, not enabled and not claimed anywhere until the functionality exists (API: unscheduled;
review requests / verified purchase: V1.1). Products are unlimited on every plan. Storage = public/optimised media
only. Yearly ≈ 2 months free (17% saving: $90 vs $108).

### 6.2 Entitlement service

**Implemented in checkpoint 5 — see [BILLING.md](BILLING.md).** One config file `app/lib/plans.ts` keyed by stable
plan id (`FREE`…`SCALE`, mapped to Shopify plan handles) with prices, allowances and features. All code goes through
`app/lib/entitlements.server.ts` (`can`, `getPlanStatus`, `getUsage`, admission). Features not
yet built resolve to `false` regardless of plan (a `released` flag per feature), so nothing unbuilt is ever exposed. `apiAccess` exists in the config for Pro/Scale but stays `released: false` until an API
ships. `storageBytes` is the public-media allowance (500 MB / 2 / 10 / 50 / 250 GB).
Not built: a storefront mirror of entitlements. The storefront needs none in V1 (billing never reaches the storefront); the backend enforces everything.

### 6.3 Limit behaviour — data retention rule (owner rule, 2026-10-03)

> Plan limits apply to **published/displayed review capacity, not ownership of imported data.** If a merchant imports
> more reviews than their plan permits: never delete the excess reviews; never discard imported data; preserve the
> complete imported dataset; mark reviews exceeding the publication allowance as unpublished/plan-limited; clearly
> show the merchant how many reviews are currently publishable; provide an upgrade path; on upgrade, eligible reviews
> can become publishable immediately; on downgrade, never delete reviews and reduce the published allowance according
> to the plan.

Implementation (resolved):

- **Status model:** `status = pending` + `hold_reason = plan_limit` marks plan-limited reviews; `hold_reason =
  moderation` marks reviews awaiting moderation. Plan-limited reviews are stored indefinitely, never storefront-visible,
  never deleted.
- **Imports:** never refused or truncated because of the plan. The complete dataset (text, metadata, original images in
  private storage) is preserved; reviews beyond the publication allowance import as plan-limited.
- **Merchant visibility (required UI):** Dashboard, Reviews and Plan show *published / allowance*, *plan-limited*,
  *awaiting moderation*, *public media used / allowance* and *storage-limited media*; the import summary shows the
  published / plan-limited / storage-limited split.
- **Upgrade (P8b):** nothing is published automatically. After an upgrade Proofly shows “You have N eligible reviews
  ready to publish.” with an explicit **Publish eligible reviews** action, which also processes and publishes eligible
  storage-limited media. Eligibility = within the new allowance, oldest review date first. An automatic-publication
  setting is out of scope for V1.
- **Downgrade (P8a — grandfather):** reviews and media already published stay published and visible. The lower
  allowance applies only to future publishing and import eligibility. While above the allowance: new and imported
  reviews become plan-limited (stored, never deleted), an over-limit warning is shown, and upgrading restores capacity.
- **Selection rule:** whenever a limit decides which reviews or media are affected, the only criterion is
  chronological order — never rating, sentiment or any other quality signal.

### 6.3a Media storage (P9 / P1)

- Plan storage limits apply to **public/optimised review media** (the WebP copies served on the storefront):
  Free 500 MB · Starter 2 GB · Growth 10 GB · Pro 50 GB · Scale 250 GB.
- Private original images are retained as migration data and do not count toward the public allowance; they are
  never deleted because of a plan storage limit (deleted only with their review, at `shop/redact`, or at the
  merchant's request).
- Import over the public allowance: review records are imported, originals preserved, media that cannot currently be
  served is marked **storage-limited** (`review_images.media_status = storage_limited`), never silently discarded, and
  the merchant sees why and how to upgrade. Storefront copies are generated when media becomes eligible.
- Downgrade: already-served media stays served (grandfather); new media beyond the allowance is storage-limited.
- `review_images.media_status` = `published | storage_limited | processing | failed`.
- **Abuse limits (proposed defaults, configurable):** ≤ 20 MB per image, ≤ 5 images per review, CSV ≤ 50 MB,
  images archive ≤ 2 GB per import, one running import per shop, image types JPEG/PNG/WebP only (re-encoded).
  These bound a single import; they never delete data already imported.

### 6.4 Plan state

Merchant selects on Shopify's hosted page (`admin.shopify.com/store/<handle>/charges/<app_handle>/pricing_plans`) →
Shopify redirects back with `plan_handle` (a hint, never trusted) → Proofly reads the shop's subscription from the
Admin API (`currentAppInstallation.activeSubscriptions`, `planHandle`) → caches in `billing_state` / `subscriptions` →
entitlements update → the merchant is shown “You have N eligible reviews ready to publish.” (no automatic
publication, §6.3). Re-checks run on token exchange, on return, when the admin finds the cache older than 10 minutes,
and on demand. A scheduled job arrives with the job runner, and the Partner API `activeSubscription` is an optional
second source for scheduled changes. Free plan = no subscription required. Details: [BILLING.md](BILLING.md).

### 6.5 Example under launch pricing

A merchant importing ~1,150 reviews needs Growth (5,000) to publish all of them; on Starter (1,000) the remainder is
stored as plan-limited and becomes publishable after an upgrade.

### 6.6 Analytics tiers (P4)

- **All plans (basic):** Dashboard metrics — total, published, pending, plan-limited, average rating, products with
  reviews, recent activity, plan usage.
- **Growth and above (advanced analytics, V1):** reviews over time · rating distribution · reviews by product ·
  average rating by product · photo-review percentage · published vs pending vs plan-limited · import history ·
  review growth · top-reviewed products. Aggregations over Postgres; no AI analytics in V1.

---

## 7. Shopify App Store / platform constraints discovered

| Constraint | Impact |
|---|---|
| Theme app extensions required; no theme code edits | Already the plan |
| Shopify App Pricing: up to **8 public plans**; free, monthly, yearly or monthly-with-yearly-discount | Five plans fit; annual via yearly option |
| **No subscription webhooks since 28 April 2026**; state via `plan_handle` redirect + subscription reads | Implemented with the shop's own Admin API (`currentAppInstallation`); Partner API optional (needs an org credential); pull-based reconciliation ([BILLING.md](BILLING.md)) |
| No documented way to badge a plan “Most popular” on Shopify's hosted pricing page | Show “Most popular” in Proofly's own Plan page/listing copy; hosted page shows Shopify's standard layout |
| Listing must describe only real functionality | API access, review requests and verified purchase are not advertised until shipped; advanced analytics advertised only once the §6.6 set is built |
| JSON metafield writes ≤ **128 KB** for new apps (API 2026-04+) | Snapshot sized to fit (≈10 reviews + summary, text truncated if needed with full text loaded via proxy) |
| Metaobjects: 1M entries/definition, 40 fields, 128 app definitions | Possible but unsuitable as canonical store (§2) |
| Storefront API tokenless access cannot read metafields | Card ratings come from the Proofly theme app extension (one batched app-proxy request) where the theme does not render Shopify's standard rating fields itself |
| App proxy path customisable per store | Path passed from Liquid to JS |
| GraphQL Admin API only; minimal scopes | V1 scopes: `read_products`, `write_products` |
| Honest reviews; no incentives; no fake verified badges | Already the plan |
| Storefront app branding restricted | White-label by default |

---

## 8. Final Proofly architecture (summary)

- **Shopify:** catalogue, rating/count cache, per-product published snapshot, storefront rendering (theme app
  extension on Shopify CDN), storefront settings, feature-flag mirror, billing and plan selection, webhooks.
- **Proofly:** canonical multi-tenant Postgres, moderation, imports, images (R2 + Cloudflare CDN), analytics,
  submissions, sync/reconciliation and plan-verification jobs, GDPR, audit — one stateless Node service plus job
  workers from the same codebase.
- **Storefront independence:** display never waits on Proofly; only interaction and writes do.

## 9. Resolved commercial decisions (2026-10-03)

| # | Decision |
|---|---|
| P1 | Free plan public-media storage: **500 MB** |
| P2 | Free imports store the complete dataset; excess is plan-limited (data retention rule) |
| P3 | **Products unlimited on all plans**; no product-count limits unless later analysis proves a genuine need. “Unlimited products” is not presented as a Starter differentiator |
| P4 | Growth+ advanced analytics = the §6.6 list; no AI analytics in V1 |
| P5 | API access reserved in the entitlement config for Pro/Scale; **never advertised or claimed until the API exists** |
| P6 | Product-card ratings delivered through the **Proofly theme app extension** as the primary integration, using Shopify-native rating data (`reviews.rating` / `reviews.rating_count`) where the theme renders it; no a legacy theme or merchant-specific markup; no theme code edits |
| P7 | Snapshot = **10 most recent published reviews** per product |
| P8a | Downgrade = **grandfather**: published reviews stay visible; lower allowance applies to future publishing/import; over-limit warning; upgrade restores capacity |
| P8b | Upgrade = **explicit** “Publish eligible reviews” action after “You have N eligible reviews ready to publish.”; no automatic publication in V1 |
| P9 | Storage limits apply to public/optimised media only; originals retained as migration data; over-allowance media marked storage-limited, never discarded; per-file and per-import abuse limits (§6.3a) |

All limit-driven selection is chronological only — never by rating, sentiment or quality.

---

## 10. Test data policy and commercial acceptance

Real merchant review datasets — including the private dataset used to validate the prototype — are **never** part of
Proofly: never bundled into the application or theme extension, included in seed data or migrations, included in the App
Store build, shown in a new merchant's account, used as a default dataset, referenced by production code (no real counts,
product IDs, handles, domains, branding or review content as assumptions), uploaded to Proofly hosting as shared/global
data, exposed to another merchant or uploaded to third-party CI.

**Allowed uses of a private dataset:** local development, local automated runs, migration/import testing and
development-store QA where explicitly authorised — always from storage outside this repository.

**Fixtures:** CI uses the synthetic fixture generator (`scripts/fixtures/generate.ts` + `check.ts`): ~1,150 reviews,
~90 products, ~160 images, multi-image reviews, duplicate and cross-product repeated text, missing titles, reply-like
records, unmatched and ambiguous products, multiple states, invalid records, plan-limited and storage-limited cases —
all obviously fictional. The local development database may hold a private dataset inside a development tenant; it is
never copied to staging or production.

**Scan:** `scripts/scan-merchant-data.ts` checks every committable file and the production build (§ BASELINE.md 5).

**Commercial acceptance criteria:**
1. A newly installed merchant starts with **0 reviews, 0 imported products/reviews, 0 images, 0 moderation records,
   0 analytics history**, and a tenant created from the shop identity Shopify provides at installation.
2. A merchant can independently import **their own** review dataset through the generic importer.
3. The importer handles a dataset equivalent in size and structure to a real recovery export (the synthetic fixture in
   CI) with 0 unexplained mismatches.
4. No tenant can see another tenant's data (isolation suite).
5. The merchant-data scan passes on every commit and production build.

---

## 11. Implemented foundation (checkpoints 1–4)

### 11.1 Review truth
PostgreSQL is canonical for every review, in every state. Shopify holds only derived data. Tenant isolation:
[TENANCY.md](TENANCY.md). Storefront: [STOREFRONT.md](STOREFRONT.md).

### 11.2 Shopify rating data — derived cache with explicit ownership
- Verified definitions (shopify.dev standard definitions + Admin API 2026-10 schema): `reviews.rating`, type `rating`,
  value `{"value":"4.41","scale_min":"1.0","scale_max":"5.0"}` (strings); `reviews.rating_count`, type
  `number_integer`. Owner: product.
- `products.rating_ownership` = `unmanaged` | `proofly_managed`. **Transition:** a product becomes `proofly_managed`
  when it first has a public Proofly review (published, not held), set by `recomputeProduct`. Merely existing in the
  catalogue never does it. V1 has no transition back.
- **Unmanaged:** Proofly never reads, writes, deletes or reconciles that product's rating metafields; an existing
  third-party rating is left exactly as it is.
- **Proofly-managed:** Proofly writes its aggregate (rating + count). If the product later has no public Proofly
  reviews, Proofly writes count 0 and removes its own `reviews.rating`.
- All writes live in `app/lib/rating-cache.server.ts`: idempotent (`metafieldsSet`), batched (≤25 metafields per
  call), retried for throttling and transient errors. A failed write leaves canonical data untouched; the product
  stays "dirty" (`synced_*` ≠ aggregate, `rating_sync_error` set) until a later sync or reconciliation succeeds.

### 11.3 Reconciliation
`reconcileRatingCache` reads Shopify's actual values for this shop's Proofly-managed, live products only (`nodes(ids:)`,
50 per call). It classifies each as ok, missing, incorrect (including stale), or not in Shopify, and rewrites those
that differ. It never changes reviews or aggregates.
- Proofly 68 / 4.41 vs Shopify 67 / 4.39 → repaired.
- Proofly has no reviews for the product (unmanaged) vs Shopify 68 / 4.41 → nothing (it may belong to another provider).

### 11.4 Aggregate
`computeAggregate` (`app/lib/aggregates.server.ts`) is the only rating calculation: review count, average (2 decimals),
1★–5★ counts and photo-review count.
- Eligible reviews: published AND not hidden AND not rejected AND not plan-limited.
- Photos count only when published and not storage-limited.
- Every eligible review counts; nothing is selected by rating or content.

`recomputeProduct` runs after every eligibility change (moderation approve/reject/hide/restore, plan-limit hold and
release, media status) and the cache sync follows.

### 11.5 Storage limits apply to photos, never reviews
There is no storage-limited review state.
- A published review counts toward count, average and distribution whatever its photos' state.
- It is a photo review only if at least one photo is public.
- Storage-limited photos are never served, never listed and never counted.
- A review is never deleted because of storage limits.

### 11.6 Product identity and sync
- **Identity:** the Shopify product ID is authoritative: `(shop_id, shopify_product_id)`. Handle, title and SKU are
  never used to attach reviews. They are migration-matching hints only.
- **Catalogue sync** (`syncCatalog`, `read_products` only):
  - Paginated `products` query (100 per page) through the shop's own Admin API client.
  - Waits when Shopify's cost budget is low, and retries THROTTLED and transient errors.
  - Saves its cursor after every page, so a failed run resumes where it stopped. Only one run per shop at a time.
  - Stores id, handle, title, status (`active | draft | archived | unlisted`) and `updatedAt`.
  - After a complete run, products Shopify no longer returns are marked deleted.
- **Webhooks** (`products/create|update|delete`, `include_fields` = id, handle, title, status, updated_at):
  - The tenant is the HMAC-verified shop. Invalid HMAC → 401.
  - Unknown or uninstalled shops and unusable payloads are acknowledged and ignored.
  - Updates older than the stored `shopify_updated_at` are ignored. Duplicates are no-ops.
  - Nothing here calls Shopify or touches ratings.
- **Deletion:** `deleted_at` is set and all reviews are kept, so the merchant can still export them. Nothing is
  deleted in Shopify, including any rating metafields. A late update never resurrects the product. A re-created
  product (new id, possibly the same handle) is a new row with no reviews; the old history stays on the deleted row.

### 11.7 Public media — opaque asset ids
- Each photo has a random 128-bit `public_id`. Public URLs are `<MEDIA_PUBLIC_URL>/<public_id>-320.webp` and
  `-1600.webp`. No shop, review, product or Shopify ID appears in them.
- Storage stays namespaced per merchant internally (`s/<shop>/r/<review>/<public_id>-…`, originals under
  `s/<shop>/originals/…`).
- The `/media` route resolves an id through `proofly_public_media_key()`, a SECURITY DEFINER function and the only
  cross-tenant read. It returns a storage key only while the photo is public: published media, published un-held
  review, live product, installed shop. Every other case is the same 404.
- Hiding a review takes its photos down at the next cache expiry (1 h). Originals are never served.

### 11.8 Storefront: proxy configuration and product-card hierarchy
- **Proxy path:** each merchant's app proxy path is stored per shop (`shop_settings.proxy_path`, set explicitly at
  install to the app default `/apps/proofly`, editable in the admin). It is published to an app-data metafield
  (`proofly.proxy_path` on the AppInstallation) that the extension reads through Liquid's `app` object. Every storefront
  request must arrive signed with that shop's path, so another shop's path, or the default when a shop configured a
  different one, gets a 404. There is no global fallback. The only place that knows paths is
  `app/lib/proxy-path.server.ts`.
- **Product cards:**
  1. Shopify-native rating metafields, kept correct for Proofly-managed products.
  2. The Rating summary app block. The merchant places it in the Theme Editor in any section that offers app blocks;
     the product auto-fills. This is the preferred, deterministic placement.
  3. The Product card stars app embed: the fallback for automatic card stars. It skips cards already showing a rating
     and uses inline Liquid data plus at most one batched request.
  4. Never theme code: no `theme.liquid`, template, section or snippet is ever modified.
- **API version:** one constant (`app/shopify-api-version.ts`, 2026-10) is used by the Admin API client and codegen,
  and test-enforced equal to the webhook `api_version`. `npm run check:graphql` validates every Admin operation
  against Shopify's published schema.

### 11.9 Billing and entitlements (checkpoint 5)
- **Billing:** Shopify App Pricing is the billing authority. Proofly links to Shopify's hosted plan page and never
  creates charges.
- **Plan state:** read from the shop's own Admin API (`currentAppInstallation`, `planHandle`). An API failure or an
  unknown handle keeps the current plan (unverified); only a confirmed ACTIVE subscription with a known handle changes it.
- **Entitlements:** `app/lib/entitlements.server.ts`. Published-review and public-media allowances are applied at
  admission (oldest first, date order only). Downgrades are grandfathered, upgrades require "Publish eligible reviews",
  and storage limits affect photos only. Nothing is deleted because of a plan.
- Full detail and verified Shopify facts: [BILLING.md](BILLING.md).

### 11.10 Reply visibility (checkpoint 6 decision)
Imported replies are retained regardless of plan. Public reply visibility is feature-gated. Plans without Replies store imported replies privately and suppress them from storefront responses. Upgrading restores eligibility without requiring re-import.

- Free does not delete imported replies, and downgrading does not delete replies: they stay stored with their review.
- Replies become visible again as soon as the merchant's plan includes Replies (no re-import, no duplicate rows).
- Visibility is decided server-side from the shop's own entitlement (`can(t, "replies")`); no client-supplied plan,
  parameter or header can change it. Without the entitlement the storefront response is exactly as if the review had
  no reply (`reply: null`) — no placeholder, no hidden-reply metadata.
- Reviews keep their own rules: the reply entitlement never makes a held, hidden, rejected or pending review public.

### 11.11 Import engine (checkpoint 6)
Generic CSV import with validation and matching before any write, resumable batched writes (cursor committed with each
batch), deterministic identity and idempotent re-imports, one active import per shop, and per-shop private file
storage. Product matching is Shopify id → handle → SKU (exact title only as a suggestion). Admission (reviews and
photos) runs once per import by date order through `entitlements.server`; aggregates go through `recomputeProduct`
and the Shopify cache through `rating-cache.server`. Equal review dates are resolved by `(source, source_review_id)`,
so results never depend on row order. Details: [IMPORT.md](IMPORT.md).

### 11.15 Privacy, retention and export (checkpoint 9)
`shop/redact` deletes the shop's storage objects, sessions and `shops` row (cascading through every merchant table)
once the shop is still uninstalled, and appends a domain-hash-only record to `shop_deletions` (insert-only for the app
role). Customer compliance topics never store the customer id. Scheduled maintenance deletes import files 30 days after
an import finishes unless unresolved products remain, marks stalled imports resumable, sweeps unreferenced objects older
than 24 h and purges rate-limit counters. Review export is a formula-safe CSV in import-template columns. Details:
[PRIVACY.md](PRIVACY.md).

### 11.16 No review photos (product decision, 2026-10-04)
Removed: storefront photo uploads (the form has no file field; the submission route reads text fields only and refuses
requests over 64 KB), photo import (ZIP archives and `https` links — photo columns are ignored like any unknown
column; the ZIP reader and the SSRF-safe image fetcher are gone), photo display (list images, photo filter, lightbox),
the public media route and resolver, the public bucket, `sharp`, media allowances and storage-limited admission, the
"allow photos" setting, and the schema (`review_images`, `MediaStatus`, `products.photo_review_count`,
`shop_settings.photo_reviews_enabled`, `import_jobs.images_key`; migration `20261010090000_remove_review_photos`).
Proofly now stores only one kind of file: merchants' import CSVs, privately (`app/lib/storage.server.ts`). Prices and
review allowances are unchanged.

### 11.17 Reviews stored in Shopify (Phase 1, 2026-10-04)
Owner decision: reviews live in each merchant's own Shopify store as entries of the merchant-owned metaobject type
`proofly_review` ([SHOPIFY-DATA.md](SHOPIFY-DATA.md)).
- `app/lib/review-store.server.ts` is the only code that touches review data.
- Tenant isolation for reviews is Shopify-native: the shop's own Admin API client.
- An entry edited outside Proofly is never public until it is re-approved; Proofly signs the fields it owns.
- Proofly's database keeps only settings, products cache, billing, imports, audit and a review-count cache; review
  tables are dropped (migration `20261011090000_reviews_in_shopify`).
- Every passage in §1–§10 and §11.1–§11.16 that places reviews, replies or moderation history in Postgres is
  superseded by this section.

### 11.18 Storefront projection (Phase 2, 2026-10-04)
The Review widget renders from an app-owned product metafield (`$app:proofly.reviews`) that Proofly publishes on
every change to a product's public reviews: summary + newest public reviews, allow-listed fields only, replies only
when entitled ([SHOPIFY-DATA.md §8](SHOPIFY-DATA.md)). The first pages need no request to Proofly; the app proxy
serves the rest. `app/lib/projection.server.ts` is the only writer; failed writes are retried
(`products.projection_stale_since`).

### 11.12 Product matching for imports (locked, checkpoint 6)
**Title is never an automatic product-matching key.** The hierarchy is ID → handle → SKU → other exact identifiers →
merchant-confirmed manual match. Exact-title matches are suggestions only and require explicit merchant confirmation
(manual matching: checkpoint 8, implemented). Near, fuzzy or similar titles are never used — not even as suggestions.
When identity is uncertain, Proofly does not guess. Suggestions are always products of the importing shop only.

### 11.13 Merchant review management (checkpoint 7)
- **Admin pages:** Dashboard, Reviews (filters including held-by-plan and source; bulk approve / hide / reject /
  return to pending), Review detail, Products (catalogue, published vs stored reviews, rating ownership and sync state,
  deleted products), Import, Plan, Settings.
- **Bulk approval** goes through the plan allowance like single approval. What doesn't fit stays approved and held,
  and the merchant is told how many. Another shop's review ids are ignored by the tenant-scoped `moderate()`.
- **Settings** (`shop_settings`): accept new reviews, allow photos, approve before publishing. They are enforced by
  the storefront submission route on every request and mirrored to the app-data metafield `proofly.storefront` (JSON)
  only so the theme can hide the button or photo field. A missing mirror falls back to "on"; the server still refuses.
- **Rate limits** are shared through Postgres (`rate_limits`, one atomic upsert per request, SHA-256 keys containing
  the shop and an IP hash, purged after a day), so they hold across any number of app instances.

### 11.14 Guided import (checkpoint 8)
Upload analyses without writing. The merchant then resolves unmatched or ambiguous products by explicit confirmation:
the product must be a live product of the authenticated shop, and confirmations are stored per shop and source in
`product_match_confirmations` (RLS, composite FK) and reused only for references automatic matching can't resolve. The
merchant then starts the import and can later re-import newly matched rows (idempotent). The problem report is a CSV
with plain-English reasons and no review text. Photos can come from the ZIP or `https` links fetched SSRF-safely
(public-address check on every DNS answer, pinned connection, re-validated redirects, size and time limits). Details:
[IMPORT.md](IMPORT.md).

