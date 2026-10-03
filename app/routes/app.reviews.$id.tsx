import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminTenant } from "../lib/admin.server";
import { publicUrl } from "../lib/media.server";
import { ACTIONS, moderate, moderationHistory, saveReply, type ModerationActionName } from "../lib/moderation.server";
import { syncMetafields } from "../lib/aggregates.server";
import { isUuid, withTenant } from "../lib/tenant.server";

// Missing reviews and other shops' reviews get the identical response (no existence leak).
const notFound = () => new Response("Not found", { status: 404 });
const TONE = { published: "success", pending: "warning", rejected: "critical", hidden: "neutral" } as const;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireAdminTenant(request);
  if (!isUuid(params.id)) throw notFound();
  const found = await withTenant(shop.id, async (t) => {
    const r = await t.db.review.findFirst({
      where: { shopId: t.shopId, id: params.id },
      include: { product: true, images: { orderBy: { position: "asc" } }, reply: true },
    });
    if (!r) return null;
    const history = await moderationHistory(t, r.id);
    return { r, history };
  });
  if (!found) throw notFound();
  const { r, history } = found;
  return {
    review: {
      id: r.id, sourceId: r.sourceReviewId, source: r.source, imported: r.imported, status: r.status, rating: r.rating,
      title: r.title, body: r.body, name: r.reviewerName, date: r.reviewDate.toISOString().slice(0, 16).replace("T", " "),
      verified: r.verifiedPurchase, flags: r.flags,
      // Admin-only private fields:
      email: r.reviewerEmail,
      product: { title: r.product.title, handle: r.product.handle, id: r.product.shopifyProductId.toString() },
      images: r.images.map((i) => ({ thumb: publicUrl(i.thumbKey), large: publicUrl(i.largeKey), sha: i.sha256.slice(0, 12) })),
      reply: r.reply?.reply ?? "",
    },
    history: history.map((h) => ({ at: h.createdAt.toISOString().slice(0, 16).replace("T", " "), actor: h.actor, action: `${h.action} (${h.fromStatus} → ${h.toStatus})` })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, actor, shop } = await requireAdminTenant(request);
  if (!isUuid(params.id)) throw notFound();
  const form = await request.formData();
  const intent = String(form.get("intent"));
  if (intent === "reply") {
    const ok = await withTenant(shop.id, (t) => saveReply(t, params.id!, String(form.get("reply") ?? ""), actor));
    if (!ok) throw notFound();
    return { message: "Reply saved." };
  }
  if (intent in ACTIONS) {
    const n = await withTenant(shop.id, (t) => moderate(t, [params.id!], intent as ModerationActionName, actor));
    if (!n) throw notFound();
    await syncMetafields(shop.id, admin.graphql);
    return { message: `Review ${ACTIONS[intent as ModerationActionName]}. Storefront rating updated.` };
  }
  return { message: "Unknown action." };
};

const Act = ({ intent, label, tone }: { intent: string; label: string; tone?: "critical" }) => (
  <Form method="post">
    <input type="hidden" name="intent" value={intent} />
    <s-button type="submit" tone={tone} variant={intent === "approve" ? "primary" : "secondary"}>{label}</s-button>
  </Form>
);

export default function ReviewDetail() {
  const { review: r, history } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <s-page heading={r.title || "(no title)"}>
      <s-link slot="breadcrumb-actions" href="/app/reviews">Reviews</s-link>
      {result && <s-banner tone="success"><s-paragraph>{result.message}</s-paragraph></s-banner>}
      {r.flags.includes("merchant_response_posted_as_review") && (
        <s-banner tone="warning"><s-paragraph>
          Imported review flagged as a likely store response that was posted as a 5-star review.
          It is not shown on the storefront until you approve it.
        </s-paragraph></s-banner>
      )}

      <s-section heading="Review">
        <s-stack gap="base">
          <s-stack direction="inline" gap="small">
            <s-badge tone={TONE[r.status]}>{r.status}</s-badge>
            {r.verified && <s-badge tone="success">Verified purchase</s-badge>}
            {r.imported && <s-badge>{`Imported from ${r.source}`}</s-badge>}
            {r.flags.map((f) => <s-badge key={f} tone="caution">{f}</s-badge>)}
          </s-stack>
          <s-text>{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)} · {r.name} · {r.date}</s-text>
          <s-paragraph><span style={{ whiteSpace: "pre-line" }}>{r.body}</span></s-paragraph>
          {r.images.length > 0 && (
            <s-stack direction="inline" gap="small">
              {r.images.map((i) => (
                <s-link key={i.sha} href={i.large} target="_blank"><s-thumbnail src={i.thumb} alt="Review photo" size="large" /></s-link>
              ))}
            </s-stack>
          )}
          <s-stack direction="inline" gap="small">
            {r.status !== "published" && <Act intent="approve" label="Approve" />}
            {r.status === "published" && <Act intent="hide" label="Hide" />}
            {r.status !== "rejected" && <Act intent="reject" label="Reject" tone="critical" />}
            {(r.status === "rejected" || r.status === "hidden") && <Act intent="restore" label="Restore to pending" />}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Public reply">
        <Form method="post">
          <input type="hidden" name="intent" value="reply" />
          <s-stack gap="base">
            <s-text-area name="reply" label="Reply shown under the review as “Response from {your store name}” (leave empty to remove)" value={r.reply} rows={4} maxLength={5000} />
            <s-button type="submit">Save reply</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section slot="aside" heading="Details">
        <s-stack gap="small">
          <s-text>Product: <s-link href={`shopify://admin/products/${r.product.id}`}>{r.product.title}</s-link></s-text>
          <s-text>Source: {r.source} ({r.sourceId})</s-text>
          <s-text>Email (private): {r.email ?? "—"}</s-text>
        </s-stack>
      </s-section>
      <s-section slot="aside" heading="History">
        {history.length ? history.map((h, i) => <s-paragraph key={i}>{h.at} · {h.action} · {h.actor}</s-paragraph>) : <s-paragraph>No changes yet.</s-paragraph>}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
