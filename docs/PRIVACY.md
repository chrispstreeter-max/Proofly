# Proofly — Privacy, retention and data export (Checkpoint 9)

Proofly stores the minimum needed to show product reviews. It has no review photos (product decision, 2026-10-04): shoppers cannot upload them and imports ignore photo columns. V1 requests only product and custom-data (metaobject) scopes; it reads
no orders and no customers, and the storefront form asks for no email address.

## What Proofly stores

| Data | Where | Personal data? | Kept until |
|---|---|---|---|
| Shop identity, encrypted offline access token | `shops`, `Session` | No (merchant's store) | `shop/redact` |
| Products (id, handle, title, status) | `products` | No | `shop/redact` (deleted products: soft-deleted) |
| Reviews and replies: rating, title, body, display name, date, status, reply | **the merchant's own Shopify store** (metaobject type `proofly_review`, merchant-owned, no storefront access) | Reviewer's chosen display name | The merchant's data in their store: it stays when Proofly is uninstalled; the merchant can hide, reject or delete reviews |
| Review counts (cache) | `shop_settings.review_stats` | No | `shop/redact` |
| Import source files (CSV) | private storage `s/<shop>/imports/<job>/` | Whatever the merchant's export contains | **30 days after the import finishes**, unless products are still unresolved (see below) |
| Import analysis, match decisions, problem summaries | `import_jobs`, `import_product_matches`, `product_match_confirmations` | No review text | `shop/redact` |
| Audit log (moderation, settings, exports, compliance events) | `audit_log` | No (staff ids, counts; never a customer id) | `shop/redact` |
| Rate-limit counters | `rate_limits` | No (SHA-256 of shop + IP hash) | 1 day |
| Deletion record | `shop_deletions` | No (SHA-256 of the shop domain + row counts) | Permanent, append-only |

Plan limits never delete anything (ARCHITECTURE §6.3). Retention below is the only automatic deletion.

## Retention (scheduled maintenance)

`npm run maintenance` (`app/lib/maintenance.server.ts`, run hourly by the platform scheduler) does exactly this:

- **Import files** of a completed or cancelled import are deleted 30 days after it finished. If the import still has
  unmatched or ambiguous products the merchant has neither matched nor skipped, those rows exist only in that file, so
  the file is kept until the merchant resolves them (or the shop is redacted). The import page then says the file was
  deleted; imported reviews are unaffected, and re-uploading is safe (rows already imported are skipped).
- **Stalled imports** (no heartbeat for 10 minutes) are marked failed with a resume prompt — never restarted silently.
- **Orphaned files** — anything under the shop's storage prefix that no import references, older than 24 hours
  (e.g. an upload whose import was refused) — are deleted.
- **Rate-limit counters** older than a day are deleted.

## Compliance webhooks

All three arrive at `/webhooks/compliance`, HMAC-verified by `authenticate.webhook`; the shop is the one Shopify signed
for, and nothing outside it is read or changed.

- `customers/data_request` — Proofly stores no customer identity anywhere (reviews carry only the display name the
  reviewer typed: no customer id, email, order or IP). The request is recorded in the audit log without the id.
- `customers/redact` — nothing to unlink; recorded the same way. Review text and display name are the merchant's
  published content in their own store and carry no contact data.
- `shop/redact` (48 hours after uninstall) — if the shop is still uninstalled, **everything Proofly holds** is deleted:
  every stored file under its prefix, its sessions, and the `shops` row, which cascades through every Proofly table.
  The reviews themselves are the merchant's data in their own Shopify store and stay with the store. A `shop_deletions` record keeps only a SHA-256 of the domain and row counts as proof of deletion; the app role
  can insert into it but not change or delete it. A reinstalled shop is not deleted; redelivery is a no-op.

## Export

Reviews → **Export all reviews (CSV)** (`/app/reviews/export`, all plans) downloads every review the shop owns — any status,
plan-limited or not, replies included whatever the plan — in import-template columns. Cells a spreadsheet would run as a formula are prefixed with an apostrophe. Each
export is audit-logged. Re-importing the file into the same store skips reviews that came from a CSV import; it is a
backup and portability file, not a sync.

Tests: `tests/privacy.test.ts`.
