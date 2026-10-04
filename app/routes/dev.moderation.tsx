import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { Prisma, ReviewStatus } from "@prisma/client";
import { devShop } from "../lib/devsign.server";
import { ACTIONS, moderate, saveReply, type ModerationActionName } from "../lib/moderation.server";
import { withTenant } from "../lib/tenant.server";

// DEV ONLY: local stand-in for the embedded admin's moderation screen (the real one only renders inside
// Shopify admin). Uses the same moderation functions; never calls Shopify (no metafield sync). 404 in production.

const STATUSES: ReviewStatus[] = ["pending", "published", "rejected", "hidden"];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop = await devShop();
  if (!shop) return new Response("Not found", { status: 404 });
  return withTenant(shop.id, async ({ db, shopId }) => {
  const sp = new URL(request.url).searchParams;
  const status = STATUSES.find((s) => s === sp.get("status"));
  const flag = sp.get("flag") ?? "";
  // Flags like duplicate_text_x8 are matched by prefix, so one link covers every duplicate count.
  const flagIds = flag
    ? (await db.$queryRaw<{ id: string }[]>`select id::text from reviews where shop_id = ${shopId}::uuid and exists (select 1 from unnest(flags) f where f = ${flag} or f like ${flag + "\\_x%"})`).map((r) => r.id)
    : null;
  const where: Prisma.ReviewWhereInput = {
    shopId,
    ...(status ? { status } : {}),
    ...(flagIds ? { id: { in: flagIds } } : {}),
    ...(!status && !flag ? { status: "pending" } : {}),
  };
  const [rows, counts, flagRows] = await Promise.all([
    db.review.findMany({ where, orderBy: { reviewDate: "desc" }, take: 50, include: { product: true, reply: true } }),
    db.review.groupBy({ by: ["status"], where: { shopId }, _count: { _all: true } }),
    db.$queryRaw<{ flag: string; n: bigint }[]>`select regexp_replace(unnest(flags), '_x[0-9]+$', '') as flag, count(*) as n from reviews where shop_id = ${shopId}::uuid group by 1 order by 2 desc`,
  ]);
  const count = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
  const link = (q: string, label: string) => `<a href="/dev/moderation?${q}">${esc(label)}</a>`;
  const card = (r: (typeof rows)[number]) => `
<article class="r">
  <header><b>${esc(r.product.title)}</b> <span class="st st-${r.status}">${r.status}</span>
    ${r.flags.map((f) => `<span class="fl">${esc(f)}</span>`).join("")}
    ${r.verifiedPurchase ? '<span class="vp">Verified</span>' : ""}</header>
  <p class="meta">${"★".repeat(r.rating)} · ${esc(r.reviewerName)} · ${r.reviewDate.toISOString().slice(0, 10)} · ${r.source}</p>
  ${r.title ? `<h3>${esc(r.title)}</h3>` : ""}<p class="body">${esc(r.body)}</p>
  <form method="post" class="acts"><input type="hidden" name="id" value="${r.id}">
    ${r.status !== "published" ? '<button name="intent" value="approve" class="pri">Approve</button>' : '<button name="intent" value="hide">Hide</button>'}
    ${r.status !== "rejected" ? '<button name="intent" value="reject" class="dan">Reject</button>' : ""}
    ${r.status === "rejected" || r.status === "hidden" ? '<button name="intent" value="restore">Restore to pending</button>' : ""}
    <a href="/dev/preview?handle=${encodeURIComponent(r.product.handle)}">View product preview →</a>
  </form>
  <form method="post" class="reply"><input type="hidden" name="id" value="${r.id}"><input type="hidden" name="intent" value="reply">
    <label>Public reply (shown as “Response from {store name}”, empty removes)<textarea name="reply" rows="2" maxlength="5000">${esc(r.reply?.reply ?? "")}</textarea></label>
    <button>Save reply</button></form>
</article>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moderation · dev preview</title><style>
body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#222;background:#f6f6f7}main{max-width:960px;margin:0 auto;padding:16px}
.note{padding:10px 14px;background:#fffbe6;border:1px solid #f0e2a0;border-radius:8px;font-size:13px}
nav{display:flex;flex-wrap:wrap;gap:8px 16px;margin:16px 0}nav a{color:#111}.r{background:#fff;border:1px solid #e3e3e3;border-radius:12px;padding:16px;margin:12px 0}
.r header{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.meta{color:#666;margin:6px 0}.r h3{margin:8px 0 4px;font-size:16px}.body{white-space:pre-line;margin:0 0 12px}
.st,.fl,.vp{font-size:12px;padding:2px 8px;border-radius:99px;background:#eee}.st-pending{background:#fff1c2}.st-published{background:#d7f5e0}.st-rejected{background:#fde2e1}.fl{background:#ffe4cc}.vp{background:#d7f5e0}
.acts,.reply{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}.reply label{flex:1 1 100%;display:grid;gap:4px;font-size:13px;color:#555}
textarea{font:inherit;padding:8px;border:1px solid #ccc;border-radius:8px}button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #bbb;background:#fff;cursor:pointer;min-height:40px}
.pri{background:#111;color:#fff;border-color:#111}.dan{color:#b42318;border-color:#e3a19b}</style></head><body><main>
<p class="note">DEV ONLY — local moderation preview against the local database. Approving or hiding changes local storefront counts immediately. Nothing is sent to Shopify.</p>
<h1>Moderation</h1>
<nav>${STATUSES.map((s) => link(`status=${s}`, `${s} (${count(s)})`)).join("")}</nav>
<nav>Flags: ${flagRows.map((f) => link(`flag=${encodeURIComponent(f.flag)}`, `${f.flag} (${f.n})`)).join("")}</nav>
<p>${rows.length} shown${rows.length === 50 ? " (first 50)" : ""}.</p>
${rows.map(card).join("") || "<p>Nothing here.</p>"}
<p><a href="/dev">← All products</a></p></main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const shop = await devShop();
  if (!shop) return new Response("Not found", { status: 404 });
  const form = await request.formData();
  const id = String(form.get("id") ?? "");
  const intent = String(form.get("intent") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Bad id", { status: 400 });
  await withTenant(shop.id, async (t) => {
    if (intent === "reply") await saveReply(t, id, String(form.get("reply") ?? ""), "dev-preview");
    else if (intent in ACTIONS) await moderate(t, [id], intent as ModerationActionName, "dev-preview"); // no Shopify writes
  });
  return new Response(null, { status: 303, headers: { Location: request.headers.get("referer") ?? "/dev/moderation" } });
};
