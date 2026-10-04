/**
 * Synthetic review-migration fixture (deterministic, obviously fictional — no real merchant or customer data).
 *
 *   npx tsx scripts/fixtures/generate.ts [--out fixtures/synthetic] [--seed 20261003]
 *
 * Produces a dataset roughly the size and shape of a real recovery export (~1,150 reviews, ~90 products,
 * ~160 images) exercising every importer edge case. Output (git-ignored):
 *   catalogue.json         fictional Shopify product snapshot (ids in the reserved fictional range ≥ 9e12)
 *   reviews.csv            Proofly import template
 *   images/                generated JPEG/PNG/WebP files (+ one corrupt, two referenced-but-missing)
 *   images-manifest.csv    filename, sha256, bytes, content type
 *   expectations.json      exact counts every importer test can assert against
 */
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { FICTIONAL_ID_BASE, FREE_PUBLISHED_LIMIT, SMALL_MEDIA_ALLOWANCE_BYTES } from "./constants";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg("out", "fixtures/synthetic"));
let seed = Number(arg("seed", "20261003")) >>> 0;
const rand = () => { // mulberry32
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));


const ADJ = ["Aurora", "Basalt", "Cedar", "Drift", "Ember", "Fjord", "Glacier", "Harbor", "Indigo", "Juniper", "Kestrel", "Lumen", "Meadow", "Nimbus", "Orchard"];
const NOUN = ["Example Mug", "Sample Tote", "Test Lamp", "Demo Candle", "Example Notebook", "Sample Scarf"];
const FIRST = ["Alex", "Jordan", "Sam", "Riley", "Casey", "Taylor", "Morgan", "Jamie", "Avery", "Quinn", "Drew", "Parker", "Rowan", "Sky", "Robin", "Emery"];
const LAST = ["Example", "Sample", "Testwell", "Demo", "Placeholder", "Fixture"];
const OPEN = ["Arrived quickly", "Exactly as described", "Better than expected", "Solid purchase", "Would buy again", "Nice quality", "Not quite right", "Okay overall"];
const LINES = [
  "The {p} looks great on my desk.", "Packaging was tidy and the {p} was well protected.",
  "I have used the {p} every day for a month.", "Colour matches the photos closely.",
  "Customer support answered my question within a day.", "Smaller than I imagined, but still useful.",
  "The finish on the {p} feels premium.", "Bought a second one as a gift.", "Took a while to arrive.",
];

interface Product { id: string; handle: string; title: string; status: string; skus: string[] }
interface Row {
  source_review_id: string; product_id: string; product_handle: string; product_title: string; sku: string;
  rating: string; title: string; body: string; reviewer_name: string; review_date: string; status: string;
  image_files: string; reply: string;
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, "images"), { recursive: true });

  // ---- catalogue: 90 products (5 drafts), two share a title (title-only rows get two suggestions, never a match)
  const products: Product[] = [];
  for (let i = 0; products.length < 90; i++) {
    const title = `${ADJ[i % ADJ.length]} ${NOUN[Math.floor(i / ADJ.length) % NOUN.length]}`;
    const handle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    products.push({ id: String(FICTIONAL_ID_BASE + 1000 + i), handle, title, status: i % 18 === 17 ? "draft" : "active", skus: [`PF-${1000 + i}-A`, `PF-${1000 + i}-B`] });
  }
  products[89].title = products[88].title; // ambiguous title pair (handles stay unique)
  const unmatched = Array.from({ length: 4 }, (_, i) => ({ id: String(FICTIONAL_ID_BASE + 9000 + i), handle: `retired-example-item-${i + 1}`, title: `Retired Example Item ${i + 1}` }));

  const rows: Row[] = [];
  const exp = {
    reviews: 0, products_in_catalogue: products.length, products_referenced: 0,
    match_by_id: 0, match_by_handle: 0, match_by_sku: 0, title_only_one_suggestion: 0, title_only_several_suggestions: 0, unmatched_rows: 0,
    invalid_rating: 0, invalid_date: 0, missing_title: 0, reply_like: 0,
    duplicate_same_product_extra_rows: 0, cross_product_groups: 0, cross_product_rows: 0,
    status: { published: 0, pending: 0, hidden: 0, rejected: 0 } as Record<string, number>,
    images_referenced: 0, images_valid: 0, images_missing: 0, images_corrupt: 0, multi_image_reviews: 0,
    importable_published: 0, plan_limited_under_free: 0,
    storage_scenario: { allowance_bytes: SMALL_MEDIA_ALLOWANCE_BYTES, expect_storage_limited_at_least: 1 },
  };
  const date = () => {
    const t = Date.UTC(2018, 11, 1) + rand() * (Date.UTC(2026, 5, 30) - Date.UTC(2018, 11, 1));
    return new Date(t).toISOString().slice(0, 16).replace("T", " ");
  };
  const rating = () => String(pick([5, 5, 5, 5, 4, 4, 4, 3, 2, 1]));
  const body = (p: string) => Array.from({ length: int(1, 3) }, () => pick(LINES).replaceAll("{p}", p)).join(" ");
  let n = 0;
  const add = (p: { id: string; handle: string; title: string; skus?: string[] }, over: Partial<Row> = {}, how: "id" | "handle" | "sku" | "title" = "id") => {
    const r: Row = {
      source_review_id: `syn-${String(++n).padStart(5, "0")}`,
      product_id: how === "id" ? p.id : "", product_handle: how === "handle" || how === "id" ? p.handle : "",
      product_title: p.title, sku: how === "sku" ? (p.skus?.[1] ?? "") : "",
      rating: rating(), title: pick(OPEN), body: body(p.title), reviewer_name: `${pick(FIRST)} ${pick(LAST)}`,
      review_date: date(), status: "published", image_files: "", reply: "", ...over,
    };
    rows.push(r);
    return r;
  };

  // ---- bulk: Zipf-like distribution over active products, mixed match methods
  const weights = products.map((_, i) => 1 / (i + 1) ** 0.85);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const howFor = (i: number) => (i % 25 === 0 ? "sku" : i % 9 === 0 ? "handle" : "id") as "id" | "handle" | "sku";
  for (let i = 0; i < 920; i++) {
    let x = rand() * wsum, k = 0;
    while (x > weights[k]) x -= weights[k++];
    add(products[Math.min(k, 87)], {}, howFor(i));
  }
  for (let i = 0; i < 8; i++) add(products[10 + i], {}, "title");                       // title only → unmatched, 1 suggestion
  for (let i = 0; i < 3; i++) add(products[88], {}, "title");                            // title only, shared title → 2 suggestions
  for (let i = 0; i < 12; i++) add(unmatched[i % unmatched.length], {}, i % 2 ? "handle" : "id"); // unmatched products

  // duplicates on the same product (7 groups → 8 extra rows)
  const dupBase = rows.slice(20, 27);
  dupBase.forEach((b, i) => { for (let c = 0; c < (i === 0 ? 2 : 1); c++) add(products.find((p) => p.id === b.product_id || p.handle === b.product_handle) ?? products[0], { body: b.body, reviewer_name: b.reviewer_name, title: b.title, review_date: b.review_date }); });
  // cross-product repeats: same reviewer + text on several products
  for (let g = 0; g < 30; g++) {
    const who = `${pick(FIRST)} ${pick(LAST)}`, text = `Ordered a bundle of items and every one was great. Batch ${g + 1}.`, when = date();
    const span = int(2, 10);
    for (let s = 0; s < span; s++) add(products[(g * 7 + s * 3) % 88], { reviewer_name: who, body: text, title: "Great bundle", review_date: when });
  }
  // missing titles, reply-like rows, states, invalid records
  rows.slice(100, 105).forEach((r) => (r.title = ""));
  for (let i = 0; i < 3; i++) add(products[i], { reviewer_name: "Example Store Team", title: `Response to ${pick(FIRST)}`, body: "Thanks for the feedback — please contact our support team so we can help.", rating: "5" });
  rows.slice(200, 220).forEach((r) => (r.status = "pending"));
  rows.slice(220, 226).forEach((r) => (r.status = "hidden"));
  rows.slice(226, 230).forEach((r) => (r.status = "rejected"));
  ["0", "6", "five"].forEach((v, i) => (rows[300 + i].rating = v));
  ["31/12/2020", "2021-13-40 10:00", "yesterday"].forEach((v, i) => (rows[310 + i].review_date = v));
  rows[400].reply = "Thank you — glad it worked out.";
  rows[401].reply = "Sorry about the delay, we have improved our dispatch times.";

  // ---- images: ~160 across ~120 reviews (some multi-image), plus corrupt + missing references
  let imgN = 0;
  const imgRows: string[] = [];
  const makeImage = async (fmt: "jpeg" | "png" | "webp") => {
    const w = int(400, 1800), h = int(400, 1800), name = `syn-img-${String(++imgN).padStart(4, "0")}.${fmt === "jpeg" ? "jpg" : fmt}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${int(0, 359)},55%,60%)"/><text x="50%" y="50%" font-size="${Math.round(w / 14)}" text-anchor="middle" fill="#fff" font-family="sans-serif">PROOFLY TEST IMAGE ${imgN}</text></svg>`;
    let img = sharp(Buffer.from(svg));
    if (imgN % 25 === 0) img = img.withExif({ IFD0: { Artist: "Proofly synthetic fixture", Copyright: "Fictional test data" } });
    const buf = await img.toFormat(fmt, { quality: 82 }).toBuffer();
    await writeFile(path.join(OUT, "images", name), buf);
    imgRows.push([name, createHash("sha256").update(buf).digest("hex"), buf.length, `image/${fmt}`].join(","));
    return name;
  };
  const withImages = rows.filter((r, i) => i % 9 === 3 && r.status === "published").slice(0, 122);
  for (const [i, r] of withImages.entries()) {
    const count = i % 10 === 0 ? int(3, 5) : i % 4 === 0 ? 2 : 1;
    const names: string[] = [];
    for (let c = 0; c < count && imgN < 158; c++) names.push(await makeImage(pick(["jpeg", "jpeg", "png", "webp"] as const)));
    r.image_files = names.join(";");
  }
  await writeFile(path.join(OUT, "images", "syn-img-corrupt.jpg"), Buffer.from("not really an image"));
  withImages[1].image_files += ";syn-img-corrupt.jpg";
  withImages[2].image_files += ";syn-img-missing-1.jpg";
  withImages[3].image_files += ";syn-img-missing-2.png";

  // ---- expectations (exact)
  const prodById = new Map(products.map((p) => [p.id, p]));
  const prodByHandle = new Map(products.map((p) => [p.handle, p]));
  const prodBySku = new Map(products.flatMap((p) => p.skus.map((s) => [s, p] as const)));
  const titleCount = new Map<string, number>();
  products.forEach((p) => titleCount.set(p.title, (titleCount.get(p.title) ?? 0) + 1));
  const referenced = new Set<string>();
  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s) && !isNaN(Date.parse(s.replace(" ", "T") + ":00Z"));
  const importablePublished: Row[] = [];
  const seenText = new Map<string, number>();
  for (const r of rows) {
    exp.reviews++;
    exp.status[r.status]++;
    // Automatic matching: ID → handle → SKU only. Title is NEVER an automatic key: a title-only row stays unmatched
    // (the exact-title products are merchant-facing suggestions).
    let matched: Product | undefined;
    const titles = titleCount.get(r.product_title) ?? 0;
    if (r.product_id && (matched = prodById.get(r.product_id))) exp.match_by_id++;
    else if (r.product_handle && (matched = prodByHandle.get(r.product_handle))) exp.match_by_handle++;
    else if (r.sku && (matched = prodBySku.get(r.sku))) exp.match_by_sku++;
    else {
      exp.unmatched_rows++;
      if (!r.product_id && !r.product_handle && !r.sku) { if (titles === 1) exp.title_only_one_suggestion++; else if (titles > 1) exp.title_only_several_suggestions++; }
    }
    if (matched) referenced.add(matched.id);
    const validRating = /^[1-5]$/.test(r.rating);
    if (!validRating) exp.invalid_rating++;
    if (!isDate(r.review_date)) exp.invalid_date++;
    if (!r.title) exp.missing_title++;
    if (r.reviewer_name === "Example Store Team") exp.reply_like++;
    const files = r.image_files ? r.image_files.split(";") : [];
    exp.images_referenced += files.length;
    if (files.length > 1) exp.multi_image_reviews++;
    exp.images_missing += files.filter((f) => f.includes("missing")).length;
    exp.images_corrupt += files.filter((f) => f.includes("corrupt")).length;
    const key = `${matched?.id}|${r.reviewer_name}|${r.body}`;
    if (matched) seenText.set(key, (seenText.get(key) ?? 0) + 1);
    // Reply-like rows are ordinary reviews to a generic importer (no name heuristics); they import like any other row.
    if (matched && validRating && isDate(r.review_date) && r.status === "published") importablePublished.push(r);
  }
  exp.images_valid = imgN;
  exp.products_referenced = referenced.size;
  exp.duplicate_same_product_extra_rows = [...seenText.values()].reduce((a, c) => a + (c > 1 ? c - 1 : 0), 0);
  exp.cross_product_groups = 30;
  exp.cross_product_rows = rows.filter((r) => r.body.startsWith("Ordered a bundle")).length;
  exp.importable_published = importablePublished.length;
  exp.plan_limited_under_free = Math.max(0, importablePublished.length - FREE_PUBLISHED_LIMIT);

  // ---- write
  const cols = Object.keys(rows[0]) as (keyof Row)[];
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  await writeFile(path.join(OUT, "reviews.csv"), [cols.join(","), ...rows.map((r) => cols.map((c) => q(r[c])).join(","))].join("\n") + "\n");
  await writeFile(path.join(OUT, "catalogue.json"), JSON.stringify(products, null, 1));
  await writeFile(path.join(OUT, "images-manifest.csv"), ["filename,sha256,bytes,content_type", ...imgRows].join("\n") + "\n");
  await writeFile(path.join(OUT, "expectations.json"), JSON.stringify(exp, null, 1));
  console.log(`synthetic fixture → ${path.relative(process.cwd(), OUT)}: ${exp.reviews} reviews, ${products.length} products, ${imgN} images`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
