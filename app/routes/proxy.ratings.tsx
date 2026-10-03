import type { LoaderFunctionArgs } from "react-router";
import { clientIp, json, rateLimit } from "../lib/http.server";
import { requireProxyTenant } from "../lib/proxy.server";
import { parseHandles, ratingsByHandle } from "../lib/reviews.server";
import { withTenant } from "../lib/tenant.server";

// GET <proxy path>/ratings?handles=a,b,c → { ratings: { handle: [average, count] } } for THIS shop.
// Fallback only: the card embed first uses ratings Liquid rendered from Shopify's standard metafields and asks here,
// in one batched request, only for product cards Liquid could not see.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireProxyTenant(request);
  if (!rateLimit(`ratings:${shop.id}:${clientIp(request)}`, 240, 60_000)) return json({ error: "rate_limited" }, { status: 429 });
  const handles = parseHandles(new URL(request.url).searchParams.get("handles"));
  const ratings = handles.length ? await withTenant(shop.id, (t) => ratingsByHandle(t, handles)) : {};
  return json({ ratings }, { cache: 300 });
};
