import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { clientIp, ipHash, json, originAllowed, rateLimit } from "../lib/http.server";
import { parseIds } from "../lib/reviews.server";
import { SubmitError, createReview, ensureProduct, findPurchase, parseSubmission } from "../lib/submit.server";

// POST /apps/proofly/reviews (multipart) — "Write a Review" on the product page. Always lands in moderation.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
  const { admin } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const ip = clientIp(request);
  try {
    if (!originAllowed(request, url.searchParams.get("shop"))) throw new SubmitError("form", "Submission rejected.", 403);
    if (Number(request.headers.get("content-length") ?? 0) > 52 * 1024 * 1024) throw new SubmitError("images", "Photos are too large.", 413);
    if (!rateLimit(`submit:${ip}`, 5, 3_600_000)) throw new SubmitError("form", "Too many reviews from this connection. Try again later.", 429);

    const form = await request.formData();
    const [productId] = parseIds(String(form.get("product_id") ?? ""), 1);
    if (!productId) throw new SubmitError("product", "Product not found.", 404);
    const data = await parseSubmission(form);
    await ensureProduct(admin, productId);

    // logged_in_customer_id is part of Shopify's HMAC-signed query string, so it cannot be forged.
    const customerRaw = url.searchParams.get("logged_in_customer_id");
    const customerId = customerRaw && /^\d+$/.test(customerRaw) ? BigInt(customerRaw) : null;
    const orderId = customerId ? await findPurchase(admin, customerId, productId) : null;

    await createReview({
      productId, data, verified: orderId !== null, source: "storefront",
      customerId, orderId, ipHash: ipHash(ip),
    });
    return json({ ok: true, verified: orderId !== null }, { status: 201 });
  } catch (e) {
    if (e instanceof SubmitError) return json({ ok: false, field: e.field, error: e.message }, { status: e.status });
    console.error("review submit failed", e);
    return json({ ok: false, field: "form", error: "Something went wrong. Please try again." }, { status: 500 });
  }
};
