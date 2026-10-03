import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createRequestsFromOrder } from "../lib/requests.server";
import { activeShopByDomain, withTenant } from "../lib/tenant.server";

// V1.1 (review requests): retained and tenant-scoped; not subscribed in the V1 configuration.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop: domain, payload } = await authenticate.webhook(request); // verifies Shopify HMAC
  const shop = await activeShopByDomain(domain);
  if (shop) await withTenant(shop.id, (t) => createRequestsFromOrder(t, payload as Parameters<typeof createRequestsFromOrder>[1]));
  return new Response();
};
