import { purgeRateLimits } from "./http.server";
import { deleteObjects, listObjects, shopPrefix } from "./media.server";
import { STALE_MS } from "./import.server";
import { allShopIds, withTenant } from "./tenant.server";

/**
 * Scheduled maintenance (run by `npm run maintenance` from a scheduler, e.g. hourly). Retention, not plan limits:
 * nothing here ever touches a review, a reply, a photo row or its private original that a review still references.
 *  - rate-limit counters older than a day are deleted (they hold only hashed keys)
 *  - imports whose worker stopped (no heartbeat for 10 min) are marked failed so the merchant can resume them
 *  - an import's stored source CSV / images ZIP is deleted 30 days after the import finished — unless the import
 *    still has unresolved (unmatched / ambiguous, not skipped) products, whose rows exist only in that file
 *  - stored objects no database row references (e.g. left by a crash mid-batch) are deleted after a 24 h grace period
 */
export const IMPORT_FILE_RETENTION_DAYS = 30;
export const ORPHAN_GRACE_MS = 24 * 3_600_000;

export async function runMaintenance(now = new Date()) {
  const report = { rateLimitsPurged: Number(await purgeRateLimits()), importsMarkedResumable: 0, importFilesDeleted: 0, orphanObjectsDeleted: 0, shops: 0 };
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
      const images = await db.reviewImage.findMany({ where: { shopId }, select: { storageKey: true, thumbKey: true, largeKey: true } });
      const files = await db.importJob.findMany({ where: { shopId }, select: { id: true, fileKey: true, imagesKey: true } });
      return { stale: stale.count, deletable, images, files };
    });
    report.importsMarkedResumable += r.stale;
    for (const j of r.deletable) {
      await deleteObjects("private", [j.fileKey, j.imagesKey].filter((k): k is string => !!k));
      await withTenant(shopId, ({ db }) => db.importJob.update({ where: { id: j.id }, data: { fileKey: null, imagesKey: null, filesDeletedAt: now } }));
      report.importFilesDeleted++;
    }
    const kept = new Set(r.files.filter((f) => !r.deletable.some((d) => d.id === f.id)).flatMap((f) => [f.fileKey, f.imagesKey]).filter(Boolean) as string[]);
    for (const i of r.images) [i.storageKey, i.thumbKey, i.largeKey].forEach((k) => kept.add(k));
    // ponytail: lists every object of the shop; for very large media libraries, sweep incrementally by prefix.
    for (const v of ["private", "public"] as const) {
      const orphans = (await listObjects(v, `${shopPrefix(shopId)}/`)).filter((o) => !kept.has(o.key) && +o.modified < +now - ORPHAN_GRACE_MS).map((o) => o.key);
      report.orphanObjectsDeleted += await deleteObjects(v, orphans);
    }
  }
  return report;
}
