import prisma from "../db.server";
import { hashToken, newToken } from "./submit.server";

const LINK_TTL_DAYS = 180;

interface OrderWebhook {
  id: number;
  customer?: { id?: number } | null;
  line_items?: { product_id?: number | null }[];
}

/** orders/fulfilled → one pending review request per distinct product (no token yet, nothing sent). */
export async function createRequestsFromOrder(order: OrderWebhook) {
  const productIds = [...new Set((order.line_items ?? []).map((li) => li.product_id).filter((id): id is number => !!id))];
  for (const pid of productIds) {
    await prisma.reviewRequest.upsert({
      where: { shopifyOrderId_shopifyProductId: { shopifyOrderId: BigInt(order.id), shopifyProductId: BigInt(pid) } },
      create: {
        shopifyOrderId: BigInt(order.id),
        shopifyProductId: BigInt(pid),
        shopifyCustomerId: order.customer?.id ? BigInt(order.customer.id) : null,
      },
      update: {},
    });
  }
  return productIds.length;
}

/**
 * Issues (or re-issues) the secure link for an order: one token covers every open product in the order.
 * Only the SHA-256 is stored; the raw token exists only in the returned URL (to be emailed).
 */
export async function issueReviewLink(shopifyOrderId: bigint, storefrontOrigin: string) {
  const token = newToken();
  const updated = await prisma.reviewRequest.updateMany({
    where: { shopifyOrderId, completedAt: null },
    data: { tokenHash: hashToken(token), sentAt: new Date(), expiresAt: new Date(Date.now() + LINK_TTL_DAYS * 86_400_000) },
  });
  if (!updated.count) return null;
  await prisma.auditLog.create({
    data: { actor: "admin", action: "request.issue_link", entity: "order", entityId: shopifyOrderId.toString(), details: { products: updated.count } },
  });
  return `${storefrontOrigin.replace(/\/$/, "")}/apps/proofly/write?t=${token}`;
}

/** GDPR customers/redact: keep the public review, drop everything that identifies the customer. */
export async function redactCustomer(customerId: bigint, email?: string | null) {
  const reviews = await prisma.review.updateMany({
    where: { OR: [{ shopifyCustomerId: customerId }, ...(email ? [{ reviewerEmail: email.toLowerCase() }] : [])] },
    data: { shopifyCustomerId: null, reviewerEmail: null, submitterIpHash: null },
  });
  const requests = await prisma.reviewRequest.updateMany({ where: { shopifyCustomerId: customerId }, data: { shopifyCustomerId: null } });
  await prisma.auditLog.create({
    data: { actor: "system", action: "customer.redact", entity: "customer", entityId: customerId.toString(), details: { reviews: reviews.count, requests: requests.count } },
  });
}
