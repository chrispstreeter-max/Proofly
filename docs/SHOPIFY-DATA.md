# Proofly — Reviews stored in Shopify (design, 2026-10-04)

**Status: Phase 0 verified; Phase 1 built (reviews live in Shopify; see §7).** Owner decisions on 2026-10-04:
- "Work solely on Shopify servers".
- Reviews are stored in Shopify, in a **merchant-owned** custom data type.
- A small Proofly server remains for the parts Shopify cannot do.

## 1. What the owner accepted

- **Merchant-owned review data.** Reviews survive uninstall and reinstall and stay in the store if Proofly is removed.
  - The merchant, or another app with metaobject access, can edit or delete reviews in Shopify admin.
  - So Proofly cannot guarantee moderation history or review integrity once data leaves its control.
  - The data uses one of the merchant's 128 custom data types.
- **A server still exists.** App Store apps cannot be extension-only (Shopify docs: extension-only apps are
  custom-distribution only). Proofly still needs a server for:
  - its admin pages, which are an iframe app home;
  - webhooks;
  - storefront submissions through the app proxy;
  - token storage.

## 2. Target architecture

| Concern | Today | Target |
|---|---|---|
| Review truth | Postgres `reviews` (RLS) | Shopify metaobject type `proofly_review` (merchant-owned) in each store |
| Replies | `review_replies` | Fields on the review entry |
| Moderation | `status`/`hold_reason` columns | Entry fields (`status`, `held`); history as a JSON field (best effort: merchant edits bypass it) |
| Storefront list | App proxy → Postgres | Public projection published by Proofly into an app-owned product JSON metafield (newest ≤ 300 public reviews within 120 KB, replies only if the plan allows); further pages through the proxy → Admin API |
| Ratings | Standard `reviews.rating` / `rating_count` metafields | Unchanged |
| Aggregates | Postgres columns | Computed from entries; stored in the product metafields |
| Plan usage (published reviews) | `COUNT` in Postgres | Counter in an app-data metafield, recomputed from entries on reconcile |
| Import | Postgres writes in batches | Same analysis; writes through Admin API (bulk mutation where Shopify supports it), resumable |
| Export | Postgres | Admin API pagination over entries |
| Tenant isolation | RLS + composite FKs | Each store holds only its own data (Shopify-native); the server authenticates every request as that store |
| Proofly server state | Everything | Sessions (encrypted tokens), rate limits, import job state, CSV during import, billing cache — kept small |
| File storage (S3/R2) | Import CSVs | None: the CSV lives in the server database only while the import runs |
| `shop/redact` | Deletes all Proofly rows and files | Deletes Proofly's server state; reviews in the store are the merchant's data and stay with the store |

**Privacy design.** The review type has **no storefront access**. Everything public goes through Proofly's projection,
because a type that is readable on the storefront exposes every field of every active entry through the Storefront API.
That would leak:
- moderation fields;
- source ids;
- replies a Free plan must hide.

No IP hash is stored on reviews; rate limiting stays server-side.

**New access scopes:** `read_metaobject_definitions`, `write_metaobject_definitions`, `read_metaobjects` and
`write_metaobjects`, on top of the products scopes. Existing installs must re-approve.

## 3. Verified platform facts (shopify.dev, 2026-10-04)

- 1,000,000 entries per metaobject definition, 40 fields, 128 definitions per app.
- Admin `metaobjects(query:)` filters by `fields.{key}:{value}`; it sorts only by `id`, `type`, `updated_at` or
  `display_name`.
- JSON metafields: 128 KB for apps from April 2026; other types 64 KB; metaobject reference lists up to 1,024 items.
- App-owned (`$app`) data becomes unreachable after uninstall (developer forum reports). This is why the owner chose
  merchant-owned data.

## 4. Unproven, so tested first (Phase 0, on the development store "Proofly Test")

1. Filtering entries by a `product_reference` field value through `metaobjects(query:)`.
2. Using `display_name` (a sortable "date | id" field) for newest-first paging.
3. Bulk-mutation support for `metaobjectUpsert` (100,000-review imports within rate limits).
4. A merchant-owned definition created by the app: what merchants can change in admin, and whether it survives an
   uninstall and reinstall.
5. A 128 KB product JSON metafield read by Liquid: render time, and how many reviews fit.

If any of these fails, this document is updated and the owner decides before Phase 1.

**Phase 0 results** (2026-10-04, Proofly Test, `scripts/spike-metaobjects.ts`, synthetic `spike-` entries):

| # | Result |
|---|---|
| 1 | **Pass.** `fields.product:` filters correctly with a GID or a numeric id, alone or combined with `fields.status:` (20/20, 15/15). **Requires** `capabilities.adminFilterable` on those field definitions. Enabling it on existing entries takes a short indexing delay. |
| 2 | **Pass.** `sortKey: display_name, reverse: true` returns newest first when the display-name field is a "ISO date \| id" sort key. |
| 3 | **Pass.** `bulkOperationRunMutation` with `metaobjectUpsert`: 200 entries in 17 s, 0 row errors (about 2–3 h per 100,000, Shopify-side, one bulk operation at a time per shop). |
| 4 | **Pass.** The definition created by the app without `$app` has `access.admin = PUBLIC_READ_WRITE` (the merchant and other apps can edit) and `storefront = NONE` (works). **It survives uninstall and reinstall:** after the owner uninstalled and reinstalled Proofly Dev, the reinstalled app saw the definition (filterable settings intact), all 230 entries, working filters and working edits. |
| — | **Caveat:** `metaobjectsCount` reported 35 while 230 entries existed (lagging or approximate). Plan usage must count entries itself, never use that field. |

**Verdict: the design holds.** Every behaviour it depends on works on a real store. Phase 1 may start, with these
design consequences:
- product and status fields are created admin-filterable;
- display name is the sort key;
- the storefront copy holds at most about 300 reviews per product;
- no reliance on `metaobjectsCount`.

The 230 spike entries were deleted afterwards (`--cleanup`). The `proofly_review` definition was left in place.
| 5 | **Pass.** 120 KB JSON metafield accepted; 130 KB rejected ("maximum size of 131072 bytes"), so about 340 reviews of typical length per product. |

## 5. Phases (each one commit, every check run, no deploy)

0. **Spike:** a test script against Proofly Test proves items 1–5. Needs the new scopes deployed to the dev app and
   re-approved on the store.
1. **Review store module:** CRUD on entries behind one interface (`reviews-store.server.ts`), plus aggregates and the
   projection publisher. Moderation, replies, entitlements and export move onto it.
2. **Storefront:** the widget renders from the projection metafield; proxy paging; submissions create entries.
3. **Import:** analysis unchanged; writes go to entries; resumable through job state in the server database.
4. **Server slimming:** drop the merchant-data tables and RLS from Postgres; keep sessions, rate limits, jobs and
   billing cache. Drop S3. Update compliance and retention.
5. **Tests and docs:** replace the RLS isolation suite with per-store authentication tests plus a fake Shopify
   metaobject store; then real-store validation.

## 6. Locked rules that change

- "Reinstall never destroys merchant data": now holds by design, because data stays in the store.
- "Merchants cannot fake verified / reviews": now **cannot be guaranteed**. A merchant can edit entries. Proofly
  detects edits it didn't make (an `updated_at` and checksum field) and marks them in admin, but cannot prevent them.
- "Plan limits never delete" and "upgrade never auto-publishes": unchanged, enforced by Proofly when it publishes the
  projection.


## 7. Phase 1 — built (2026-10-04)

- **Review store module.** `app/lib/review-store.server.ts` is the only code that reads or writes reviews.
  - Definition: merchant-owned, storefront access NONE, 20 fields (10 admin-filterable).
  - Handles are a hash of (source, source review id), so a review is never written twice.
  - Proofly signs the fields it owns: an entry edited outside Proofly is never public and is flagged in the admin
    until it is approved again.
- **Moving parts switched to the store:**
  - storefront list and submissions;
  - moderation and replies;
  - plan admission (oldest first by "date | handle");
  - aggregates;
  - export;
  - import writes (single upserts, batched existence checks by handle);
  - dashboard, reviews list and review detail.
- **Proofly's database** dropped `reviews`, `review_replies`, `review_requests` and `moderation_actions`.
  - Moderation history is the audit log.
  - Counts are a per-shop cache (`shop_settings.review_stats`), recounted daily by maintenance.
- **Feature changes:**
  - Admin search is by reviewer name (Shopify has no full-text search on custom data).
  - The products page no longer shows "stored reviews" per product.
  - Duplicate-text flags are computed within an import file.
  - Local dev preview routes were removed (use a development store).
- **Still open:**
  - ~~Phase 2: the storefront reads from a product JSON projection~~ — built, §8.
  - ~~Phase 3: bulk mutations for large imports~~ — built, §9.
  - Phase 4: remove the remaining server-side caches where possible.

## 8. Phase 2 — built (2026-10-04)

- **Projection.** `app/lib/projection.server.ts` is the only code that writes it: product metafield
  `$app:proofly.reviews` (type `json`, app-owned — only Proofly writes it; merchants can read it in admin, not edit it;
  definition created with storefront `PUBLIC_READ`). Content:
  `{ summary: {count, average, distribution}, complete, reviews: [newest first] }`.
  - Only public reviews (published, not held, not edited outside Proofly), only the proxy's allow-listed fields,
    replies only when the current plan includes Replies.
  - Capped at 300 reviews and 120,000 bytes (Shopify's limit is 131,072); `complete` says whether all of them fit.
  - Only products Proofly manages (they have had a public Proofly review) carry one; when the last review stops being
    public it is rewritten empty, never left behind.
- **When it is written.** Every aggregate recompute (moderation, admission, submissions, imports, dashboard sync) and
  every reply save, using the reviews just written so search lag can't leave it stale. A plan change that adds or
  removes Replies rebuilds every projection of the shop.
- **Failures.** A failed write never undoes the change. `products.projection_stale_since` stays set; the retry waits
  2 minutes (it rebuilds from search, which must have caught up) and runs from the plan change path and hourly
  maintenance.
- **Widget.** The Review widget block embeds the projection as an HTML-escaped attribute and renders the summary and
  first page at once, with no request. When `complete`, filters, sorts and every page run in the browser; otherwise
  newest-first pages it covers render locally and everything else goes through the app proxy, in the same order.
  Without a projection (not yet published) the widget works exactly as before, through the proxy.
- **Verified live (Proofly Test, deploy proofly-dev-4):** the definition is created app-owned (merchant read,
  storefront read); approving a review wrote the projection in ~2 s; the published Horizon theme's Review widget
  rendered the summary and review from it, and rating filters ran in the browser, with zero requests to Proofly.
- **Live finding — uninstall:** Shopify deletes the app's own data on uninstall (app-data metafields: proxy path and
  storefront switch; `$app` product metafields). Proofly kept believing them published, so after the Phase 0
  reinstall the storefront had no proxy path. Fixed: the uninstall webhook forgets what was published, the reinstall
  republishes the app-data metafields, and maintenance republishes every projection.

**Live finding after Phase 1** (2026-10-04, Proofly Test): Shopify's metaobject search is **eventually consistent**.
A review written or approved a moment ago is not yet returned by `metaobjects(query:)`; the listing found it after
about 5 seconds. Proofly therefore never relies on a search immediately after its own writes:
- aggregates overlay the reviews just written (`computeAggregate(api, product, known)`);
- plan admission takes the just-written reviews as explicit candidates, re-read by id under the lock;
- import finalisation combines what the run wrote with what search finds.

Reads by id are always current. Admin lists and the storefront may show a change a few seconds late, which is
acceptable. Regression tests simulate the lag (`FakeShopify.searchLag`). Re-verified live: Shopify's rating updates
right after approval.

## 9. Phase 3 — built (2026-10-04)

- **Bulk module.** `app/lib/bulk.server.ts`: staged JSONL upload → `bulkOperationRunMutation` → poll
  `bulkOperation(id)` with backoff → download the result file; results matched by `__lineNumber` (Shopify doesn't
  keep order).
- **Imports** of 250+ rows create entries in bulk chunks (≤ 5,000 rows, ≤ 90 MB estimated). `metaobjectCreate`, not
  upsert: an existing handle is TAKEN and left untouched, so search lag can never cause an overwrite. The operation id
  is stored on the job (`import_jobs.bulk_operation`) before waiting, so a crash is resumed from Shopify's result file;
  rejected rows stop the import before the cursor moves and are retried on resume. Counts are applied in one locked
  update per chunk (`bumpStatsMany`).
- **Plan releases** over 100 reviews: decided and reserved under the entitlement lock, written after it in one bulk
  operation that sets only `held`, `public` and the signature. A review that changed meanwhile fails its signature
  and stays private (shown as edited outside Proofly until re-approved). The Plan page runs such releases in the
  background.
- **Fix found while building:** a held review edited outside Proofly could be published by "Publish eligible reviews"
  (the one-by-one write re-signed the outside edit). Both paths now skip such reviews; only re-approval publishes them.
- **Aggregates** for more than 20 products are recomputed from one pass over the shop's public reviews.
- **Verified live (Proofly Test, 2026-10-04):** a 300-row fictional import through Proofly's code ran as one bulk
  operation (300 entries in 25 s on Shopify's side, 68 s end to end including admission and the projection). On Free
  with one review already public: 99 published (oldest first), 171 plan-limited, 30 pending; the product aggregate,
  the storefront projection (99 reviews, complete) and the cached counts all matched a full recount from Shopify.
  Large releases (> 100) in bulk are covered offline only so far.
