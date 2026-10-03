import { devShop } from "../lib/devsign.server";
import { withTenant } from "../lib/tenant.server";

// DEV ONLY: index of the local preview — every product with its own published / imported counts.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const loader = async () => {
  const shop = await devShop();
  if (!shop) return new Response("Not found", { status: 404 });
  return withTenant(shop.id, async ({ db, shopId }) => {
  const products = await db.product.findMany({ where: { shopId }, orderBy: [{ reviewCount: "desc" }, { title: "asc" }], include: { _count: { select: { reviews: true } } } });
  const [total, published, pending, images] = await Promise.all([
    db.review.count({ where: { shopId } }), db.review.count({ where: { shopId, status: "published" } }),
    db.review.count({ where: { shopId, status: "pending" } }), db.reviewImage.count({ where: { shopId } }),
  ]);
  const rows = products.map((p) => `<tr><td><a href="/dev/preview?handle=${encodeURIComponent(p.handle)}">${esc(p.title)}</a></td>
    <td>${esc(p.status ?? "")}</td><td class="n">${p.reviewCount}</td><td class="n">${p._count.reviews}</td><td class="n">${Number(p.averageRating).toFixed(2)}</td></tr>`).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proofly · local preview</title><style>
body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#222}main{max-width:960px;margin:0 auto;padding:16px}
.note{padding:10px 14px;background:#fffbe6;border:1px solid #f0e2a0;border-radius:8px;font-size:13px}
.stats{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}.stats div{border:1px solid #e3e3e3;border-radius:10px;padding:10px 14px}.stats b{display:block;font-size:22px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #eee;font-size:14px}.n{text-align:right;font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto}a{color:#111}</style></head><body><main>
<p class="note">DEV ONLY — local preview. Not connected to Shopify. Production installation is not yet authorised.</p>
<h1>Proofly — local preview</h1>
<div class="stats"><div><b>${total}</b>reviews</div><div><b>${published}</b>published</div><div><b>${pending}</b><a href="/dev/moderation">pending →</a></div>
<div><b>${products.filter((p) => p._count.reviews > 0).length}</b>products with reviews</div><div><b>${images}</b>images</div></div>
<p><a href="/dev/moderation">Moderation (pending, flags, approve/reject/hide/restore/reply) →</a></p>
<div class="wrap"><table><thead><tr><th>Product</th><th>Status</th><th class="n">Published</th><th class="n">Imported</th><th class="n">Average</th></tr></thead>
<tbody>${rows}</tbody></table></div></main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  });
};
