# Proofly — Review import (Checkpoints 6 and 8)

Implementation: `app/lib/import.server.ts` (engine; reviews are written into the shop's Shopify store through
`app/lib/review-store.server.ts`), `app/lib/csv.ts` (RFC 4180 parser), admin routes
`app.imports._index.tsx` (upload, column mapping, history), `app.imports.$id.tsx` (analysis, manual matching, start,
resume, cancel, re-import), `app.imports.$id_.report.tsx` (problem report CSV).

## 0. Guided flow (checkpoint 8)

1. **Upload** the CSV and choose "publish" or "hold for moderation". If the required columns
   aren't recognised, the merchant maps each field to a column and uploads again.
2. **Check file:** Proofly validates and matches every row and **writes nothing**. The import page shows counts,
   problems in plain English, and the products that need a decision.
3. **Resolve products** (optional):
   - **Confirm a match:** choose one of the store's live products, from the suggestions or a search of the shop's own
     catalogue. The choice is checked server-side to be a live product of the authenticated shop.
   - **Skip:** leaves the reviews out.
   - **Reuse:** confirmations are saved per shop and source and reused by later imports. They only fill gaps;
     automatic matches can't be overridden.
4. **Start import.** Unresolved rows are skipped and reported.
5. **Afterwards:** "Import newly matched rows" re-imports the stored file after later confirmations. Rows already
   imported are skipped, new ones are admitted by date order. "Download problem report" gives every unimported row with
   its reason (no review text).

## 1. Lifecycle

| Step | Function | Writes reviews? |
|---|---|---|
| Upload | `createImport(shopId, …)` | No |
| Run | `runImport(shopId, jobId)` | Yes, in batches |
| Finalize | inside `runImport` | Admission only |

- **Upload** checks the limits and stores the CSV privately (`s/<shop>/imports/<job>/…`, never
  served). It then parses, validates and matches every record and saves the analysis and per-product matches.
  Job → `queued`.
- **Run** claims the job (`running`) and writes the reviews into the shop's Shopify store, committing the job's cursor
  and counts after each chunk. Fewer than 250 rows: one entry at a time, 50 rows per chunk. 250 rows or more: Shopify
  bulk operations (`app/lib/bulk.server.ts`) of up to 5,000 rows (and well under Shopify's 100 MB input limit) each.
  - Bulk creation never overwrites: an entry whose handle already exists is reported "already imported" by Shopify
    and left untouched, even if search hadn't shown it yet.
  - The running bulk operation is recorded on the job before Proofly waits for it; a resumed import collects that
    operation's results instead of sending the chunk again.
  - Rows Shopify rejects stop the import before the cursor moves; resuming retries them (without duplicates).
  - While Shopify works, the job keeps its heartbeat; a cancel takes effect after the current chunk.
- **Finalize** admits the job's reviews (date order), recomputes aggregates, flags duplicates and records
  the outcome. Job → `completed` or `completed_with_warnings`.

Upload no longer starts the run: the merchant reviews the analysis and starts it (§0). Other states: `failed` (resumable: run again and it continues at the cursor) and `cancelled` (stops at the next batch;
rows already imported are kept, held, and adopted by a later re-import). There is no giant transaction. One active
import per shop (a queued job, or a running one with a heartbeat in the last 10 minutes) is enforced under a per-shop
advisory lock. The shop always comes from the authenticated session, never from the file or the request, and
uninstalled shops can't import.

## 2. CSV format (generic template; column names are case-insensitive)

| Field | Columns accepted | Required | Rules |
|---|---|---|---|
| Source review id | `review_id`, `source_review_id`, `id` | no | ≤ 255 chars. Missing → deterministic fallback id (§4) |
| Shopify product id | `product_id`, `shopify_product_id` | one product reference required | digits only |
| Product handle | `product_handle`, `handle` | ↑ | compared lower-case |
| Product SKU | `sku`, `product_sku`, `variant_sku` | ↑ | exact |
| Product title | `product_title` | no | **suggestions only** (§3) |
| Rating | `rating`, `stars`, `score` | yes | integer 1–5 (`4.0` accepted, `4.5` refused) |
| Review title | `title`, `review_title` | no | ≤ 255 |
| Review body | `body`, `review_body`, `content`, `review` | yes | ≤ 20,000 chars |
| Reviewer display name | `reviewer_name`, `author`, `name`, `reviewer` | no | missing → "Anonymous" (warning) |
| Review date | `review_date`, `date`, `created_at` | yes | ISO 8601 date or date-time, or `YYYY-MM-DD HH:MM[:SS]` (UTC unless an offset is given). Ambiguous formats like `03/04/2024` are refused, never guessed. Not in the future (+1 day), not before 1990 |
| Status | `status`, `state` | no | §5 |
| Reply | `reply`, `reply_content`, `merchant_reply`, `store_reply` | no | stored; public visibility feature-gated ([BILLING.md §10](BILLING.md)) |

- **Other columns are ignored and never stored.** This includes email, phone, customer, order and photo columns
  (Proofly has no review photos, product decision 2026-10-04). V1 stores no
  reviewer contact or customer/order identity.
- **Explicit mapping:** `options.mapping` may name the column for any field (provider presets only map columns).
- **Report contents:** problem rows (record number, code, warnings, source id) — never bodies, names,
  emails or file paths.

## 3. Product matching

Title is never an automatic product-matching key.

The automatic hierarchy is **Shopify product ID → handle → SKU → other exact identifiers → merchant-confirmed manual
match**:
- **SKU** is resolved through the shop's own Admin API (`productVariants(query: "sku:…")`, exact equality re-checked).
- **Other exact identifiers:** none is supported yet.
- **Manual match:** checkpoint 8.

Rules:
- **Several identifiers given:** they must agree. Disagreement, or one identifier matching several products (for
  example a SKU on two products), → **ambiguous**.
- **Product ID given but not live** (deleted, or not in this shop's catalogue) while handle or SKU points to a product
  → **ambiguous**. Identity is uncertain.
- **Nothing matches** → **unmatched**, with a reason.
- Locked rule, enforced by `tests/title-matching.test.ts` (turning on title matching fails 8 tests):
  exact-title matches are suggestions only and require explicit merchant confirmation.
- **Exact title** (trimmed, case-insensitive) on live products of **this shop** is offered only as `candidates` for
  the merchant. It never creates an association and never changes a match's status. No fuzzy or similar-title logic
  exists.
- **Matching is per shop:** RLS-scoped catalogue, own Admin API. Another shop's products can't be candidates.
- **Unmatched and ambiguous rows** are not written as reviews (a review needs a valid product). They're kept as part of
  the import result: the private source file, the job report rows and `import_product_matches` (reason + candidates),
  so checkpoint 8 can resolve and re-run them.

## 4. Identity and idempotency

- **Identity:** `(shop, source, source_review_id)` is unique: the review's entry handle in the shop's Shopify store is a
  hash of source + source review id, so the same review can never be written twice. Without a source id:
  `h_` + SHA-256 of [product reference, normalised reviewer, ISO date, normalised body].
- **Same id twice in one file:** identical records → imported once (`duplicate_source_row`); different content → none
  imported (`conflicting_duplicate_id`), so the result never depends on row order.
- **Re-importing the same file:** creates nothing and changes nothing. Existing reviews keep their dates, states,
  replies and moderation history, and use no extra allowance.
  - **One exception:** rows created by an import that never finished (failed or cancelled) are adopted by the new
    import, so they're admitted in date order with the rest.
- **Content duplicates** (same reviewer and text within the file): imported, flagged `possible_duplicate` (same
  product) or `cross_product_repeat`. Flags are admin information only, never used for publication.

## 5. Review states

| Source status | Proofly |
|---|---|
| published / approved / active / visible / public | published, then admission (§7). In "hold for moderation" mode: pending |
| pending / unpublished / awaiting / new / draft | pending |
| rejected / declined / spam | rejected |
| hidden / archived | hidden |
| (empty) | the merchant's choice for this import: publish (admission) or hold for moderation |
| anything else | **pending** + flag `unknown_source_status` (never public by accident) |

Imported reviews are always unverified.

## 6. Photos

Not supported. Photo columns (file names or links) are ignored like any other unknown column: nothing is downloaded,
stored or reported, and the review itself imports normally.

## 7. Plan limits (locked rules; implemented by `entitlements.server`)

- **Never truncated:** every valid review is stored. Published-intent reviews are admitted oldest first while the
  published-review allowance has room; the rest are plan-limited (held, never deleted). Selection is review date, then
  the review's stable handle (a hash of source + source review id); it never depends on rating, content or row order.
- **Grandfathering:** published reviews stay public after a downgrade, and imports then hold new reviews.
- **No automatic publication on upgrade:** the merchant uses "Publish eligible reviews".
- **Large releases:** more than 100 reviews are released in one Shopify bulk operation after the decision (taken
  under the shop's entitlement lock, which also reserves the room). The bulk write changes only the release fields,
  so a review that changed meanwhile can't become public. A review edited outside Proofly is never released; only
  re-approval publishes it.
- **Aggregates and rating cache:** aggregates are recomputed through `recomputeProduct`; the Shopify rating cache is
  synced through `rating-cache.server` (Proofly-managed products only). The importer never writes metafields or
  product data.

## 8. Limits (import safety, not retention)

CSV ≤ 50 MB, one active import per shop. Exceeding a limit refuses the upload or the item; it never deletes previously
imported data.

## 9. Merchant-visible outcome

`getImport` and `listImports` (RLS-scoped) report:
- **Rows:** totals, valid, invalid, duplicate source rows and conflicting ids.
- **Matching:** unmatched and ambiguous rows, plus per-product matches with candidates.
- **Reviews:** imported, already imported, adopted, published, plan-limited, awaiting moderation, hidden and rejected.
- **Replies:** imported, publicly visible, and suppressed by plan.
- **Other:** warnings, status and error.

The dashboard shows the latest import, and `/app/imports` shows history with resume and cancel.

## 10. Not yet built / not verifiable offline

- **Not built:** legacy-provider column presets (generic mapping instead; exact export formats aren't verified); a
  background job runner (runs happen in the request's server process and resume on demand; see checkpoint 10);
  retention deletion of import files (checkpoint 9).
- **Needs a development store:** the SKU lookup and catalogue behaviour against a real Shopify catalogue, and large
  uploads through Shopify's admin and proxy request limits.
