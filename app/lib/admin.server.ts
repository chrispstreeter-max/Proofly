import { authenticate } from "../shopify.server";
import { ensureReviewDefinition, type GraphqlFn } from "./review-store.server";
import { activeShopByDomain, upsertShopFromAuth } from "./tenant.server";

const definitionChecked = new Set<string>();

/**
 * Authenticated admin context. The tenant is the shop of the verified Shopify session token — never a value from
 * the request body, query string or headers. Unauthenticated requests never reach the loader body
 * (authenticate.admin throws a redirect/401 Response first).
 */
export async function requireAdminTenant(request: Request) {
  const ctx = await authenticate.admin(request);
  const shop = (await activeShopByDomain(ctx.session.shop)) ?? (await upsertShopFromAuth(ctx.session.shop, (q, o) => ctx.admin.graphql(q, o)));
  const sub = (ctx as { sessionToken?: { sub?: string } }).sessionToken?.sub;
  // The review store of THIS shop (its session's Admin API client can only reach this shop's data).
  const api = { shopId: shop.id, graphql: ((q, o) => ctx.admin.graphql(q, o)) as GraphqlFn };
  // Once per shop per process: make sure the review type has every field Proofly now uses (also done at install).
  if (!definitionChecked.has(shop.id)) {
    await ensureReviewDefinition(api).then(() => definitionChecked.add(shop.id), (e) => console.warn("review definition check deferred", shop.id, e));
  }
  return { ...ctx, shop, api, actor: sub ? `staff:${sub}` : `admin:${shop.id}` };
}
