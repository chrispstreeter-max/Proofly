// Checkpoint 3: Shopify-native storefront + theme app extension.
// Extension build/structure/budgets, generic-merchant Liquid rendering, public visibility (published-only,
// plan-limited), no photos anywhere, rating maths + the metafield cache, card ratings, isolation, privacy.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { after, before, describe, test } from "node:test";
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import { recomputeProduct } from "../app/lib/aggregates.server";
import { syncRatingCache } from "../app/lib/rating-cache.server";
import { markUninstalled, withTenant } from "../app/lib/tenant.server";
import { parseHandles } from "../app/lib/reviews.server";
import { updateReview, type ReviewInput } from "../app/lib/review-store.server";
import { loader as proxyList } from "../app/routes/proxy.products.$id.reviews";
import { loader as proxyRatings } from "../app/routes/proxy.ratings";
import { blockSchema, EXTENSION_DIR, liquidProduct, renderBlock } from "../scripts/lib/extension-liquid";
import { args, DOMAIN_A, DOMAIN_B, DOMAIN_C, FakeShopify, installMerchant, owner, proxyRequest, resetDb, reviewsIn, run, SAME_HANDLE, seedReview, storeOf, type Merchant } from "./helpers";

const ext = (...p: string[]) => path.join(EXTENSION_DIR, ...p);
const files = (dir: string) => readdirSync(ext(dir)).map((f) => path.join(dir, f));
const BLOCKS = ["reviews", "rating-summary", "card-ratings"];

describe("Theme app extension build", () => {
  test("Shopify Theme Check (theme-app-extension rules, fail on any suggestion) reports no offences", () => {
    const r = spawnSync("npx", ["--no-install", "shopify", "theme", "check", "--path", EXTENSION_DIR, "-C", "theme-check:theme-app-extension", "--fail-level", "suggestion", "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.slice(r.stdout.indexOf("["))), []);
  });

  // Real-Shopify finding (deploy, 2026-10-04): Shopify's Liquid lexer ends a tag at the first "}" — even inside a quoted
  // string — so `{{ '}' }}` is rejected at deploy although liquidjs and Theme Check accept it.
  test("Liquid tags contain no braces (Shopify's strict lexer rejects them, unlike liquidjs/Theme Check)", () => {
    for (const f of files("blocks")) {
      const src = readFileSync(ext(f), "utf8").replace(/\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/, "");
      for (const m of src.matchAll(/\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}/g)) {
        assert.doesNotMatch(m[1] ?? m[2], /[{}]/, `${path.basename(f)}: ${m[0]}`);
      }
    }
  });

  test("structure: one theme extension, three blocks with valid schemas, every referenced asset exists and is used", () => {
    assert.match(readFileSync(ext("shopify.extension.toml"), "utf8"), /^type = "theme"$/m);
    assert.deepEqual(readdirSync(EXTENSION_DIR).sort(), ["assets", "blocks", "locales", "shopify.extension.toml"]);
    assert.deepEqual(files("blocks").map((f) => path.basename(f, ".liquid")).sort(), [...BLOCKS].sort());
    const used = new Set<string>();
    for (const b of BLOCKS) {
      const s = blockSchema(b);
      for (const a of [s.javascript, s.stylesheet].filter(Boolean) as string[]) { used.add(a); assert.ok(readdirSync(ext("assets")).includes(a), `${b} → ${a}`); }
      if (b === "card-ratings") assert.equal(s.target, "body"); // the only app embed
      else assert.equal(s.target, "section");
    }
    assert.deepEqual(blockSchema("reviews").enabled_on, { templates: ["product"] });
    // Level 2 of the card hierarchy: placeable in any section that offers app blocks, product filled in by Shopify.
    assert.equal(blockSchema("rating-summary").enabled_on, undefined);
    assert.ok(blockSchema("rating-summary").settings.some((x) => x.type === "product" && (x as { autofill?: boolean }).autofill === true));
    assert.deepEqual([...used].sort(), readdirSync(ext("assets")).sort());
    assert.equal(blockSchema("rating-summary").javascript, undefined); // rating summary ships no JavaScript
  });

  // Real-Shopify finding (Proofly Test, 2026-10-04): `.pf-more { display: block }` beat the browser's [hidden] rule, so
  // "Show more reviews" showed with nothing more to load.
  test("anything the widget hides with the hidden attribute stays hidden (no display rule overrides it)", () => {
    const css = readFileSync(ext("assets/proofly.css"), "utf8");
    assert.match(css, /\.pf \[hidden\] \{ display: none; \}/);
    const general = css.indexOf(".pf [hidden]");
    for (const m of css.matchAll(/^([^{}\n]*\[hidden\][^{}\n]*)\{/gm)) assert.equal(m.index, general, `narrower [hidden] rule: ${m[1]}`);
  });

  test("budgets: storefront JS < 10 KB gzipped in total, Liquid within Shopify's 100 KB extension limit", () => {
    const gz = (f: string) => gzipSync(readFileSync(ext(f)), { level: 9 }).length;
    const js = files("assets").filter((f) => f.endsWith(".js"));
    assert.ok(js.reduce((n, f) => n + gz(f), 0) < 10 * 1024);
    for (const f of js) assert.ok(readFileSync(ext(f)).length < 10_000, `${f} raw`); // Shopify app-block JS guideline
    assert.ok(files("blocks").reduce((n, f) => n + readFileSync(ext(f)).length, 0) < 100 * 1024);
  });

  test("no theme files, no framework/jQuery, no polling, no third-party requests, no HTML injection, nothing merchant-specific", () => {
    for (const f of files("blocks")) {
      const src = readFileSync(ext(f), "utf8");
      assert.doesNotMatch(src, /{%-?\s*(render|include|section|sections|layout|content_for)\b/, `${f} must not depend on theme files`);
      assert.doesNotMatch(src, /https?:\/\/(?!schema\.org|www\.w3\.org)/, `${f} hard-coded URL`);
    }
    for (const f of files("assets").filter((x) => x.endsWith(".js"))) {
      const src = readFileSync(ext(f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // code only, not comments
      assert.doesNotMatch(src, /jQuery|\$\.\w|\bReact\b|\bVue\b|preact|import\s/, `${f} framework`);
      assert.doesNotMatch(src, /setInterval|setTimeout\([^)]*,\s*\d/, `${f} polling`);
      assert.doesNotMatch(src, /https?:\/\//, `${f} absolute URL`);
      assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/, `${f} HTML injection`);
    }
    // No shop domains or theme-specific hooks; merchant names/handles/review text are covered by the merchant-data scan
    // (test 10), which scans these extension files with the hashed denylists.
    const all = [...files("blocks"), ...files("assets")].map((f) => readFileSync(ext(f), "utf8")).join("\n");
    assert.doesNotMatch(all, /\.myshopify\.com|data-pf-rating|data-product-id="[^{]/);
  });
});

describe("Generic merchant rendering (Liquid)", () => {
  const product = (average: number, count: number) => liquidProduct({ id: 7001, handle: "example-product", title: "Example Product", average, count });

  test("review widget: average, stars, count, list container, JSON-LD; no email field or verified-purchase prompt", async () => {
    const html = await renderBlock("reviews", { product: product(4.33, 3) });
    assert.match(html, /<span class="pf-avg">4\.3<\/span>/);
    assert.match(html, /--p:86\.6%/);
    assert.match(html, /Based on 3 reviews/);
    assert.match(html, /data-api="\/apps\/proofly"/);
    assert.match(html, /data-list/);
    assert.match(html, /data-sort/);
    assert.doesNotMatch(html, /name="email"|Verified Purchase|Log in/);
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]);
    assert.equal(ld.aggregateRating.ratingValue, 4.33);
    assert.equal(ld.aggregateRating.reviewCount, 3);
  });

  test("review widget: whole-number averages, singular count, locale-prefixed proxy path", async () => {
    assert.match(await renderBlock("reviews", { product: product(5, 1) }), /pf-avg">5\.0<[\s\S]*Based on 1 review</);
    const fr = await renderBlock("reviews", { product: product(1, 2), routes: { root_url: "/fr" } });
    assert.match(fr, /pf-avg">1\.0</);
    assert.match(fr, /data-api="\/fr\/apps\/proofly"/);
  });

  test("review widget empty state: message + write button, no list, no request target, no JSON-LD", async () => {
    const html = await renderBlock("reviews", { product: product(0, 0) });
    assert.match(html, /No reviews yet/);
    assert.match(html, /data-write/);
    assert.doesNotMatch(html, /data-list|ld\+json|pf-avg/);
    const noForm = await renderBlock("reviews", { product: product(0, 0) }, { allow_submissions: false });
    assert.doesNotMatch(noForm, /data-write|<form/);
  });

  test("rating summary: stars + average + count with an accessible label; hidden (or 'No reviews yet') when empty", async () => {
    const html = await renderBlock("rating-summary", { product: product(4.33, 3) });
    assert.match(html, /aria-label="Rated 4\.3 out of 5 from 3 reviews"/);
    assert.match(html, /--p:86\.6%/);
    assert.match(html, /\(3 reviews\)/);
    assert.match(await renderBlock("rating-summary", { product: product(4, 1) }), /\(1 review\)/);
    assert.doesNotMatch(await renderBlock("rating-summary", { product: product(4.33, 3) }, { show_average: false }), /pf-summary-avg/);
    assert.equal((await renderBlock("rating-summary", { product: product(0, 0) })).trim(), "");
    assert.match(await renderBlock("rating-summary", { product: product(0, 0) }, { show_empty: true }), /No reviews yet/);
  });

  test("card embed: ratings for the products Liquid can see, from metafields, as inert JSON (no request needed)", async () => {
    const html = await renderBlock("card-ratings", {
      product: null,
      collection: { products: [
        liquidProduct({ id: 1, handle: "red-scarf", title: "Red scarf", average: 4.67, count: 3 }),
        liquidProduct({ id: 2, handle: "blue-hat", title: "Blue hat", average: 0, count: 0 }),
      ] },
      search: { performed: true, results: [
        liquidProduct({ id: 3, handle: "grey-sock", title: "Grey sock", average: 5, count: 12 }),
        { object_type: "article", handle: "a-blog-post", metafields: {} },
      ] },
    }, { title_selector: `"><script>alert(1)</script>` });
    const script = /<script type="application\/json" id="pf-cards"([^>]*)>([\s\S]*?)<\/script>/.exec(html)!;
    assert.deepEqual(JSON.parse(script[2]), { "red-scarf": [4.67, 3], "blue-hat": [0, 0], "grey-sock": [5, 12] });
    assert.match(script[1], /data-api="\/apps\/proofly"/);
    assert.match(script[1], /data-selector="(&quot;|&#34;)&gt;&lt;script&gt;/); // merchant setting is escaped
    const empty = /id="pf-cards"[^>]*>([\s\S]*?)<\/script>/.exec(await renderBlock("card-ratings", { product: null, collection: null, search: { performed: false } }))!;
    assert.deepEqual(JSON.parse(empty[1]), {});
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Data: one product per shop with every review state. A and B share Shopify product id AND handle; C never installs.
const VIS_ID = 9_000_000_000_123n;
const VIS_HANDLE = "visibility-product";
const PAGED_ID = 9_000_000_000_124n;
const PRIVATE = { flags: ["spam_suspected"], source: "csv" };
let A: Merchant, B: Merchant;

async function seedVisibility(m: Merchant, label: string) {
  await withTenant(m.shopId, async ({ db, shopId }) => {
    await db.product.create({ data: { shopId, shopifyProductId: VIS_ID, handle: VIS_HANDLE, title: `Visibility ${label}` } });
    await db.product.create({ data: { shopId, shopifyProductId: 9_000_000_000_125n, handle: "zero-product", title: "Zero" } });
    await db.product.create({ data: { shopId, shopifyProductId: PAGED_ID, handle: "paged-product", title: "Paged" } });
  });
  let day = 0;
  const mk = (rating: number, body: string, extra: Partial<ReviewInput> = {}) =>
    seedReview(m.api, { productId: VIS_ID, sourceReviewId: `${label}-${body}`, rating, body, reviewerName: `Name ${label}`, reviewDate: new Date(Date.UTC(2026, 0, ++day)), status: "published", held: false, ...PRIVATE, ...extra });
  await mk(5, `public-5-${label}`, { reply: `Reply ${label}` });
  await mk(4, `public-4a-${label}`);
  await mk(4, `public-4b-${label}`);
  await mk(1, `pending-${label}`, { status: "pending" });
  await mk(1, `rejected-${label}`, { status: "rejected" });
  await mk(2, `hidden-${label}`, { status: "hidden" });
  await mk(1, `planlimited-pending-${label}`, { status: "pending", held: true });
  await mk(3, `planlimited-published-${label}`, { held: true }); // defence in depth: still never public
  // Edited in Shopify admin after Proofly published it (a merchant turning 2★ into 5★): never public until re-approved.
  const edited = await mk(2, `edited-${label}`);
  storeOf(m.domain).editOutside(edited.id, { rating: "5", body: `edited-${label} (now glowing)` });
  await recomputeProduct(m.api, VIS_ID);
  // A second product with 12 public reviews for pagination.
  for (let i = 0; i < 12; i++) await seedReview(m.api, { productId: PAGED_ID, sourceReviewId: `${label}-p${i}`, rating: 5, body: `paged ${i}`, reviewerName: "P", reviewDate: new Date(Date.UTC(2026, 1, i + 1)) });
  await recomputeProduct(m.api, PAGED_ID);
}

const list = async (domain: string, id: bigint, q: Record<string, string> = {}) =>
  proxyList(args<LoaderFunctionArgs>(proxyRequest(domain, `products/${id}/reviews`, q), { id: String(id) }));
const ratings = async (domain: string, handles: string) => proxyRatings(args<LoaderFunctionArgs>(proxyRequest(domain, "ratings", { handles })));

describe("Storefront data", () => {
  before(async () => {
    await resetDb();
    A = await installMerchant(DOMAIN_A, "A");
    B = await installMerchant(DOMAIN_B, "B");
    await seedVisibility(A, "A");
    await seedVisibility(B, "B");
    // B's copy gets a different rating so cross-shop leakage would be visible.
    for (const r of (await reviewsIn(B.api)).filter((x) => x.productId === VIS_ID && x.isPublic)) await updateReview(B.api, r, { rating: 2 });
    await recomputeProduct(B.api, VIS_ID);
  });
  after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

  test("published-review filtering: pending, rejected, hidden and plan-limited reviews never appear", async () => {
    const body = await (await list(DOMAIN_A, VIS_ID, { summary: "1", sort: "highest" })).json();
    assert.deepEqual(body.reviews.map((r: { body: string }) => r.body), ["public-5-A", "public-4b-A", "public-4a-A"]);
    assert.equal((await (await list(DOMAIN_A, VIS_ID, { rating: "1" })).json()).reviews.length, 0); // all 1★ are non-public
    assert.equal((await (await list(DOMAIN_A, VIS_ID, { rating: "3" })).json()).reviews.length, 0); // published + plan_limit
  });

  test("no photos anywhere: no photo field, filter, upload or lightbox on the storefront, and none in the JSON", async () => {
    const body = await (await list(DOMAIN_A, VIS_ID, { summary: "1", photos: "1" })).json();
    assert.deepEqual(body.reviews.map((r: { body: string }) => r.body).sort(), ["public-4a-A", "public-4b-A", "public-5-A"]); // photos=1 is ignored
    assert.ok(!/images|photo|thumb|withPhotos/.test(JSON.stringify(body)));
    for (const f of ["blocks/reviews.liquid", "assets/proofly-reviews.js", "assets/proofly.css"]) {
      assert.doesNotMatch(readFileSync(ext(f), "utf8"), /type="file"|lightbox|data-photos|pf-photo|name="images"|getAll\("images"\)/i, f);
    }
  });

  test("rating/count calculation uses public reviews only, and the same numbers go to Shopify's metafields", async () => {
    const p = await owner.product.findFirstOrThrow({ where: { shopId: A.shopId, handle: VIS_HANDLE } });
    assert.equal(p.reviewCount, 3);
    assert.equal(Number(p.averageRating), 4.33);
    assert.deepEqual([p.rating1, p.rating2, p.rating3, p.rating4, p.rating5], [0, 0, 0, 2, 1]);
    const body = await (await list(DOMAIN_A, VIS_ID, { summary: "1" })).json();
    assert.deepEqual(body.summary, { count: 3, average: 4.33, distribution: [0, 0, 0, 2, 1] });

    const shopify = new FakeShopify();
    await syncRatingCache(A.shopId, shopify.graphql);
    assert.deepEqual(shopify.rating(VIS_ID), { average: "4.33", count: 3 });
    // A product with no Proofly reviews is unmanaged: nothing is written (it may carry another app's rating).
    assert.deepEqual(shopify.rating(9_000_000_000_125n), { average: null, count: null });
  });

  test("pagination: 10 per page with hasMore, then the rest", async () => {
    const p1 = await (await list(DOMAIN_A, PAGED_ID)).json();
    const p2 = await (await list(DOMAIN_A, PAGED_ID, { page: "2" })).json();
    assert.equal(p1.reviews.length, 10);
    assert.equal(p1.hasMore, true);
    assert.equal(p2.reviews.length, 2);
    assert.equal(p2.hasMore, false);
    assert.equal(p1.reviews[0].body, "paged 11"); // most recent first
  });

  test("empty review state: a product with no public reviews returns an empty list and zero summary", async () => {
    const body = await (await list(DOMAIN_A, 9_000_000_000_125n, { summary: "1" })).json();
    assert.deepEqual(body, { reviews: [], page: 1, hasMore: false, summary: { count: 0, average: 0, distribution: [0, 0, 0, 0, 0] } });
  });

  test("product-card ratings: batched by handle, this shop only, products without public reviews absent", async () => {
    const res = await ratings(DOMAIN_A, `${VIS_HANDLE},zero-product,${SAME_HANDLE},no-such-product,<script>`);
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=300");
    assert.deepEqual(await res.json(), { ratings: { [VIS_HANDLE]: [4.33, 3], [SAME_HANDLE]: [5, 1] } });
    assert.equal(parseHandles(Array.from({ length: 150 }, (_, i) => `h${i}`).join(",")).length, 100);
    assert.deepEqual(parseHandles("Mixed-Case,ok,<b>,a/b,ok"), ["mixed-case", "ok"]);
  });

  test("Merchant A isolation from Merchant B: identical product id and handle resolve to each shop's own data", async () => {
    assert.deepEqual((await (await ratings(DOMAIN_B, VIS_HANDLE)).json()).ratings, { [VIS_HANDLE]: [2, 3] });
    assert.deepEqual((await (await ratings(DOMAIN_A, VIS_HANDLE)).json()).ratings, { [VIS_HANDLE]: [4.33, 3] });
    const a = JSON.stringify(await (await list(DOMAIN_A, VIS_ID, { summary: "1" })).json());
    const b = JSON.stringify(await (await list(DOMAIN_B, VIS_ID, { summary: "1" })).json());
    assert.ok(!a.includes("-B") && !a.includes("Reply B"));
    assert.ok(!b.includes("-A") && !b.includes("Reply A"));
  });

  test("unknown and uninstalled shops are rejected identically; unsigned or forged requests are rejected", async () => {
    const unknown = await run(() => ratings(DOMAIN_C, VIS_HANDLE));
    const unknownList = await run(() => list(DOMAIN_C, VIS_ID));
    await installMerchant("proofly-test-gone.myshopify.com", "Gone");
    await markUninstalled("proofly-test-gone.myshopify.com");
    const gone = await run(() => ratings("proofly-test-gone.myshopify.com", SAME_HANDLE));
    const goneList = await run(() => list("proofly-test-gone.myshopify.com", VIS_ID));
    for (const r of [unknown, unknownList, gone, goneList]) assert.equal(r.response?.status, 404);
    assert.equal(await unknown.response!.text(), await gone.response!.text());

    const unsigned = await run(() => proxyRatings(args<LoaderFunctionArgs>(new Request(`${process.env.SHOPIFY_APP_URL}/proxy/ratings?handles=${VIS_HANDLE}&shop=${DOMAIN_A}`))));
    const forged = new URL(proxyRequest(DOMAIN_A, "ratings", { handles: VIS_HANDLE }).url);
    forged.searchParams.set("signature", "0".repeat(64));
    const bad = await run(() => proxyRatings(args<LoaderFunctionArgs>(new Request(forged))));
    for (const r of [unsigned, bad]) assert.ok(r.response && r.response.status >= 400 && r.response.status < 500);
  });

  test("public response privacy: exact allow-listed fields only, even for rows that hold private data", async () => {
    const res = await list(DOMAIN_A, VIS_ID, { summary: "1" });
    assert.equal(res.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    const text = await res.text();
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body).sort(), ["hasMore", "page", "reviews", "summary"]);
    for (const r of body.reviews) {
      assert.deepEqual(Object.keys(r).sort(), ["body", "date", "name", "rating", "reply", "title", "verified"]);
      if (r.reply) assert.deepEqual(Object.keys(r.reply).sort(), ["body", "date"]);
    }
    for (const s of ["email", "spam_suspected", "plan_limit", "held", "edited-A"]) {
      assert.ok(!text.includes(s), `leaked ${s}`);
    }
    // No internal id anywhere.
    const ids = await reviewsIn(A.api);
    for (const s of [A.shopId, String(A.shopId).slice(0, 8), ...ids.flatMap((r) => [r.id, r.handle, r.sourceReviewId, `Metaobject/${r.id.split("/").pop()}`]), String(VIS_ID), "s/", "gid://", "integrity", "sort_key"]) {
      assert.ok(!text.includes(s), `leaked ${s}`);
    }
    const r = await (await ratings(DOMAIN_A, VIS_HANDLE)).text();
    assert.equal(r, `{"ratings":{"${VIS_HANDLE}":[4.33,3]}}`);
  });
});
