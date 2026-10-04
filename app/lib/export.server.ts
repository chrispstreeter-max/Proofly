import type { Tenant } from "./tenant.server";

/**
 * Review export (all plans): every review the shop owns — any status, plan-limited or not, replies included regardless
 * of the plan (it is the merchant's data). Columns follow the import template: re-importing the file into the same
 * store skips the reviews that came from a CSV import (same source + review id); it is a backup/portability file, not a sync.
 * Cells that a spreadsheet would execute as a formula are prefixed with an apostrophe (CSV injection).
 */
export const EXPORT_COLUMNS = ["review_id", "product_id", "product_handle", "product_title", "rating", "title", "body", "reviewer_name", "review_date",
  "status", "plan_limited", "reply", "source", "imported", "verified_purchase"] as const;

const cell = (v: string) => {
  const safe = /^[=+@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export async function exportReviewsCsv({ db, shopId }: Tenant) {
  const lines = [EXPORT_COLUMNS.join(",")];
  let cursor: string | undefined;
  for (;;) {
    const page = await db.review.findMany({
      where: { shopId }, orderBy: { id: "asc" }, take: 1000, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { product: { select: { shopifyProductId: true, handle: true, title: true } }, reply: true },
    });
    for (const r of page) {
      lines.push([
        r.sourceReviewId, String(r.product.shopifyProductId), r.product.handle, r.product.title, String(r.rating), r.title, r.body, r.reviewerName,
        r.reviewDate.toISOString(), r.status, r.holdReason === "plan_limit" ? "yes" : "no", r.reply?.reply ?? "",
        r.source, r.imported ? "yes" : "no", r.verifiedPurchase ? "yes" : "no",
      ].map(cell).join(","));
    }
    if (page.length < 1000) break;
    cursor = page[page.length - 1].id;
  }
  return lines.join("\n") + "\n";
}
