/**
 * Verifies the synthetic fixture covers every importer case and is self-consistent.
 *   npx tsx scripts/fixtures/check.ts [--dir fixtures/synthetic]
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseCsv } from "../lib/csv";
import { FICTIONAL_ID_BASE } from "./constants";

const i = process.argv.indexOf("--dir");
const DIR = path.resolve(i > -1 ? process.argv[i + 1] : "fixtures/synthetic");
const read = (f: string) => readFile(path.join(DIR, f), "utf8");

const rows = parseCsv(await read("reviews.csv"));
const catalogue = JSON.parse(await read("catalogue.json")) as { id: string; title: string }[];
const exp = JSON.parse(await read("expectations.json"));
const manifest = parseCsv(await read("images-manifest.csv"));
const files = new Set(await readdir(path.join(DIR, "images")));
const checks: [string, boolean][] = [];
const ok = (name: string, cond: boolean) => checks.push([name, cond]);

ok("~1,150 reviews", rows.length >= 1100 && rows.length <= 1200 && rows.length === exp.reviews);
ok("~90 products", catalogue.length >= 85 && catalogue.length <= 95);
ok("~160 images", exp.images_valid >= 150 && exp.images_valid <= 170 && manifest.length === exp.images_valid);
ok("multi-image reviews", exp.multi_image_reviews >= 10);
ok("duplicate text on same product", exp.duplicate_same_product_extra_rows >= 8);
ok("cross-product repeated text", exp.cross_product_groups >= 25 && exp.cross_product_rows >= 100);
ok("missing titles", exp.missing_title >= 1);
ok("reply-like records", exp.reply_like >= 3);
ok("unmatched products", exp.unmatched_rows >= 10);
ok("ambiguous title needs confirmation", exp.ambiguous_title >= 1);
ok("matching by id/handle/sku/title", exp.match_by_id > 0 && exp.match_by_handle > 0 && exp.match_by_sku > 0 && exp.match_by_unique_title > 0);
ok("multiple review states", ["published", "pending", "hidden", "rejected"].every((s) => exp.status[s] > 0));
ok("invalid records", exp.invalid_rating >= 3 && exp.invalid_date >= 3);
ok("plan-limited under Free", exp.plan_limited_under_free > 0 && exp.plan_limited_under_free === exp.importable_published - 100);
ok("storage-limited scenario", exp.storage_scenario.allowance_bytes > 0 && manifest.reduce((a, m) => a + Number(m.bytes), 0) > exp.storage_scenario.allowance_bytes);
ok("missing + corrupt image references", exp.images_missing >= 2 && exp.images_corrupt >= 1);

// integrity
let shaOk = true;
for (const m of manifest) {
  const buf = await readFile(path.join(DIR, "images", m.filename));
  shaOk &&= createHash("sha256").update(buf).digest("hex") === m.sha256 && buf.length === Number(m.bytes);
}
ok("image SHA-256 + sizes match manifest", shaOk);
ok("every referenced valid image exists", rows.flatMap((r) => (r.image_files ? r.image_files.split(";") : [])).filter((f) => !f.includes("missing")).every((f) => files.has(f)));

// obviously fictional
ok("product ids in fictional range", catalogue.every((p) => Number(p.id) >= FICTIONAL_ID_BASE) && rows.every((r) => !r.product_id || Number(r.product_id) >= FICTIONAL_ID_BASE));
ok("reviewer names fictional", rows.every((r) => /\b(Example|Sample|Testwell|Demo|Placeholder|Fixture)\b|Example Store Team/.test(r.reviewer_name)));
ok("product titles fictional", catalogue.every((p) => /\b(Example|Sample|Test|Demo)\b/.test(p.title)));
ok("no email addresses", !rows.some((r) => Object.values(r).some((v) => /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(v))));

for (const [name, pass] of checks) console.log(`${pass ? "✓" : "✗"} ${name}`);
const failed = checks.filter(([, p]) => !p).length;
assert.equal(failed, 0, `${failed} fixture check(s) failed`);
console.log(`\n${checks.length} fixture checks passed (${rows.length} reviews, ${catalogue.length} products, ${exp.images_valid} images)`);
