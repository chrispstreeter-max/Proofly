import type { LoaderFunctionArgs } from "react-router";
import { requireAdminTenant } from "../lib/admin.server";
import { exportReviewsCsv } from "../lib/export.server";
import { withTenant } from "../lib/tenant.server";

// GET /app/reviews/export — all of the authenticated shop's reviews as CSV (import-template columns, re-importable).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, actor } = await requireAdminTenant(request);
  const csv = await withTenant(shop.id, async (t) => {
    const body = await exportReviewsCsv(t);
    await t.db.auditLog.create({ data: { shopId: t.shopId, actor, action: "reviews.exported", entity: "reviews" } });
    return body;
  }, { timeoutMs: 120_000 });
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="proofly-reviews-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
};
