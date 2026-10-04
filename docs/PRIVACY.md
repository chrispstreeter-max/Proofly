# Proofly — Privacy, retention and data export (Checkpoint 9)

Proofly stores the minimum needed to show product reviews. V1 requests only `read_products,write_products`; it reads
no orders and no customers, and the storefront form asks for no email address.

## What Proofly stores

| Data | Where | Personal data? | Kept until |
|---|---|---|---|
| Shop identity, encrypted offline access token | `shops`, `Session` | No (merchant's store) | `shop/redact` |
| Products (id, handle, title, status) | `products` | No | `shop/redact` (deleted products: soft-deleted) |
| Reviews: rating, title, body, display name, date, status | `reviews` | Reviewer's chosen display name | Merchant deletes the review, or `shop/redact` |
| Hashed submitter IP (salted SHA-256, abuse control) | `reviews.submitter_ip_hash` | Pseudonymous | `customers/redact` for a linked customer, or `shop/redact` |
| Shopify customer id | `reviews.shopify_customer_id` | Yes — never set by V1; only legacy/V1.1 | `customers/redact` (unlinked) or `shop/redact` |
| Review photos: private original + two public WebP derivatives (EXIF removed) | object storage `s/<shop>/…` | Possibly (image content) | Review/photo deleted, or `shop/redact` |
| Replies | `review_replies` | No | Review deleted, or `shop/redact` |
| Import source files (CSV, images ZIP) | private storage `s/<shop>/imports/<job>/` | Whatever the merchant's export contains | **30 days after the import finishes**, unless products are still unresolved (see below) |
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
- **Orphaned objects** — anything under the shop's storage prefix that no photo or import row references, older than
  24 hours (e.g. left by a crash mid-batch) — are deleted.
- **Rate-limit counters** older than a day are deleted.

## Compliance webhooks

All three arrive at `/webhooks/compliance`, HMAC-verified by `authenticate.webhook`; the shop is the one Shopify signed
for, and nothing outside it is read or changed.

- `customers/data_request` — V1 stores no customer identity. The audit log records how many reviews are linked to that
  customer id (normally 0) — never the id itself. The merchant answers the request from that.
- `customers/redact` — reviews linked to the customer id are unlinked (`shopify_customer_id` and IP hash cleared). The
  review text and display name stay: they are the merchant's published content and carry no contact data.
- `shop/redact` (48 hours after uninstall) — if the shop is still uninstalled, **everything** is deleted: every stored
  object under its prefix (both buckets), its sessions, and the `shops` row, which cascades through every merchant
  table. A `shop_deletions` record keeps only a SHA-256 of the domain and row counts as proof of deletion; the app role
  can insert into it but not change or delete it. A reinstalled shop is not deleted; redelivery is a no-op.

## Export

Reviews → **Export CSV** (`/app/reviews/export`, all plans) downloads every review the shop owns — any status,
plan-limited or not, replies included whatever the plan — in import-template columns, with public photo URLs and the
number of storage-limited photos. Cells a spreadsheet would run as a formula are prefixed with an apostrophe. Each
export is audit-logged. Re-importing the file into the same store skips reviews that came from a CSV import; it is a
backup and portability file, not a sync.

Tests: `tests/privacy.test.ts`.
