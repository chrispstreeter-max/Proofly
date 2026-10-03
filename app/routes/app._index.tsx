import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext } from "../lib/admin.server";
import { ensureReviewMetafieldDefinitions, recomputeAll, syncMetafields } from "../lib/aggregates.server";
import { issueReviewLink } from "../lib/requests.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await adminContext(request);
  const [byStatus, total, withPhotos, verified, flagged, products, unsynced, requests] = await Promise.all([
    prisma.review.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.review.count(),
    prisma.review.count({ where: { images: { some: {} } } }),
    prisma.review.count({ where: { verifiedPurchase: true } }),
    prisma.review.count({ where: { NOT: { flags: { isEmpty: true } } } }),
    prisma.product.count({ where: { reviewCount: { gt: 0 } } }),
    prisma.$queryRaw<{ n: bigint }[]>`select count(*) as n from products
      where synced_count is distinct from review_count or synced_average is distinct from average_rating`,
    prisma.reviewRequest.groupBy({
      by: ["shopifyOrderId"],
      _count: { _all: true },
      _max: { createdAt: true, sentAt: true, completedAt: true },
      orderBy: { _max: { createdAt: "desc" } },
      take: 10,
    }),
  ]);
  const status = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all]));
  return {
    stats: { total, published: status.published ?? 0, pending: status.pending ?? 0, rejected: status.rejected ?? 0, hidden: status.hidden ?? 0, withPhotos, verified, flagged, products },
    unsynced: Number(unsynced[0]?.n ?? 0),
    requests: requests.map((r) => ({
      order: r.shopifyOrderId.toString(), products: r._count._all,
      created: r._max.createdAt?.toISOString().slice(0, 10), sent: !!r._max.sentAt, completed: !!r._max.completedAt,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, actor } = await adminContext(request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "sync") {
    await recomputeAll();
    await ensureReviewMetafieldDefinitions(admin.graphql);
    const n = await syncMetafields(admin.graphql);
    await prisma.auditLog.create({ data: { actor, action: "metafields.sync", entity: "products", details: { written: n } } });
    return { message: `Ratings synced to Shopify for ${n} product${n === 1 ? "" : "s"}.` };
  }
  if (intent === "issue_link") {
    const order = String(form.get("order") ?? "");
    if (!/^\d+$/.test(order)) return { message: "Invalid order." };
    const res = await admin.graphql(`{ shop { primaryDomain { url } } }`);
    const origin = (await res.json()).data.shop.primaryDomain.url as string;
    const url = await issueReviewLink(BigInt(order), origin);
    return url ? { message: "New review link (copy it now — it is not stored):", url } : { message: "Every product on that order has already been reviewed." };
  }
  return { message: "Unknown action." };
};

const Stat = ({ label, value, href }: { label: string; value: number; href?: string }) => (
  <s-box padding="base" border="base" borderRadius="base" background="base">
    <s-stack gap="small-200">
      <s-text color="subdued">{label}</s-text>
      {href ? <s-link href={href}><s-heading>{value.toLocaleString()}</s-heading></s-link> : <s-heading>{value.toLocaleString()}</s-heading>}
    </s-stack>
  </s-box>
);

export default function Dashboard() {
  const { stats, unsynced, requests } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  return (
    <s-page heading="Proofly">
      {result && (
        <s-banner tone="info">
          <s-paragraph>{result.message}</s-paragraph>
          {"url" in result && result.url && <s-paragraph><code style={{ wordBreak: "break-all" }}>{result.url}</code></s-paragraph>}
        </s-banner>
      )}
      <s-section heading="Overview">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="base">
          <Stat label="Total reviews" value={stats.total} href="/app/reviews" />
          <Stat label="Published" value={stats.published} href="/app/reviews?status=published" />
          <Stat label="Pending" value={stats.pending} href="/app/reviews?status=pending" />
          <Stat label="Rejected" value={stats.rejected} href="/app/reviews?status=rejected" />
          <Stat label="Hidden" value={stats.hidden} href="/app/reviews?status=hidden" />
          <Stat label="With photos" value={stats.withPhotos} href="/app/reviews?photos=yes" />
          <Stat label="Verified purchases" value={stats.verified} href="/app/reviews?verified=yes" />
          <Stat label="Flagged for review" value={stats.flagged} href="/app/reviews?flagged=yes" />
          <Stat label="Products with reviews" value={stats.products} />
        </s-grid>
      </s-section>

      <s-section heading="Storefront ratings">
        <s-stack gap="base">
          <s-paragraph>
            Product ratings are calculated from published reviews in this app and copied to Shopify
            (<code>reviews.rating</code>, <code>reviews.rating_count</code>) for the product page and search engines.
            {unsynced > 0 ? ` ${unsynced} product${unsynced === 1 ? " needs" : "s need"} syncing.` : " Everything is in sync."}
          </s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="sync" />
            <s-button type="submit" variant="primary" loading={busy || undefined}>Sync ratings to Shopify</s-button>
          </Form>
        </s-stack>
      </s-section>

      <s-section heading="Review requests">
        {requests.length === 0 ? (
          <s-paragraph>Fulfilled orders will appear here. Review-request emails are not automated yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Order</s-table-header><s-table-header>Products</s-table-header>
              <s-table-header>Created</s-table-header><s-table-header>Status</s-table-header><s-table-header>Link</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {requests.map((r) => (
                <s-table-row key={r.order}>
                  <s-table-cell>{r.order}</s-table-cell>
                  <s-table-cell>{r.products}</s-table-cell>
                  <s-table-cell>{r.created}</s-table-cell>
                  <s-table-cell>{r.completed ? <s-badge tone="success">Reviewed</s-badge> : r.sent ? <s-badge tone="info">Link issued</s-badge> : <s-badge>Not sent</s-badge>}</s-table-cell>
                  <s-table-cell>
                    <Form method="post">
                      <input type="hidden" name="intent" value="issue_link" />
                      <input type="hidden" name="order" value={r.order} />
                      <s-button type="submit" variant="tertiary">Create review link</s-button>
                    </Form>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
