import { authenticate } from "../shopify.server";
import { activeShopByDomain, upsertShopFromAuth } from "./tenant.server";

/**
 * Authenticated admin context. The tenant is the shop of the verified Shopify session token — never a value from
 * the request body, query string or headers. Unauthenticated requests never reach the loader body
 * (authenticate.admin throws a redirect/401 Response first).
 */
export async function requireAdminTenant(request: Request) {
  const ctx = await authenticate.admin(request);
  const shop = (await activeShopByDomain(ctx.session.shop)) ?? (await upsertShopFromAuth(ctx.session.shop, (q, o) => ctx.admin.graphql(q, o)));
  const sub = (ctx as { sessionToken?: { sub?: string } }).sessionToken?.sub;
  return { ...ctx, shop, actor: sub ? `staff:${sub}` : `admin:${shop.id}` };
}
