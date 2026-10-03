import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LoaderFunctionArgs } from "react-router";
import type { TagToken, TopLevelToken, Liquid as L } from "liquidjs";
import { devShop } from "../lib/devsign.server";
import { withTenant } from "../lib/tenant.server";

// DEV ONLY: renders the real theme-extension Liquid (blocks/reviews.liquid) for a product from the local
// DB, plus a product-card grid using the Proofly card-rating hook. /dev/preview[?handle=<product-handle>]

const EXT = path.resolve("extensions/proofly");


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop = await devShop();
  if (!shop) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const handle = url.searchParams.get("handle");
  // No default product: without ?handle= the product with the most reviews in the local database is shown.
  const [p, cards] = await withTenant(shop.id, ({ db, shopId }) => Promise.all([
    handle ? db.product.findFirst({ where: { shopId, handle } }) : db.product.findFirst({ where: { shopId }, orderBy: { reviewCount: "desc" } }),
    db.product.findMany({ where: { shopId }, orderBy: { reviewCount: "desc" }, take: 8 }),
  ]));
  if (!p) return new Response("Unknown handle", { status: 404 });

  // liquidjs is a devDependency: import lazily so production builds never load it.
  const { Liquid, Tag } = await import("liquidjs");
  class SchemaTag extends Tag { // {% schema %}…{% endschema %} renders nothing
    constructor(token: TagToken, remain: TopLevelToken[], liquid: L) {
      super(token, remain, liquid);
      while (remain.length) { const t = remain.shift() as TagToken; if (t.name === "endschema") return; }
    }
    *render() {}
  }
  const engine = new Liquid();
  engine.registerTag("schema", SchemaTag);
  engine.registerFilter("image_url", (v: string) => (v ?? "").replace(/^https?:/, "")); // Shopify returns protocol-relative URLs
  const tpl = await readFile(path.join(EXT, "blocks/reviews.liquid"), "utf8");
  const customer = url.searchParams.get("customer") ? { first_name: "Jordan", last_name: "Smith", email: "jordan@example.com" } : null;
  const block = await engine.parseAndRender(tpl, {
    product: {
      id: p.shopifyProductId.toString(), title: p.title, url: `/products/${p.handle}`, featured_image: p.image,
      metafields: { reviews: { rating_count: { value: p.reviewCount }, rating: { value: { rating: Number(p.averageRating) } } } },
    },
    block: { settings: { heading: "Customer Reviews", json_ld: true }, shopify_attributes: "" },
    customer,
    request: { origin: "https://proofly-dev.myshopify.com" },
    shop: { name: "Proofly Dev Store" },
    routes: { account_login_url: "/account/login" },
  });

  const grid = [...cards.map((c) => ({ id: c.shopifyProductId.toString(), title: c.title })), { id: "9999999999999", title: "Product with no reviews" }]
    .map((c) => `<div class="card"><div class="ph"></div><h4>${c.title.replace(/</g, "&lt;")}</h4>
      <span data-pf-rating data-product-id="${c.id}"></span></div>`)
    .join("");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reviews preview · ${p.title.replace(/</g, "&lt;")}</title>
<link rel="stylesheet" href="/dev/asset/proofly.css">
<style>body{margin:0;font-family:system-ui,sans-serif;background:#fff}header{background:#111;color:#fff;padding:18px 24px;font-weight:800;letter-spacing:.04em}
.pdp{max-width:1200px;margin:24px auto;padding:0 16px;display:grid;gap:8px}.pdp h1{margin:0;font-size:32px}
.grid{max-width:1200px;margin:24px auto;padding:0 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px}
.card{border:1px solid #eee;border-radius:12px;padding:12px}.card .ph{aspect-ratio:4/3;background:#f2f2f2;border-radius:8px}.card h4{font-size:14px;margin:10px 0 6px}
.dev-note{max-width:1200px;margin:16px auto;padding:10px 16px;background:#fffbe6;border:1px solid #f0e2a0;border-radius:8px;font:13px system-ui}</style></head>
<body><header>PROOFLY · DEV PREVIEW</header>
<p class="dev-note">Local preview of the theme-extension Liquid + JS against the local database. Not the live store.</p>
<div class="pdp"><h1>${p.title.replace(/</g, "&lt;")}</h1><div><span data-pf-rating data-product-id="${p.shopifyProductId}"></span></div></div>
<h2 style="max-width:1200px;margin:32px auto 0;padding:0 16px">Collection cards</h2><div class="grid">${grid}</div>
${block}
<script src="/dev/asset/proofly-ratings.js" defer></script><script src="/dev/asset/proofly-reviews.js" defer></script>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
};
