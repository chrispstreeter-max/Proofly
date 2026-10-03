import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { clientIp, json, rateLimit } from "../lib/http.server";
import { listReviews, parseIds, parseListParams, productSummary } from "../lib/reviews.server";

// GET /apps/proofly/products/:id/reviews?page=&rating=&photos=1&sort=recent|highest|lowest[&summary=1]
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  if (!rateLimit(`list:${clientIp(request)}`, 120, 60_000)) return json({ error: "rate_limited" }, { status: 429 });
  const [id] = parseIds(params.id ?? null, 1);
  if (!id) return json({ error: "bad_product" }, { status: 400 });
  const url = new URL(request.url);
  const opts = parseListParams(url);
  const [list, summary] = await Promise.all([
    listReviews(id, opts),
    url.searchParams.get("summary") === "1" ? productSummary(id) : null,
  ]);
  return json({ ...list, ...(summary ? { summary } : {}) }, { cache: 60 });
};
