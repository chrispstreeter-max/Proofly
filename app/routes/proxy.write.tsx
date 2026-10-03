import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { clientIp, ipHash, originAllowed, rateLimit } from "../lib/http.server";
import { parseIds } from "../lib/reviews.server";
import { SubmitError, createReview, ensureProduct, openRequests, parseSubmission } from "../lib/submit.server";

// /apps/proofly/write?t=TOKEN — secure link from a review-request email. Order → choose product → review.
// Rendered as Liquid inside the store theme. Reviews created here are verified purchases.

const esc = (s: string) =>
  s.replace(/[&<>"'{}%]/g, (c) => `&#${c.charCodeAt(0)};`); // HTML-escape + neutralise Liquid delimiters

async function page(liquid: (b: string, o?: ResponseInit) => Response, token: string, notice = "", status = 200) {
  const error = status >= 400;
  const open = token ? await openRequests(token) : [];
  const products = open.length
    ? await prisma.product.findMany({ where: { shopifyProductId: { in: open.map((r) => r.shopifyProductId) } } })
    : [];
  const items = open.map((r) => {
    const p = products.find((x) => x.shopifyProductId === r.shopifyProductId);
    const title = esc(p?.title ?? "Your product");
    const img = p?.image ? `<img src="${esc(p.image)}${p.image.includes("?") ? "&" : "?"}width=160" alt="" width="80" height="80" loading="lazy">` : "";
    return `<details class="pfw-item"><summary>${img}<span>${title}</span><b>Write a review</b></summary>
<form method="post" enctype="multipart/form-data" class="pfw-form">
<input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="product_id" value="${r.shopifyProductId}">
<input type="text" name="website" tabindex="-1" autocomplete="off" class="pfw-hp" aria-hidden="true">
<fieldset class="pfw-stars"><legend>Your rating</legend>${[5, 4, 3, 2, 1]
      .map((n) => `<input type="radio" id="r${r.id}-${n}" name="rating" value="${n}" required><label for="r${r.id}-${n}" title="${n} star${n > 1 ? "s" : ""}">★</label>`)
      .join("")}</fieldset>
<label>Review title <input name="title" maxlength="120"></label>
<label>Your review <textarea name="body" required maxlength="5000" rows="5"></textarea></label>
<label>Name shown with your review <input name="name" required maxlength="60"></label>
<label>Photos (optional, up to 5) <input type="file" name="images" accept="image/jpeg,image/png,image/webp" multiple></label>
<button type="submit">Submit review</button></form></details>`;
  });
  const body = `<div class="pfw">
<h1>Review your order</h1>
${notice ? `<p class="pfw-notice${error ? " pfw-error" : ""}" role="${error ? "alert" : "status"}">${esc(notice)}</p>` : ""}
${items.length ? `<p>Choose a product to review. Reviews are checked before they appear on the site.</p>${items.join("")}`
    : `<p>${token ? "Thanks — there's nothing left to review on this link, or it has expired." : "This review link is not valid."}</p>`}
</div>
<style>
.pfw{max-width:720px;margin:40px auto;padding:0 16px}.pfw h1{margin-bottom:12px}
.pfw-notice{padding:12px 16px;border-radius:8px;background:#ecfdf3;color:#05603a}.pfw-error{background:#fef3f2;color:#b42318}
.pfw-item{border:1px solid #e5e5e5;border-radius:12px;margin:12px 0;overflow:hidden}
.pfw-item summary{display:flex;gap:16px;align-items:center;padding:12px 16px;cursor:pointer;list-style:none}
.pfw-item summary img{border-radius:8px;object-fit:cover}.pfw-item summary span{flex:1;font-weight:600}
.pfw-form{display:grid;gap:12px;padding:0 16px 16px}.pfw-form label{display:grid;gap:4px;font-size:14px}
.pfw-form input:not([type=radio]),.pfw-form textarea{padding:10px;border:1px solid #ccc;border-radius:8px;font:inherit}
.pfw-form button{padding:12px;border:0;border-radius:8px;background:#111;color:#fff;font-weight:600;cursor:pointer}
.pfw-hp{position:absolute;left:-9999px}
.pfw-stars{border:0;padding:0;display:flex;flex-direction:row-reverse;justify-content:flex-end;gap:4px}
.pfw-stars legend{font-size:14px;margin-bottom:4px}.pfw-stars input{position:absolute;opacity:0}
.pfw-stars label{font-size:32px;color:#d4d4d4;cursor:pointer;line-height:1}
.pfw-stars input:checked~label,.pfw-stars label:hover,.pfw-stars label:hover~label{color:#f5a400}
.pfw-stars input:focus-visible+label{outline:2px solid #111;border-radius:4px}
</style>`;
  return liquid(body, { status, headers: { "Cache-Control": "no-store" } });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { liquid } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  if (!rateLimit(`write:${clientIp(request)}`, 60, 60_000)) return liquid("<p>Too many requests.</p>", { status: 429 });
  return page(liquid, url.searchParams.get("t") ?? "", url.searchParams.get("done") ? "Thank you! Your review has been submitted." : "");
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, liquid } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const ip = clientIp(request);
  const form = await request.formData();
  const token = String(form.get("t") ?? "");
  try {
    if (!originAllowed(request, url.searchParams.get("shop"))) throw new SubmitError("form", "Submission rejected.", 403);
    if (!rateLimit(`submit:${ip}`, 10, 3_600_000)) throw new SubmitError("form", "Too many submissions. Try again later.", 429);
    const [productId] = parseIds(String(form.get("product_id") ?? ""), 1);
    const req = (await openRequests(token)).find((r) => r.shopifyProductId === productId);
    if (!productId || !req) throw new SubmitError("form", "This review link has expired or was already used.", 410);
    const data = await parseSubmission(form);
    await ensureProduct(admin, productId);
    await createReview({
      productId, data, verified: true, source: "request", requestId: req.id,
      customerId: req.shopifyCustomerId, orderId: req.shopifyOrderId, ipHash: ipHash(ip),
    });
    // Post/redirect/get back through the proxy path (relative, stays on the shop domain).
    return new Response(null, { status: 303, headers: { Location: `/apps/proofly/write?t=${encodeURIComponent(token)}&done=1` } });
  } catch (e) {
    if (e instanceof SubmitError) return page(liquid, token, e.message, e.status);
    console.error("token review submit failed", e);
    return page(liquid, token, "Something went wrong. Please try again.", 500);
  }
};
