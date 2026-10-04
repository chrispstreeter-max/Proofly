import { retryStaleProjections } from "./aggregates.server";
import { purgeRateLimits } from "./http.server";
import { recountStats } from "./entitlements.server";
import { STALE_MS } from "./import.server";
import { staleProjectionProducts } from "./projection.server";
import type { ShopApi } from "./review-store.server";
import { allShopIds, withTenant } from "./tenant.server";

/**
 * Scheduled maintenance (run by `npm run maintenance` from a scheduler, e.g. hourly). Retention, not plan limits:
 * nothing here ever touches a review or a reply. The only stored files are import CSVs (in the database).
 *  - rate-limit counters older than a day are deleted (they hold only hashed keys)
 *  - imports whose worker stopped (no heartbeat for 10 min) are marked failed so the merchant can resume them
 *  - an import's stored source CSV is deleted 30 days after the import finished — unless the import
 *    still has unresolved (unmatched / ambiguous, not skipped) products, whose rows exist only in that file
 *  - once a day per installed shop, review counts are recounted from the shop's Shopify store (repairs drift from
 *    edits made outside Proofly), and storefront projections whose write failed are republished — only when `shopApi`
 *    is given (the scheduled entry point passes Shopify access)
 */
export const IMPORT_FILE_RETENTION_DAYS = 30;

export async function runMaintenance(now = new Date(), shopApi?: (shopId: string) => Promise<ShopApi | null>) {
  const report = { rateLimitsPurged: Number(await purgeRateLimits()), importsMarkedResumable: 0, importFilesDeleted: 0, shops: 0, failedShops: 0, recounted: 0, projectionsRepublished: 0 };
  for (const shopId of await allShopIds()) {
    report.shops++;
    // One shop's failure (e.g. Shopify refusing a revoked token — found on a real store) never stops the others.
    try { await maintainShop(shopId, now, report, shopApi); } catch (e) {
      report.failedShops++;
      console.warn("maintenance: shop skipped", shopId, String(e instanceof Error ? e.message : e).slice(0, 200));
    }
  }
  return report;
}

async function maintainShop(shopId: string, now: Date, report: { importsMarkedResumable: number; importFilesDeleted: number; recounted: number; projectionsRepublished: number }, shopApi?: (shopId: string) => Promise<ShopApi | null>) {
  const r = await withTenant(shopId, async ({ db }) => {
    const stale = await db.importJob.updateMany({
      where: { shopId, status: "running", OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: new Date(+now - STALE_MS) } }] },
      data: { status: "failed", error: "The import stopped unexpectedly. Resume it to continue — nothing will be duplicated." },
    });
    const expired = await db.importJob.findMany({
      where: { shopId, status: { in: ["completed", "completed_with_warnings", "cancelled"] }, filesDeletedAt: null, finishedAt: { lt: new Date(+now - IMPORT_FILE_RETENTION_DAYS * 86_400_000) } },
      include: { matches: { where: { status: { in: ["unmatched", "ambiguous"] }, OR: [{ reason: null }, { reason: { not: "skipped_by_merchant" } }] }, select: { id: true } } },
    });
    const deletable = expired.filter((j) => j.matches.length === 0).map((j) => j.id);
    const files = await db.importFile.deleteMany({ where: { shopId, importJobId: { in: deletable } } });
    await db.importJob.updateMany({ where: { shopId, id: { in: deletable } }, data: { filesDeletedAt: now } });
    return { stale: stale.count, files: files.count };
  });
  report.importsMarkedResumable += r.stale;
  report.importFilesDeleted += r.files;
  if (shopApi) {
    const last = await withTenant(shopId, async ({ db }) => (await db.auditLog.findFirst({ where: { shopId, action: "reviews.recounted" }, orderBy: { createdAt: "desc" } }))?.createdAt);
    const recountDue = !last || +now - +last > 86_400_000;
    const staleProjections = (await staleProjectionProducts(shopId, now)).length > 0;
    const api = recountDue || staleProjections ? await shopApi(shopId) : null;
    if (api && staleProjections) report.projectionsRepublished += await retryStaleProjections(api, now);
    if (api && recountDue) {
      await recountStats(api);
      await withTenant(shopId, ({ db }) => db.auditLog.create({ data: { shopId, actor: "system", action: "reviews.recounted", entity: "reviews" } }));
      report.recounted++;
    }
  }
}
