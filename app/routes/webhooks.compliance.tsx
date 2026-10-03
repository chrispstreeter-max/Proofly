import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { redactCustomer } from "../lib/requests.server";

// GDPR/CCPA compliance topics (customers/data_request, customers/redact, shop/redact).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, payload, shop } = await authenticate.webhook(request);
  const p = payload as { customer?: { id?: number; email?: string } };
  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      // Data held per customer: reviews they wrote (+ private email/order link). Logged for the merchant to fulfil.
      const id = p.customer?.id ? BigInt(p.customer.id) : null;
      const count = id ? await prisma.review.count({ where: { shopifyCustomerId: id } }) : 0;
      await prisma.auditLog.create({ data: { actor: "system", action: "customer.data_request", entity: "customer", entityId: String(p.customer?.id ?? ""), details: { reviews: count } } });
      break;
    }
    case "CUSTOMERS_REDACT":
      if (p.customer?.id) await redactCustomer(BigInt(p.customer.id), p.customer.email);
      break;
    case "SHOP_REDACT":
      // Baseline: requests are logged; the shop data deletion pipeline is built in roadmap checkpoint 10.
      await prisma.auditLog.create({ data: { actor: "system", action: "shop.redact_requested", entity: "shop", entityId: shop } });
      break;
  }
  return new Response();
};
