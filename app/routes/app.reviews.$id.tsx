import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext } from "../lib/admin.server";
import { publicUrl } from "../lib/media.server";
import { ACTIONS, moderate, saveReply, type ModerationAction } from "../lib/moderation.server";

const UUID = /^[0-9a-f-]{36}$/;
const TONE = { published: "success", pending: "warning", rejected: "critical", hidden: "neutral" } as const;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await adminContext(request);
  if (!UUID.test(params.id ?? "")) throw new Response("Not found", { status: 404 });
  const r = await prisma.review.findUnique({
    where: { id: params.id },
    include: { product: true, images: { orderBy: { position: "asc" } }, reply: true },
  });
  if (!r) throw new Response("Not found", { status: 404 });
  const history = await prisma.auditLog.findMany({ where: { entity: "review", entityId: r.id }, orderBy: { createdAt: "desc" }, take: 20 });
  return {
    review: {
      id: r.id, sourceId: r.sourceReviewId, source: r.source, imported: r.imported, status: r.status, rating: r.rating,
      title: r.title, body: r.body, name: r.reviewerName, date: r.reviewDate.toISOString().slice(0, 16).replace("T", " "),
      verified: r.verifiedPurchase, flags: r.flags,
      // Admin-only private fields:
      email: r.reviewerEmail, customerId: r.shopifyCustomerId?.toString() ?? null, orderId: r.shopifyOrderId?.toString() ?? null,
      product: { title: r.product.title, handle: r.product.handle, id: r.product.shopifyProductId.toString() },
      images: r.images.map((i) => ({ thumb: publicUrl(i.thumbKey), large: publicUrl(i.largeKey), sha: i.sha256.slice(0, 12) })),
      reply: r.reply?.reply ?? "",
    },
    history: history.map((h) => ({ at: h.createdAt.toISOString().slice(0, 16).replace("T", " "), actor: h.actor, action: h.action })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, actor } = await adminContext(request);
  if (!UUID.test(params.id ?? "")) throw new Response("Not found", { status: 404 });
  const form = await request.formData();
  const intent = String(form.get("intent"));
  if (intent === "reply") {
    await saveReply(params.id!, String(form.get("reply") ?? ""), actor);
    return { message: "Reply saved." };
  }
  if (intent in ACTIONS) {
    await moderate([params.id!], intent as ModerationAction, actor, admin.graphql);
    return { message: `Review ${ACTIONS[intent as ModerationAction]}. Storefront rating updated.` };
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
          <s-text>Customer ID: {r.customerId ?? "—"}</s-text>
          <s-text>Order ID: {r.orderId ?? "—"}</s-text>
        </s-stack>
      </s-section>
      <s-section slot="aside" heading="History">
        {history.length ? history.map((h, i) => <s-paragraph key={i}>{h.at} · {h.action} · {h.actor}</s-paragraph>) : <s-paragraph>No changes yet.</s-paragraph>}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
