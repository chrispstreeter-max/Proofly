import { authenticate } from "../shopify.server";
import { json } from "./http.server";
import { activeShopByDomain, withTenant } from "./tenant.server";

/** Same response for "app not installed", "shop uninstalled" and anything else that is not a known active tenant. */
export const storefrontNotFound = () => json({ error: "not_found" }, { status: 404 });

/**
 * Storefront (app proxy) context. authenticate.public.appProxy rejects requests whose Shopify HMAC signature is
 * missing or wrong (so the signed `shop` cannot be altered by a shopper). The tenant is then the shop of the
 * stored offline session for that signed domain; an uninstalled or unknown shop gets a 404. Finally the signed
 * `path_prefix` must be THIS shop's configured proxy path (app/lib/proxy-path.server.ts) — no global default path.
 */
export async function requireProxyTenant(request: Request) {
  const ctx = await authenticate.public.appProxy(request);
  if (!ctx.session) throw storefrontNotFound();
  const shop = await activeShopByDomain(ctx.session.shop);
  if (!shop) throw storefrontNotFound();
  const signedPath = new URL(request.url).searchParams.get("path_prefix")?.toLowerCase();
  const settings = await withTenant(shop.id, ({ db, shopId }) => db.shopSettings.findUnique({ where: { shopId }, select: { proxyPath: true } }));
  if (!settings || signedPath !== settings.proxyPath) throw storefrontNotFound();
  return { ...ctx, shop, proxyPath: settings.proxyPath };
}
