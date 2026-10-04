import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useSearchParams } from "react-router";
import type { Prisma, ReviewStatus } from "@prisma/client";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminTenant } from "../lib/admin.server";
import { ACTIONS, moderate, type ModerationActionName } from "../lib/moderation.server";
import { syncAfterRatingChange } from "../lib/rating-cache.server";
import { isUuid, withTenant } from "../lib/tenant.server";

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
  const photos = yesNo("photos");
  const flagged = yesNo("flagged");
  const held = yesNo("held");
  const source = sp.get("source")?.trim().slice(0, 40) ?? "";
  const from = sp.get("from") ? new Date(`${sp.get("from")}T00:00:00Z`) : undefined;
  const to = sp.get("to") ? new Date(`${sp.get("to")}T23:59:59Z`) : undefined;
  const page = Math.max(1, Number(sp.get("page")) || 1);

  const where: Prisma.ReviewWhereInput = {
    shopId: shop.id,
    ...(q ? { OR: ["title", "body", "reviewerName"].map((f) => ({ [f]: { contains: q, mode: "insensitive" } })) } : {}),
    ...(product ? { product: { OR: [{ handle: { contains: product, mode: "insensitive" } }, { title: { contains: product, mode: "insensitive" } }] } } : {}),
    ...(rating >= 1 && rating <= 5 ? { rating } : {}),
    ...(status ? { status } : {}),
    ...(photos === true ? { images: { some: {} } } : photos === false ? { images: { none: {} } } : {}),
    ...(held === true ? { holdReason: "plan_limit" } : held === false ? { OR: [{ holdReason: null }, { holdReason: "moderation" }] } : {}),
    ...(source ? { source } : {}),
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
      verified: r.verifiedPurchase, images: r._count.images, flags: r.flags, replied: !!r.reply, source: r.source, held: r.holdReason === "plan_limit",
    })),
  };
};

/**
 * Bulk moderation of THIS shop's reviews (ids of other shops are ignored by the tenant-scoped moderate()).
 * Approving goes through the plan allowance: what doesn't fit stays approved but held — never rejected.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, actor } = await requireAdminTenant(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  if (!(intent in ACTIONS)) return { message: "Choose an action." };
  const ids = [...new Set(form.getAll("ids").map(String).filter(isUuid))].slice(0, 250);
  if (!ids.length) return { message: "Select at least one review." };
  const { n, held } = await withTenant(shop.id, async (t) => {
    const n = await moderate(t, ids, intent as ModerationActionName, actor);
    const held = intent === "approve" ? await t.db.review.count({ where: { shopId: t.shopId, id: { in: ids }, status: "published", holdReason: "plan_limit" } }) : 0;
    return { n, held };
  });
  if (n) await syncAfterRatingChange(shop.id, admin.graphql); // best effort; the moderation above stands either way
  const verb = { approve: "approved", reject: "rejected", hide: "hidden", restore: "returned to pending" }[intent as ModerationActionName];
  return { message: `${n} review${n === 1 ? "" : "s"} ${verb}.${held ? ` ${held} approved but currently held by your plan limit — see Plan.` : ""}` };
};

export default function Reviews() {
  const { rows, count, page, pages } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
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
              {yn("photos", "Has photos")}
              {yn("flagged", "Flagged")}
              {yn("held", "Held by plan limit")}
              <s-text-field name="source" label="Source (e.g. csv, storefront)" value={v("source")} />
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

      {result && <s-banner tone="info"><s-paragraph>{result.message}</s-paragraph></s-banner>}
      <s-section heading={`${count.toLocaleString()} review${count === 1 ? "" : "s"}`}>
        <s-button onClick={async () => {
          const res = await fetch("/app/reviews/export"); // App Bridge adds the session token
          const url = URL.createObjectURL(await res.blob());
          Object.assign(document.createElement("a"), { href: url, download: `proofly-reviews-${new Date().toISOString().slice(0, 10)}.csv` }).click();
          URL.revokeObjectURL(url);
        }}>Export all reviews (CSV)</s-button>
        <Form method="post" id="bulk">
          <s-stack direction="inline" gap="base">
            <s-select name="intent" label="With selected">
              <s-option value="approve">Approve</s-option><s-option value="hide">Hide</s-option><s-option value="reject">Reject</s-option><s-option value="restore">Return to pending</s-option>
            </s-select>
            <s-button type="submit">Apply to selected</s-button>
          </s-stack>
        </Form>
        <s-table>
          <s-table-header-row>
            <s-table-header>Select</s-table-header><s-table-header>Date</s-table-header><s-table-header>Product</s-table-header><s-table-header>Rating</s-table-header>
            <s-table-header>Review</s-table-header><s-table-header>Reviewer</s-table-header><s-table-header>Status</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((r) => (
              <s-table-row key={r.id}>
                <s-table-cell><input type="checkbox" name="ids" value={r.id} form="bulk" aria-label={`Select review by ${r.name}`} /></s-table-cell>
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
                <s-table-cell><s-badge tone={STATUS_TONE[r.status]}>{r.status}</s-badge>{r.held && <> <s-badge tone="warning">Held by plan</s-badge></>}</s-table-cell>
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
