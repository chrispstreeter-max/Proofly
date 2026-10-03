import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useSearchParams } from "react-router";
import type { Prisma, ReviewStatus } from "@prisma/client";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminTenant } from "../lib/admin.server";
import { withTenant } from "../lib/tenant.server";

const PER_PAGE = 50;
const STATUSES: ReviewStatus[] = ["pending", "published", "rejected", "hidden"];
const STATUS_TONE = { published: "success", pending: "warning", rejected: "critical", hidden: "neutral" } as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdminTenant(request);
  const sp = new URL(request.url).searchParams;
  const q = sp.get("q")?.trim().slice(0, 100) ?? "";
  const product = sp.get("product")?.trim().slice(0, 100) ?? "";
  const rating = Number(sp.get("rating"));
  const status = STATUSES.find((s) => s === sp.get("status"));
  const yesNo = (k: string) => (sp.get(k) === "yes" ? true : sp.get(k) === "no" ? false : undefined);
  const verified = yesNo("verified");
  const photos = yesNo("photos");
  const flagged = yesNo("flagged");
  const from = sp.get("from") ? new Date(`${sp.get("from")}T00:00:00Z`) : undefined;
  const to = sp.get("to") ? new Date(`${sp.get("to")}T23:59:59Z`) : undefined;
  const page = Math.max(1, Number(sp.get("page")) || 1);

  const where: Prisma.ReviewWhereInput = {
    shopId: shop.id,
    ...(q ? { OR: ["title", "body", "reviewerName"].map((f) => ({ [f]: { contains: q, mode: "insensitive" } })) } : {}),
    ...(product ? { product: { OR: [{ handle: { contains: product, mode: "insensitive" } }, { title: { contains: product, mode: "insensitive" } }] } } : {}),
    ...(rating >= 1 && rating <= 5 ? { rating } : {}),
    ...(status ? { status } : {}),
    ...(verified !== undefined ? { verifiedPurchase: verified } : {}),
    ...(photos === true ? { images: { some: {} } } : photos === false ? { images: { none: {} } } : {}),
    ...(flagged === true ? { NOT: { flags: { isEmpty: true } } } : flagged === false ? { flags: { isEmpty: true } } : {}),
    ...(from || to ? { reviewDate: { ...(from && !isNaN(+from) ? { gte: from } : {}), ...(to && !isNaN(+to) ? { lte: to } : {}) } } : {}),
  };
  const [rows, count] = await withTenant(shop.id, ({ db }) => Promise.all([
    db.review.findMany({
      where, orderBy: [{ reviewDate: "desc" }, { id: "desc" }], skip: (page - 1) * PER_PAGE, take: PER_PAGE,
      include: { product: { select: { title: true, handle: true } }, _count: { select: { images: true } }, reply: { select: { id: true } } },
    }),
    db.review.count({ where }),
  ]));
  return {
    count, page, pages: Math.max(1, Math.ceil(count / PER_PAGE)),
    rows: rows.map((r) => ({
      id: r.id, date: r.reviewDate.toISOString().slice(0, 10), product: r.product.title, rating: r.rating,
      title: r.title, excerpt: r.body.slice(0, 110), name: r.reviewerName, status: r.status,
      verified: r.verifiedPurchase, images: r._count.images, flags: r.flags, replied: !!r.reply, source: r.source,
    })),
  };
};

export default function Reviews() {
  const { rows, count, page, pages } = useLoaderData<typeof loader>();
  const [sp] = useSearchParams();
  const v = (k: string) => sp.get(k) ?? "";
  const pageHref = (n: number) => { const p = new URLSearchParams(sp); p.set("page", String(n)); return `/app/reviews?${p}`; };
  const yn = (name: string, label: string) => (
    <s-select name={name} label={label} value={v(name)}>
      <s-option value="">Any</s-option><s-option value="yes">Yes</s-option><s-option value="no">No</s-option>
    </s-select>
  );
  return (
    <s-page heading="Reviews">
      <s-section>
        <Form method="get">
          <s-stack gap="base">
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
              <s-text-field name="q" label="Search text or reviewer" value={v("q")} />
              <s-text-field name="product" label="Product" value={v("product")} />
              <s-select name="rating" label="Rating" value={v("rating")}>
                <s-option value="">Any</s-option>
                {[5, 4, 3, 2, 1].map((n) => <s-option key={n} value={String(n)}>{`${n} star`}</s-option>)}
              </s-select>
              <s-select name="status" label="Status" value={v("status")}>
                <s-option value="">Any</s-option>
                {STATUSES.map((s) => <s-option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</s-option>)}
              </s-select>
              {yn("verified", "Verified purchase")}
              {yn("photos", "Has photos")}
              {yn("flagged", "Flagged")}
              <s-date-field name="from" label="From" value={v("from")} />
              <s-date-field name="to" label="To" value={v("to")} />
            </s-grid>
            <s-stack direction="inline" gap="base">
              <s-button type="submit" variant="primary">Apply filters</s-button>
              <s-button href="/app/reviews" variant="tertiary">Clear</s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading={`${count.toLocaleString()} review${count === 1 ? "" : "s"}`}>
        <s-table>
          <s-table-header-row>
            <s-table-header>Date</s-table-header><s-table-header>Product</s-table-header><s-table-header>Rating</s-table-header>
            <s-table-header>Review</s-table-header><s-table-header>Reviewer</s-table-header><s-table-header>Status</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((r) => (
              <s-table-row key={r.id}>
                <s-table-cell>{r.date}</s-table-cell>
                <s-table-cell>{r.product}</s-table-cell>
                <s-table-cell>{"★".repeat(r.rating)}</s-table-cell>
                <s-table-cell>
                  <s-link href={`/app/reviews/${r.id}`}>{r.title || "(no title)"}</s-link>
                  <s-text color="subdued"> {r.excerpt}{r.excerpt.length >= 110 ? "…" : ""}</s-text>
                  {r.images > 0 && <s-badge>{`${r.images} photo${r.images > 1 ? "s" : ""}`}</s-badge>}
                  {r.flags.length > 0 && <s-badge tone="caution">{r.flags.map((f) => f.replace(/_x\d+$/, "")).join(", ")}</s-badge>}
                </s-table-cell>
                <s-table-cell>{r.name}{r.verified && <> <s-badge tone="success">Verified</s-badge></>}</s-table-cell>
                <s-table-cell><s-badge tone={STATUS_TONE[r.status]}>{r.status}</s-badge></s-table-cell>
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
