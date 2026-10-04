import { csvCell } from "./csv";
import { scanReviews, type ShopApi } from "./review-store.server";
import { withTenant } from "./tenant.server";

/**
 * Review export (all plans): every review the shop owns (read from its Shopify store) — any status, plan-limited or not, replies included regardless
 * of the plan (it is the merchant's data). Columns follow the import template: re-importing the file into the same
 * store skips the reviews that came from a CSV import (same source + review id); it is a backup/portability file, not a sync.
 * Cells that a spreadsheet would execute as a formula are prefixed with an apostrophe (csvCell, CSV injection).
 */
export const EXPORT_COLUMNS = ["review_id", "product_id", "product_handle", "product_title", "rating", "title", "body", "reviewer_name", "review_date",
  "status", "plan_limited", "reply", "source", "imported", "verified_purchase", "edited_outside_proofly"] as const;


export async function exportReviewsCsv(api: ShopApi) {
  const products = new Map((await withTenant(api.shopId, ({ db, shopId }) => db.product.findMany({ where: { shopId }, select: { shopifyProductId: true, handle: true, title: true } })))
    .map((p) => [String(p.shopifyProductId), p]));
  const lines = [EXPORT_COLUMNS.join(",")];
  for await (const r of scanReviews(api, {}, { oldestFirst: true })) {
    const p = products.get(String(r.productId));
    lines.push([
      r.sourceReviewId, String(r.productId), p?.handle ?? "", p?.title ?? "", String(r.rating), r.title, r.body, r.reviewerName,
      r.reviewDate.toISOString(), r.status, r.held ? "yes" : "no", r.reply ?? "", r.source, r.imported ? "yes" : "no", r.verified ? "yes" : "no",
      r.editedOutside ? "yes" : "no",
    ].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
