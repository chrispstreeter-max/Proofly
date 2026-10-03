import { hashToken, newToken } from "./submit.server";
import type { Tenant } from "./tenant.server";

// V1.1 feature (review requests). Retained and tenant-scoped; not part of the V1 product scope.

const LINK_TTL_DAYS = 180;

interface OrderWebhook {
  id: number;
  customer?: { id?: number } | null;
  line_items?: { product_id?: number | null }[];
}

/** orders/fulfilled → one pending review request per distinct product of this shop's order. */
export async function createRequestsFromOrder({ db, shopId }: Tenant, order: OrderWebhook) {
  const productIds = [...new Set((order.line_items ?? []).map((li) => li.product_id).filter((id): id is number => !!id))];
  for (const pid of productIds) {
    await db.reviewRequest.upsert({
      where: { shopId_shopifyOrderId_shopifyProductId: { shopId, shopifyOrderId: BigInt(order.id), shopifyProductId: BigInt(pid) } },
      create: { shopId, shopifyOrderId: BigInt(order.id), shopifyProductId: BigInt(pid), shopifyCustomerId: order.customer?.id ? BigInt(order.customer.id) : null },
      update: {},
    });
  }
  return productIds.length;
}

/** Issues (or re-issues) the secure link for one of this shop's orders. Only the token hash is stored. */
export async function issueReviewLink({ db, shopId }: Tenant, shopifyOrderId: bigint, storefrontOrigin: string) {
  const token = newToken();
  const updated = await db.reviewRequest.updateMany({
    where: { shopId, shopifyOrderId, completedAt: null },
    data: { tokenHash: hashToken(token), sentAt: new Date(), expiresAt: new Date(Date.now() + LINK_TTL_DAYS * 86_400_000) },
  });
  if (!updated.count) return null;
  await db.auditLog.create({
    data: { shopId, actor: "admin", action: "request.issue_link", entity: "order", entityId: shopifyOrderId.toString(), details: { products: updated.count } },
  });
  return `${storefrontOrigin.replace(/\/$/, "")}/apps/proofly/write?t=${token}`;
}

/** GDPR customers/redact for one shop: keep the public review, drop everything that identifies the customer. */
export async function redactCustomer({ db, shopId }: Tenant, customerId: bigint, email?: string | null) {
  const reviews = await db.review.updateMany({
    where: { shopId, OR: [{ shopifyCustomerId: customerId }, ...(email ? [{ reviewerEmail: email.toLowerCase() }] : [])] },
    data: { shopifyCustomerId: null, reviewerEmail: null, submitterIpHash: null },
  });
  const requests = await db.reviewRequest.updateMany({ where: { shopId, shopifyCustomerId: customerId }, data: { shopifyCustomerId: null } });
  await db.auditLog.create({
    data: { shopId, actor: "system", action: "customer.redact", entity: "customer", entityId: customerId.toString(), details: { reviews: reviews.count, requests: requests.count } },
  });
}
