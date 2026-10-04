import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { redactShop, shopByDomain, withTenant } from "../lib/tenant.server";

// GDPR/CCPA compliance topics. The shop is the one Shopify signed the webhook for; nothing outside it is touched.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop: domain } = await authenticate.webhook(request);
  if (topic === "SHOP_REDACT") {
    // Permanent deletion of everything Proofly holds for this shop (DB + storage). Idempotent.
    const r = await redactShop(domain);
    console.info("shop/redact", r.deleted ? "deleted" : r.reason);
    return new Response();
  }
  const shop = await shopByDomain(domain); // includes uninstalled shops (redaction arrives after uninstall)
  if (!shop) return new Response();
  await withTenant(shop.id, async ({ db, shopId }) => {
    switch (topic) {
      // Proofly stores no customer identity anywhere: reviews (in the merchant's Shopify store) carry only the display name
      // the reviewer typed — no customer id, email, order or IP. Both requests are recorded without personal data.
      case "CUSTOMERS_DATA_REQUEST":
        await db.auditLog.create({ data: { shopId, actor: "system", action: "customer.data_request", entity: "customer", details: { linkedReviews: 0, storesCustomerData: false } } });
        break;
      case "CUSTOMERS_REDACT":
        await db.auditLog.create({ data: { shopId, actor: "system", action: "customer.redact", entity: "customer", details: { reviews: 0 } } });
        break;
    }
  });
  return new Response();
};
