import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { clientIp, json, rateLimit } from "../lib/http.server";
import { parseIds, ratingsFor } from "../lib/reviews.server";

// GET /apps/proofly/ratings?ids=1,2,3 → card stars for every product on the page (one batched request).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  if (!rateLimit(`ratings:${clientIp(request)}`, 240, 60_000)) return json({ error: "rate_limited" }, { status: 429 });
  const ids = parseIds(new URL(request.url).searchParams.get("ids"));
  return json({ ratings: ids.length ? await ratingsFor(ids) : {} }, { cache: 300 });
};
