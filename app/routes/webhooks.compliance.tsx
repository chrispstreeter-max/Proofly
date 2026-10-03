import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { shopByDomain, withTenant } from "../lib/tenant.server";

// GDPR/CCPA compliance topics. The shop is the one Shopify signed the webhook for; nothing outside it is touched.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, payload, shop: domain } = await authenticate.webhook(request);
  const shop = await shopByDomain(domain); // includes uninstalled shops (redaction arrives after uninstall)
  if (!shop) return new Response();
  const p = payload as { customer?: { id?: number; email?: string } };
  await withTenant(shop.id, async ({ db, shopId }) => {
    switch (topic) {
      case "CUSTOMERS_DATA_REQUEST": {
        const id = p.customer?.id ? BigInt(p.customer.id) : null;
        const count = id ? await db.review.count({ where: { shopId, shopifyCustomerId: id } }) : 0;
        await db.auditLog.create({ data: { shopId, actor: "system", action: "customer.data_request", entity: "customer", entityId: String(p.customer?.id ?? ""), details: { reviews: count } } });
        break;
      }
      case "CUSTOMERS_REDACT": {
        // V1 stores no customer identity for new reviews; imported/legacy rows may still carry an email or customer id.
        const id = p.customer?.id ? BigInt(p.customer.id) : null;
        const email = p.customer?.email?.toLowerCase();
        const or = [...(id ? [{ shopifyCustomerId: id }] : []), ...(email ? [{ reviewerEmail: email }] : [])];
        const reviews = or.length
          ? await db.review.updateMany({ where: { shopId, OR: or }, data: { shopifyCustomerId: null, reviewerEmail: null, submitterIpHash: null } })
          : { count: 0 };
        await db.auditLog.create({ data: { shopId, actor: "system", action: "customer.redact", entity: "customer", entityId: String(p.customer?.id ?? ""), details: { reviews: reviews.count } } });
        break;
      }
      case "SHOP_REDACT":
        // Baseline: the request is recorded; the shop data deletion pipeline is built in roadmap checkpoint 10.
        await db.auditLog.create({ data: { shopId, actor: "system", action: "shop.redact_requested", entity: "shop", entityId: shopId } });
        break;
    }
  });
  return new Response();
};
