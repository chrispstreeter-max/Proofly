import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { redactShop, shopByDomain, withTenant } from "../lib/tenant.server";

// GDPR/CCPA compliance topics. The shop is the one Shopify signed the webhook for; nothing outside it is touched.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, payload, shop: domain } = await authenticate.webhook(request);
  if (topic === "SHOP_REDACT") {
    // Permanent deletion of everything Proofly holds for this shop (DB + storage). Idempotent.
    const r = await redactShop(domain);
    console.info("shop/redact", r.deleted ? "deleted" : r.reason);
    return new Response();
  }
  const shop = await shopByDomain(domain); // includes uninstalled shops (redaction arrives after uninstall)
  if (!shop) return new Response();
  const p = payload as { customer?: { id?: number } };
  await withTenant(shop.id, async ({ db, shopId }) => {
    switch (topic) {
      case "CUSTOMERS_DATA_REQUEST": {
        // V1 stores no customer identity: new reviews carry only the display name the reviewer typed. Rows linked to a
        // Shopify customer id can only come from legacy data; the merchant is told how many (no personal data logged).
        const id = p.customer?.id ? BigInt(p.customer.id) : null;
        const count = id ? await db.review.count({ where: { shopId, shopifyCustomerId: id } }) : 0;
        await db.auditLog.create({ data: { shopId, actor: "system", action: "customer.data_request", entity: "customer", details: { linkedReviews: count, storesCustomerData: count > 0 } } });
        break;
      }
      case "CUSTOMERS_REDACT": {
        // V1 stores no reviewer contact data; rows linked to a Shopify customer id (legacy/V1.1) are unlinked.
        const id = p.customer?.id ? BigInt(p.customer.id) : null;
        const reviews = id
          ? await db.review.updateMany({ where: { shopId, shopifyCustomerId: id }, data: { shopifyCustomerId: null, submitterIpHash: null } })
          : { count: 0 };
        await db.auditLog.create({ data: { shopId, actor: "system", action: "customer.redact", entity: "customer", details: { reviews: reviews.count } } });
        break;
      }
    }
  });
  return new Response();
};
