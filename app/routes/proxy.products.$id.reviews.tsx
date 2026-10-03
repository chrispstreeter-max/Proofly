import type { LoaderFunctionArgs } from "react-router";
import { clientIp, json, rateLimit } from "../lib/http.server";
import { requireProxyTenant } from "../lib/proxy.server";
import { findProduct, listReviews, parseIds, parseListParams, productSummary } from "../lib/reviews.server";
import { withTenant } from "../lib/tenant.server";

// GET /apps/proofly/products/:id/reviews?page=&rating=&photos=1&sort=recent|highest|lowest[&summary=1]
// Unknown products and other shops' products produce the same empty response.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireProxyTenant(request);
  if (!rateLimit(`list:${shop.id}:${clientIp(request)}`, 120, 60_000)) return json({ error: "rate_limited" }, { status: 429 });
  const [id] = parseIds(params.id ?? null, 1);
  if (!id) return json({ error: "bad_product" }, { status: 400 });
  const url = new URL(request.url);
  const opts = parseListParams(url);
  const body = await withTenant(shop.id, async (t) => {
    const product = await findProduct(t, id);
    const list = await listReviews(t, product?.id ?? null, opts);
    return url.searchParams.get("summary") === "1" ? { ...list, summary: await productSummary(t, product?.id ?? null) } : list;
  });
  return json(body, { cache: 60 });
};
