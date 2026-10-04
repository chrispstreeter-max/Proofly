import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useSearchParams } from "react-router";
import type { Prisma } from "@prisma/client";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminTenant } from "../lib/admin.server";
import { withTenant } from "../lib/tenant.server";

// This shop's product catalogue (synced from Shopify) with its public review aggregate and rating ownership.
const PER_PAGE = 50;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdminTenant(request);
  const sp = new URL(request.url).searchParams;
  const q = sp.get("q")?.trim().slice(0, 100) ?? "";
  const show = sp.get("show") === "deleted" ? "deleted" : sp.get("show") === "reviewed" ? "reviewed" : "all";
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const where: Prisma.ProductWhereInput = {
    shopId: shop.id,
    ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { handle: { contains: q, mode: "insensitive" } }] } : {}),
    ...(show === "deleted" ? { deletedAt: { not: null } } : { deletedAt: null }),
    ...(show === "reviewed" ? { reviewCount: { gt: 0 } } : {}),
  };
  const [rows, count] = await withTenant(shop.id, ({ db }) => Promise.all([
    db.product.findMany({ where, orderBy: [{ reviewCount: "desc" }, { title: "asc" }], skip: (page - 1) * PER_PAGE, take: PER_PAGE, include: { _count: { select: { reviews: true } } } }),
    db.product.count({ where }),
  ]));
  return {
    count, page, pages: Math.max(1, Math.ceil(count / PER_PAGE)),
    rows: rows.map((p) => ({
      id: p.id, title: p.title, handle: p.handle, status: p.status ?? "", deleted: !!p.deletedAt,
      published: p.reviewCount, stored: p._count.reviews, average: Number(p.averageRating).toFixed(2),
      managed: p.ratingOwnership === "proofly_managed", inSync: p.ratingOwnership !== "proofly_managed" || (p.syncedCount === p.reviewCount && !!p.syncedAverage?.equals(p.averageRating)),
    })),
  };
};

export default function Products() {
  const { rows, count, page, pages } = useLoaderData<typeof loader>();
  const [sp] = useSearchParams();
  const pageHref = (n: number) => { const p = new URLSearchParams(sp); p.set("page", String(n)); return `/app/products?${p}`; };
  return (
    <s-page heading="Products">
      <s-section>
        <Form method="get">
          <s-stack direction="inline" gap="base">
            <s-text-field name="q" label="Search title or handle" value={sp.get("q") ?? ""} />
            <s-select name="show" label="Show" value={sp.get("show") ?? ""}>
              <s-option value="">All live products</s-option><s-option value="reviewed">With published reviews</s-option><s-option value="deleted">Deleted in Shopify</s-option>
            </s-select>
            <s-button type="submit">Apply</s-button>
          </s-stack>
        </Form>
      </s-section>
      <s-section heading={`${count.toLocaleString()} product${count === 1 ? "" : "s"}`}>
        <s-table>
          <s-table-header-row>
            <s-table-header>Product</s-table-header><s-table-header>Status</s-table-header><s-table-header>Published reviews</s-table-header>
            <s-table-header>Stored reviews</s-table-header><s-table-header>Average</s-table-header><s-table-header>Shopify rating</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((p) => (
              <s-table-row key={p.id}>
                <s-table-cell><s-link href={`/app/reviews?product=${encodeURIComponent(p.handle)}`}>{p.title}</s-link></s-table-cell>
                <s-table-cell>{p.deleted ? <s-badge>Deleted in Shopify (reviews kept)</s-badge> : p.status}</s-table-cell>
                <s-table-cell>{p.published}</s-table-cell>
                <s-table-cell>{p.stored}</s-table-cell>
                <s-table-cell>{p.published ? p.average : "—"}</s-table-cell>
                <s-table-cell>{p.managed ? (p.inSync ? "Managed by Proofly" : "Managed by Proofly · sync pending") : "Not managed by Proofly"}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        <s-stack direction="inline" gap="base">
          {page > 1 && <s-button href={pageHref(page - 1)}>Previous</s-button>}
          <s-text>Page {page} of {pages}</s-text>
          {page < pages && <s-button href={pageHref(page + 1)}>Next</s-button>}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
