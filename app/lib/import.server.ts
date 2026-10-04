import { recomputeProduct } from "./aggregates.server";
import { admitReviews } from "./entitlements.server";
import type { Tenant } from "./tenant.server";

/**
 * Generic review import core (provider-neutral). CSV parsing, field mapping, product matching UI, images and the
 * import screens are checkpoint 8; whatever produces rows calls this.
 *
 * Plan rule: imports are NEVER truncated. Every valid row is stored. Rows that arrive published become public only
 * while the published-review allowance has room — oldest review date first (entitlements.server); the rest are stored
 * as plan-limited (held), never deleted, and become publishable after an upgrade via "Publish eligible reviews".
 * Idempotent: (source, sourceReviewId) already stored → counted as a duplicate, left unchanged.
 */
export interface ImportRow {
  sourceReviewId: string;
  shopifyProductId: bigint; // identity: matched to THIS shop's product by Shopify id only
  rating: number;
  title?: string;
  body: string;
  reviewerName: string;
  reviewDate: Date;
  status?: "published" | "pending" | "hidden" | "rejected";
}

export interface ImportReport {
  received: number;
  imported: number;
  published: number;
  planLimited: number;
  notPublished: number; // imported as pending / hidden / rejected by their source state
  duplicates: number;
  unmatchedProduct: number;
  invalid: number;
}

const valid = (r: ImportRow) =>
  typeof r.sourceReviewId === "string" && r.sourceReviewId.length > 0 && r.sourceReviewId.length <= 255 &&
  Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5 &&
  typeof r.body === "string" && r.body.trim().length > 0 && typeof r.reviewerName === "string" && r.reviewerName.trim().length > 0 &&
  r.reviewDate instanceof Date && !Number.isNaN(+r.reviewDate);

export async function importReviews(t: Tenant, input: { source: string; rows: ImportRow[]; actor: string }): Promise<ImportReport> {
  const { db, shopId } = t;
  const report: ImportReport = { received: input.rows.length, imported: 0, published: 0, planLimited: 0, notPublished: 0, duplicates: 0, unmatchedProduct: 0, invalid: 0 };
  const products = new Map(
    (await db.product.findMany({ where: { shopId, deletedAt: null, shopifyProductId: { in: [...new Set(input.rows.map((r) => r.shopifyProductId))] } }, select: { id: true, shopifyProductId: true } }))
      .map((p) => [p.shopifyProductId, p.id]),
  );
  const publishedIds: string[] = [];
  const touched = new Set<string>();
  for (const r of input.rows) {
    if (!valid(r)) { report.invalid++; continue; }
    const productId = products.get(r.shopifyProductId);
    if (!productId) { report.unmatchedProduct++; continue; }
    const status = r.status ?? "published";
    // Published rows go in HELD; admitReviews then releases them oldest-first within the allowance.
    const created = await db.review.createMany({
      data: [{ shopId, productId, source: input.source, sourceReviewId: r.sourceReviewId, rating: r.rating, title: (r.title ?? "").slice(0, 255), body: r.body, reviewerName: r.reviewerName.slice(0, 255), reviewDate: r.reviewDate, status, imported: true, holdReason: status === "published" ? "plan_limit" : null }],
      skipDuplicates: true,
    });
    if (!created.count) { report.duplicates++; continue; }
    report.imported++;
    touched.add(productId);
    if (status === "published") {
      const row = await db.review.findUniqueOrThrow({ where: { shopId_source_sourceReviewId: { shopId, source: input.source, sourceReviewId: r.sourceReviewId } }, select: { id: true } });
      publishedIds.push(row.id);
    } else report.notPublished++;
  }
  // ponytail: one transaction per call; the checkpoint 8 importer feeds this in batches for very large files.
  const admitted = await admitReviews(t, publishedIds, input.actor);
  report.published = admitted.released;
  report.planLimited = admitted.stillHeld;
  for (const pid of touched) await recomputeProduct(t, pid);
  await db.importJob.create({ data: { shopId, source: input.source, status: "finished", counts: { ...report }, finishedAt: new Date() } });
  await db.auditLog.create({ data: { shopId, actor: input.actor, action: "import.finished", entity: "import", details: { ...report } } });
  return report;
}
