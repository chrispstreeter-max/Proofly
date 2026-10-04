import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminTenant } from "../lib/admin.server";
import { readStats } from "../lib/entitlements.server";
import { ACTIONS, moderate, reviewGid, reviewParam, type ModerationActionName } from "../lib/moderation.server";
import { syncAfterRatingChange } from "../lib/rating-cache.server";
import { pageReviews, type ReviewQuery } from "../lib/review-store.server";
import { STATUSES } from "../lib/review-status";
import { withTenant } from "../lib/tenant.server";

const PER_PAGE = 50;
const STATUS_TONE = { published: "success", pending: "warning", rejected: "critical", hidden: "neutral" } as const;

// Reviews live in the shop's Shopify store; filters map to Shopify's metaobject search (exact fields, rating and date
// ranges, reviewer-name prefix). Shopify has no full-text search over review text, so "search" is by reviewer name.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, api } = await requireAdminTenant(request);
  const sp = new URL(request.url).searchParams;
  const reviewer = sp.get("q")?.trim().slice(0, 60) ?? "";
  const productSearch = sp.get("product")?.trim().slice(0, 100) ?? "";
  const rating = Number(sp.get("rating"));
  const status = STATUSES.find((s) => s === sp.get("status"));
  const yesNo = (k: string) => (sp.get(k) === "yes" ? true : sp.get(k) === "no" ? false : undefined);
  const from = sp.get("from") ? new Date(`${sp.get("from")}T00:00:00Z`) : undefined;
  const to = sp.get("to") ? new Date(`${sp.get("to")}T23:59:59Z`) : undefined;
  const after = sp.get("after")?.slice(0, 500) || null;

  const { products, matchedIds, total } = await withTenant(shop.id, async (t) => {
    const matched = productSearch
      ? await t.db.product.findMany({ where: { shopId: t.shopId, OR: [{ handle: { contains: productSearch, mode: "insensitive" } }, { title: { contains: productSearch, mode: "insensitive" } }] }, select: { shopifyProductId: true }, take: 50 })
      : null;
    return {
      products: new Map((await t.db.product.findMany({ where: { shopId: t.shopId }, select: { shopifyProductId: true, title: true } })).map((p) => [String(p.shopifyProductId), p.title])),
      matchedIds: matched?.map((p) => p.shopifyProductId) ?? null,
      total: (await readStats(t)).total,
    };
  });
  const q: ReviewQuery = {
    ...(reviewer ? { reviewerPrefix: reviewer } : {}),
    ...(rating >= 1 && rating <= 5 ? { rating } : {}),
    ...(status ? { status } : {}),
    ...(yesNo("held") !== undefined ? { held: yesNo("held") } : {}),
    ...(yesNo("flagged") !== undefined ? { flagged: yesNo("flagged") } : {}),
    ...(sp.get("source") ? { source: sp.get("source")!.trim().slice(0, 40) } : {}),
    ...(from && !isNaN(+from) ? { from } : {}),
    ...(to && !isNaN(+to) ? { to } : {}),
  };
  const filtered = Object.keys(q).length > 0 || matchedIds !== null;
  const page = matchedIds && !matchedIds.length ? { reviews: [], next: null } : await pageReviews(api, { ...q, ...(matchedIds ? { productIds: matchedIds } : {}) }, { first: PER_PAGE, after });
  return {
    total, filtered, next: page.next,
    rows: page.reviews.map((r) => ({
      id: reviewParam(r.id), date: r.reviewDate.toISOString().slice(0, 10), product: products.get(String(r.productId)) ?? "(product not in catalogue)", rating: r.rating,
      title: r.title, excerpt: r.body.slice(0, 110), name: r.reviewerName, status: r.status,
      verified: r.verified, flags: r.flags, replied: !!r.reply, source: r.source, held: r.held, editedOutside: r.editedOutside,
    })),
  };
};

/**
 * Bulk moderation of THIS shop's reviews (the shop's Admin API cannot reach another shop's entries, so foreign ids are
 * simply not found). Approving goes through the plan allowance: what doesn't fit stays approved but held.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, api, actor } = await requireAdminTenant(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  if (!(intent in ACTIONS)) return { message: "Choose an action." };
  const ids = [...new Set(form.getAll("ids").map((x) => reviewGid(String(x))).filter((x): x is string => !!x))].slice(0, 250);
  if (!ids.length) return { message: "Select at least one review." };
  const changed = await moderate(api, ids, intent as ModerationActionName, actor);
  const held = intent === "approve" ? changed.filter((r) => r.status === "published" && r.held).length : 0;
  if (changed.length) await syncAfterRatingChange(api.shopId, admin.graphql); // best effort; the moderation above stands either way
  const n = changed.length;
  const verb = { approve: "approved", reject: "rejected", hide: "hidden", restore: "returned to pending" }[intent as ModerationActionName];
  return { message: `${n} review${n === 1 ? "" : "s"} ${verb}.${held ? ` ${held} approved but currently held by your plan limit — see Plan.` : ""}` };
};

export default function Reviews() {
  const { rows, total, filtered, next } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [sp] = useSearchParams();
  const v = (k: string) => sp.get(k) ?? "";
  const nextHref = (cursor: string) => { const p = new URLSearchParams(sp); p.set("after", cursor); return `/app/reviews?${p}`; };
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
              <s-text-field name="q" label="Reviewer name starts with" value={v("q")} />
              <s-text-field name="product" label="Product" value={v("product")} />
              <s-select name="rating" label="Rating" value={v("rating")}>
                <s-option value="">Any</s-option>
                {[5, 4, 3, 2, 1].map((n) => <s-option key={n} value={String(n)}>{`${n} star`}</s-option>)}
              </s-select>
              <s-select name="status" label="Status" value={v("status")}>
                <s-option value="">Any</s-option>
                {STATUSES.map((s) => <s-option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</s-option>)}
              </s-select>
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
      <s-section heading={filtered ? "Matching reviews" : `${total.toLocaleString()} review${total === 1 ? "" : "s"}`}>
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
                  {r.flags.length > 0 && <s-badge tone="caution">{r.flags.map((f) => f.replace(/_x\d+$/, "")).join(", ")}</s-badge>}
                  {r.editedOutside && <s-badge tone="critical">Edited outside Proofly — hidden until approved</s-badge>}
                </s-table-cell>
                <s-table-cell>{r.name}{r.verified && <> <s-badge tone="success">Verified</s-badge></>}</s-table-cell>
                <s-table-cell><s-badge tone={STATUS_TONE[r.status]}>{r.status}</s-badge>{r.held && <> <s-badge tone="warning">Held by plan</s-badge></>}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        <s-stack direction="inline" gap="base">
          {sp.get("after") && <s-button href={`/app/reviews?${(() => { const p = new URLSearchParams(sp); p.delete("after"); return p; })()}`}>First page</s-button>}
          {next && <s-button href={nextHref(next)}>Next</s-button>}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
