import type { LoaderFunctionArgs } from "react-router";
import { devShop } from "../lib/devsign.server";
import { withTenant } from "../lib/tenant.server";

// DEV ONLY: renders the real theme-extension Liquid (Rating summary, Review widget, Product card stars embed) for a
// product of the local fictional dev shop, around a deliberately generic theme-like page. Metafields are simulated
// from the DB aggregates (what Proofly syncs to Shopify). /dev/preview[?handle=<product-handle>]
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop = await devShop();
  if (!shop) return new Response("Not found", { status: 404 });
  const handle = new URL(request.url).searchParams.get("handle");
  const [p, cards] = await withTenant(shop.id, ({ db, shopId }) => Promise.all([
    handle ? db.product.findFirst({ where: { shopId, handle } }) : db.product.findFirst({ where: { shopId }, orderBy: { reviewCount: "desc" } }),
    db.product.findMany({ where: { shopId }, orderBy: { title: "asc" }, take: 12 }),
  ]));
  if (!p) return new Response("Unknown handle", { status: 404 });

  // Lazy import: liquidjs is a devDependency and must never load in production.
  const { liquidProduct, renderBlock } = await import("../../scripts/lib/extension-liquid");
  const lp = (x: typeof p) => liquidProduct({ id: x.shopifyProductId, handle: x.handle, title: x.title, average: Number(x.averageRating), count: x.reviewCount });
  // Like a real collection page, Liquid only "sees" part of what is on screen: the first half of the grid. The other
  // cards (think "You may also like") exercise the embed's single batched request.
  const seen = cards.slice(0, Math.ceil(cards.length / 2));
  const [summary, widget, embed] = await Promise.all([
    renderBlock("rating-summary", { product: lp(p) }),
    renderBlock("reviews", { product: lp(p) }),
    renderBlock("card-ratings", { product: lp(p), collection: { products: seen.map(lp) }, search: { performed: false } }),
  ]);
  const grid = cards.map((c) => `<li class="card"><a href="/products/${encodeURIComponent(c.handle)}" class="media" tabindex="-1"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 4 3'/%3E" width="400" height="300" alt=""></a>
    <h3><a href="/products/${encodeURIComponent(c.handle)}">${esc(c.title)}</a></h3><p class="price">€29.00</p></li>`).join("");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proofly preview · ${esc(p.title)}</title>
<link rel="stylesheet" href="/dev/asset/proofly-stars.css"><link rel="stylesheet" href="/dev/asset/proofly.css">
<style>body{margin:0;font-family:Georgia,serif;color:#222;background:#fff}header,footer{background:#1d2a33;color:#fff;padding:18px 24px}
header nav a{color:#fff;margin-right:16px}main{max-width:1200px;margin:0 auto;padding:0 16px}.pdp{display:grid;gap:16px;margin:24px 0}
.pdp .ph{aspect-ratio:4/3;background:#eceae6;border-radius:4px}.pdp h1{margin:0;font-size:30px}@media(min-width:750px){.pdp{grid-template-columns:1fr 1fr}}
.grid{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:16px}.card img{width:100%;height:auto;background:#eceae6;display:block}
.card h3{font-size:15px;margin:8px 0 2px}.card h3 a{color:inherit;text-decoration:none}.price{margin:4px 0;font-size:14px}
.dev-note{margin:12px 0;padding:8px 12px;background:#fffbe6;border:1px solid #f0e2a0;font:13px system-ui}</style></head>
<body><header><strong>Example Store</strong> <nav><a href="/products/${encodeURIComponent(p.handle)}">Header link to this product</a></nav></header>
<main><p class="dev-note">Local preview of the Proofly theme app extension (fictional dev shop). Not a real store.</p>
<div class="pdp"><div class="ph"></div><div><h1>${esc(p.title)}</h1>${summary}<p class="price">€29.00</p></div></div>
${widget}
<h2>You may also like</h2><ul class="grid">${grid}</ul></main>
<footer>Footer</footer>
${embed}
<script src="/dev/asset/proofly-reviews.js" defer></script><script src="/dev/asset/proofly-cards.js" defer></script>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
};
