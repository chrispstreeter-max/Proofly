import type { LoaderFunctionArgs } from "react-router";
import { clientIp, json, rateLimit } from "../lib/http.server";
import { requireProxyTenant } from "../lib/proxy.server";
import { parseIds, ratingsFor } from "../lib/reviews.server";
import { withTenant } from "../lib/tenant.server";

// GET /apps/proofly/ratings?ids=1,2,3 → card stars for this shop's products on the page (one batched request).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireProxyTenant(request);
  if (!rateLimit(`ratings:${shop.id}:${clientIp(request)}`, 240, 60_000)) return json({ error: "rate_limited" }, { status: 429 });
  const ids = parseIds(new URL(request.url).searchParams.get("ids"));
  const ratings = ids.length ? await withTenant(shop.id, (t) => ratingsFor(t, ids)) : {};
  return json({ ratings }, { cache: 300 });
};
