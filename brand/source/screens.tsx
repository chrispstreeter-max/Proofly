/**
 * App Store screenshots (1600 × 900) rendered from Proofly's real UI: the real admin page components with their real
 * loader data (demo catalogue + the reviewer sample CSV imported through the real import engine, in the LOCAL test
 * database), Shopify's Polaris web components, and the storefront widget rendered from its real Liquid, CSS and JS.
 *
 *   npx tsx --env-file=.env.test --import ./tests/no-network.ts brand/source/screens.tsx
 *
 * Wipes the local test database (like the test suite). Output: brand/app-store/proofly-screenshot-*.png
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Liquid } from "liquidjs";
import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import prisma from "../../app/db.server";
import { aggregateOf, publicReviewsOf } from "../../app/lib/aggregates.server";
import { createImport, runImport, skuLookupFromAdmin } from "../../app/lib/import.server";
import { buildProjection } from "../../app/lib/projection.server";
import { ensureReviewDefinition } from "../../app/lib/review-store.server";
import { registerShop, withTenant } from "../../app/lib/tenant.server";
import ImportDetail, { loader as importLoader } from "../../app/routes/app.imports.$id";
import Reviews, { loader as reviewsLoader } from "../../app/routes/app.reviews._index";
import { adminRequest, apiOf, args, owner, resetDb, run, seedReview, storeOf, storeOfflineSession } from "../../tests/helpers";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "brand", "app-store");
const TMP = path.join(ROOT, "brand", "source", ".screens");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DOMAIN = "proofly-test-demo.myshopify.com"; // fictional (merchant-data scan)

const catalogue = JSON.parse(readFileSync("docs/app-store/demo-catalogue.json", "utf8")).products as { handle: string; title: string; sku: string }[];
// The reviewer sample CSV is kept as text in docs/APP-STORE.md §6 (the repository tracks no CSV files).
const SAMPLE = Buffer.from(/## 6\. Reviewer sample CSV[\s\S]*?```csv\n([\s\S]*?)```/.exec(readFileSync("docs/APP-STORE.md", "utf8"))![1]);

async function demoStore() {
  await resetDb();
  storeOf(DOMAIN).identity = { myshopifyDomain: DOMAIN, id: 9_500_000_000_001n, name: "Proofly Demo", host: "proofly-demo.example.com" };
  const shop = await registerShop({ shopDomain: DOMAIN, shopifyShopId: 9_500_000_000_001n, shopName: "Proofly Demo", storefrontHosts: [] });
  await storeOfflineSession(DOMAIN, "Demo");
  const api = apiOf(DOMAIN, shop.id);
  await ensureReviewDefinition(api);
  const ids = new Map<string, bigint>();
  await withTenant(shop.id, async ({ db, shopId }) => {
    for (const [i, p] of catalogue.entries()) {
      const id = 9_600_000_000_100n + BigInt(i);
      ids.set(p.handle, id);
      await db.product.create({ data: { shopId, shopifyProductId: id, handle: p.handle, title: p.title } });
      storeOf(DOMAIN).skus.set(p.sku, [id]);
    }
  });
  return { shop, api, ids };
}

/** Synthetic extra reviews (fictional names) so the mug shows a realistic spread. */
const EXTRA = [
  { rating: 5, title: "Perfect weight", body: "Sits nicely in the hand and the handle doesn't get hot.", reviewerName: "Priya S.", date: "2025-07-02" },
  { rating: 5, title: "Bought a second one", body: "Use it every morning. Went back for another in the same glaze.", reviewerName: "Tom W.", date: "2025-07-19" },
  { rating: 4, title: "Great everyday mug", body: "Lovely finish. A little smaller than my old mugs but holds a full cup.", reviewerName: "Hana K.", date: "2025-08-03" },
  { rating: 5, title: "Dishwasher safe", body: "Six months of daily use and the glaze still looks new.", reviewerName: "Leo M.", date: "2025-08-21" },
];

function render(Component: () => JSX.Element, routePath: string, data: unknown) {
  return async (url: string) => {
    const routes = [{ id: "page", path: routePath, loader: () => data, Component }];
    const handler = createStaticHandler(routes);
    const context = await handler.query(new Request(`https://app.example${url}`));
    if (context instanceof Response) throw new Error("unexpected response");
    return renderToString(<StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} hydrate={false} />);
  };
}

// The app's own page only: no imitation of Shopify's admin chrome.
const adminPage = (body: string) => `<!doctype html><html><head><meta charset="utf-8">
<script src="https://cdn.shopify.com/shopifycloud/polaris.js"></script>
<style>html,body{margin:0;background:#f1f1f1;font-family:-apple-system,BlinkMacSystemFont,"San Francisco","Segoe UI",Roboto,sans-serif}
.main{padding:24px 32px 0;max-width:1300px;margin:0 auto}</style></head>
<body><div class="main">${body}</div></body></html>`;

async function storefront(projection: unknown, a: { count: number; average: number }) {
  const liquid = new Liquid();
  liquid.registerFilter("image_url", (v: string) => v);
  const tpl = readFileSync("extensions/proofly/blocks/reviews.liquid", "utf8").replace(/{% schema %}[\s\S]*{% endschema %}/, "");
  const html = await liquid.parseAndRender(tpl, {
    product: { id: 9_600_000_000_100, title: "Stoneware Mug", url: "/products/demo-stoneware-mug",
      metafields: { reviews: { rating_count: { value: a.count }, rating: { value: { rating: a.average } } }, "$app:proofly": { reviews: { value: projection } } } },
    app: { metafields: { proofly: { proxy_path: { value: "" }, storefront: { value: { submissions: true } } } } },
    block: { settings: { heading: "Customer reviews", allow_submissions: true, json_ld: false }, shopify_attributes: "" },
    shop: { name: "Proofly Demo" }, routes: { root_url: "/" }, request: { origin: "https://proofly-demo.example.com" },
  });
  // A plain store page with the widget at full width (its wide layout + the review list); no product mock-up.
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.resolve("extensions/proofly/assets/proofly.css"))}">
<style>html,body{margin:0;background:#fff;font-family:"Helvetica Neue",Arial,sans-serif;color:#121212}
header{height:64px;border-bottom:1px solid #eee;display:flex;align-items:center;justify-content:center;font-weight:700;letter-spacing:.08em;font-size:15px}
.crumb{max-width:1200px;margin:22px auto 0;padding:0 24px;color:#666;font-size:14px}.crumb b{color:#121212;font-weight:600}
.pf{margin-top:8px}</style></head>
<body><header>PROOFLY DEMO</header><div class="crumb">Home / Kitchen / <b>Stoneware Mug</b> &nbsp;·&nbsp; $18.00</div>${html}
<script src="${pathToFileURL(path.resolve("extensions/proofly/assets/proofly-reviews.js"))}"></script></body></html>`;
}

function shoot(name: string, html: string, scrollY = 0) {
  const file = path.join(TMP, `${name}.html`);
  writeFileSync(file, scrollY ? html.replace("</body>", `<script>addEventListener("load",()=>setTimeout(()=>scrollTo(0,${scrollY}),300))</script></body>`) : html);
  const out = path.join(OUT, `${name}.png`);
  execFileSync(CHROME, ["--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1", "--allow-file-access-from-files",
    "--window-size=1600,900", "--virtual-time-budget=8000", `--screenshot=${out}`, pathToFileURL(file).href], { stdio: "ignore" });
  console.log("wrote", path.relative(ROOT, out));
}

async function main() {
  mkdirSync(TMP, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(TMP, "mark.png"), readFileSync("brand/source/mark-trim.png"));
  const { shop, api, ids } = await demoStore();

  // Growth plan: replies are public, as a paying merchant sees them.
  await owner.billingState.update({ where: { shopId: shop.id }, data: { plan: "GROWTH", verification: "confirmed" } });
  // 1. Import: the reviewer sample CSV through the real import engine.
  const { jobId } = await createImport(shop.id, { csv: SAMPLE, options: { publishMode: "publish" }, actor: "demo", skuLookup: skuLookupFromAdmin(storeOf(DOMAIN).graphql) });
  await runImport(api, jobId);
  const mug = ids.get("demo-stoneware-mug")!;
  for (const r of EXTRA) await seedReview(api, { productId: mug, source: "storefront", rating: r.rating, title: r.title, body: r.body, reviewerName: r.reviewerName, reviewDate: new Date(`${r.date}T10:00:00Z`), status: "published", held: false });
  await seedReview(api, { productId: ids.get("demo-linen-tote")!, source: "storefront", rating: 4, title: "Roomy", body: "Fits everything for a day out. Pending check.", reviewerName: "Noor A.", reviewDate: new Date("2025-08-25T10:00:00Z"), status: "pending", held: false });

  const imp = await run(() => importLoader(args(adminRequest(DOMAIN, `/app/imports/${jobId}`), { id: jobId })));
  shoot("proofly-screenshot-1-import", adminPage(await render(ImportDetail, "/app/imports/:id", imp.data)(`/app/imports/${jobId}`)));

  // 2. Reviews: moderation list.
  const rev = await run(() => reviewsLoader(args(adminRequest(DOMAIN, "/app/reviews"))));
  shoot("proofly-screenshot-2-reviews", adminPage(await render(Reviews, "/app/reviews", rev.data)("/app/reviews")));

  // 3. Storefront: the widget on the mug, from the projection Proofly publishes.
  const reviews = await publicReviewsOf(api, mug);
  const a = aggregateOf(reviews);
  const projection = buildProjection(reviews, a, { replies: true });
  shoot("proofly-screenshot-3-storefront", await storefront(projection, { count: a.reviewCount, average: a.averageRating }));

  if (!process.env.KEEP) rmSync(TMP, { recursive: true, force: true });
  await prisma.$disconnect(); await owner.$disconnect();
}

main().catch(async (e) => { console.error(e); process.exitCode = 1; await prisma.$disconnect(); await owner.$disconnect(); });
