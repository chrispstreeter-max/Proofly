import type { LoaderFunctionArgs } from "react-router";
import { requireAdminTenant } from "../lib/admin.server";
import { importProblemReport } from "../lib/import.server";
import { isUuid } from "../lib/tenant.server";

// GET /app/imports/:id/report — every row that was not fully imported, with a plain-English reason (CSV).
// Authenticated shop only; another shop's import is the same 404 as a missing one. Never contains review text.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireAdminTenant(request);
  const csv = isUuid(params.id) ? await importProblemReport(shop.id, params.id) : null;
  if (csv === null) return new Response("Not found", { status: 404 });
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="proofly-import-${params.id!.slice(0, 8)}-problems.csv"`,
    },
  });
};
