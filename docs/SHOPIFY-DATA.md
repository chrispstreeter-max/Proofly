# Proofly — Reviews stored in Shopify (design, 2026-10-04)

**Status: design, approved direction, not built.** Owner decisions on 2026-10-04:
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
| Storefront list | App proxy → Postgres | Public projection published by Proofly into a product JSON metafield (newest ≤ ~100 public reviews, replies only if the plan allows); further pages through the proxy → Admin API |
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
