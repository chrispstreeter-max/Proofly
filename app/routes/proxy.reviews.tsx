import type { ActionFunctionArgs } from "react-router";
import { clientIp, ipHash, json, originAllowed, rateLimit } from "../lib/http.server";
import { requireProxyTenant } from "../lib/proxy.server";
import { parseIds } from "../lib/reviews.server";
import { SubmitError, createReview, ensureProduct, parseSubmission } from "../lib/submit.server";
import { withTenant } from "../lib/tenant.server";

// POST <proxy path>/reviews (multipart) — "Write a Review" on the product page. The shop's settings are enforced here
// (submissions on/off, photos on/off, approval required) whatever the theme shows.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
  const { admin, shop } = await requireProxyTenant(request);
  const ip = clientIp(request);
  try {
    if (!originAllowed(request, shop)) throw new SubmitError("form", "Submission rejected.", 403);
    if (Number(request.headers.get("content-length") ?? 0) > 52 * 1024 * 1024) throw new SubmitError("images", "Photos are too large.", 413);
    const settings = await withTenant(shop.id, ({ db, shopId }) => db.shopSettings.findUnique({ where: { shopId } }));
    if (settings && !settings.reviewSubmissionEnabled) throw new SubmitError("form", "This store isn't accepting new reviews right now.", 403);
    if (!(await rateLimit(`submit:${shop.id}:${ip}`, 5, 3_600_000))) throw new SubmitError("form", "Too many reviews from this connection. Try again later.", 429);

    const form = await request.formData();
    const [shopifyProductId] = parseIds(String(form.get("product_id") ?? ""), 1);
    if (!shopifyProductId) throw new SubmitError("product", "Product not found.", 404);
    const data = await parseSubmission(form);
    if (data.images.length && settings && !settings.photoReviewsEnabled) throw new SubmitError("images", "Photos aren't accepted with reviews on this store.");
    // No customer identity is stored: logged_in_customer_id is ignored (V1 has no customer/order scopes).

    await withTenant(shop.id, async (t) => {
      const product = await ensureProduct(t, admin, shopifyProductId);
      await createReview(t, { productId: product.id, data, source: "storefront", ipHash: ipHash(ip) });
    });
    return json({ ok: true }, { status: 201 });
  } catch (e) {
    if (e instanceof SubmitError) return json({ ok: false, field: e.field, error: e.message }, { status: e.status });
    console.error("review submit failed", e);
    return json({ ok: false, field: "form", error: "Something went wrong. Please try again." }, { status: 500 });
  }
};
