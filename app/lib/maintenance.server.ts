import { purgeRateLimits } from "./http.server";
import { recountStats } from "./entitlements.server";
import { STALE_MS } from "./import.server";
import type { ShopApi } from "./review-store.server";
import { deleteObjects, listObjects, shopPrefix } from "./storage.server";
import { allShopIds, withTenant } from "./tenant.server";

/**
 * Scheduled maintenance (run by `npm run maintenance` from a scheduler, e.g. hourly). Retention, not plan limits:
 * nothing here ever touches a review or a reply. The only stored files are import CSVs.
 *  - rate-limit counters older than a day are deleted (they hold only hashed keys)
 *  - imports whose worker stopped (no heartbeat for 10 min) are marked failed so the merchant can resume them
 *  - an import's stored source CSV is deleted 30 days after the import finished — unless the import
 *    still has unresolved (unmatched / ambiguous, not skipped) products, whose rows exist only in that file
 *  - stored files no import references (e.g. an upload whose import was refused) are deleted after a 24 h grace period
 *  - once a day per installed shop, review counts are recounted from the shop's Shopify store (repairs drift from
 *    edits made outside Proofly) — only when `recount` is given (the scheduled entry point passes Shopify access)
 */
export const IMPORT_FILE_RETENTION_DAYS = 30;
export const ORPHAN_GRACE_MS = 24 * 3_600_000;

export async function runMaintenance(now = new Date(), recount?: (shopId: string) => Promise<ShopApi | null>) {
  const report = { rateLimitsPurged: Number(await purgeRateLimits()), importsMarkedResumable: 0, importFilesDeleted: 0, orphanObjectsDeleted: 0, shops: 0, recounted: 0 };
  for (const shopId of await allShopIds()) {
    report.shops++;
    const r = await withTenant(shopId, async ({ db }) => {
      const stale = await db.importJob.updateMany({
        where: { shopId, status: "running", OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: new Date(+now - STALE_MS) } }] },
        data: { status: "failed", error: "The import stopped unexpectedly. Resume it to continue — nothing will be duplicated." },
      });
      const expired = await db.importJob.findMany({
        where: { shopId, status: { in: ["completed", "completed_with_warnings", "cancelled"] }, filesDeletedAt: null, finishedAt: { lt: new Date(+now - IMPORT_FILE_RETENTION_DAYS * 86_400_000) } },
        include: { matches: { where: { status: { in: ["unmatched", "ambiguous"] }, OR: [{ reason: null }, { reason: { not: "skipped_by_merchant" } }] }, select: { id: true } } },
      });
      const deletable = expired.filter((j) => j.matches.length === 0);
      const files = await db.importJob.findMany({ where: { shopId }, select: { id: true, fileKey: true } });
      return { stale: stale.count, deletable, files };
    });
    report.importsMarkedResumable += r.stale;
    for (const j of r.deletable) {
      await deleteObjects([j.fileKey].filter((k): k is string => !!k));
      await withTenant(shopId, ({ db }) => db.importJob.update({ where: { id: j.id }, data: { fileKey: null, filesDeletedAt: now } }));
      report.importFilesDeleted++;
    }
    const kept = new Set(r.files.filter((f) => f.fileKey && !r.deletable.some((d) => d.id === f.id)).map((f) => f.fileKey!));
    // ponytail: lists every object of the shop; sweep incrementally by prefix if a shop ever holds very many imports.
    const orphans = (await listObjects(`${shopPrefix(shopId)}/`)).filter((o) => !kept.has(o.key) && +o.modified < +now - ORPHAN_GRACE_MS).map((o) => o.key);
    report.orphanObjectsDeleted += await deleteObjects(orphans);
    if (recount) {
      const last = await withTenant(shopId, async ({ db }) => (await db.auditLog.findFirst({ where: { shopId, action: "reviews.recounted" }, orderBy: { createdAt: "desc" } }))?.createdAt);
      const api = !last || +now - +last > 86_400_000 ? await recount(shopId) : null;
      if (api) {
        await recountStats(api);
        await withTenant(shopId, ({ db }) => db.auditLog.create({ data: { shopId, actor: "system", action: "reviews.recounted", entity: "reviews" } }));
        report.recounted++;
      }
    }
  }
  return report;
}
