import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleProductWebhook } from "../lib/products.server";
import { activeShopByDomain } from "../lib/tenant.server";

// products/create | products/update | products/delete.
// The merchant is the shop Shopify signed the webhook for (HMAC verified by authenticate.webhook → 401 otherwise).
// Nothing in the body, query or other headers selects the tenant. Unknown/uninstalled shops and unusable payloads are
// acknowledged (200) and ignored so Shopify does not retry them; processing is idempotent (stale updates ignored,
// deletes repeatable). This handler never calls Shopify and never touches rating metafields.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop: domain, payload } = await authenticate.webhook(request);
  const shop = await activeShopByDomain(domain);
  if (!shop) return new Response();
  const result = await handleProductWebhook(shop.id, topic, payload);
  if (result === "ignored-malformed") console.warn("product webhook ignored: unusable payload", topic, shop.id);
  return new Response();
};
