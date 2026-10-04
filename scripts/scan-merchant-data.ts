/**
 * Merchant-data scan: fails if real merchant/customer data could ship with Proofly.
 *
 *   npx tsx scripts/scan-merchant-data.ts            # tracked + to-be-committed files, and build/ + extensions/
 *   PROOFLY_PRIVATE_DENYLIST=/outside/repo/denylist.json npx tsx scripts/scan-merchant-data.ts
 *
 * Rules
 *  R1  build output contains no data dumps (csv/sql/sqlite/archives) and no images (except the favicon)
 *  R2  images may only be tracked under brand/ and public/
 *  R3  no email addresses except fictional/example domains
 *  R4  no phone numbers
 *  R5  no *.myshopify.com domains except fictional development stores
 *  R6  no Shopify-style 13-digit IDs in the real range (1e12 ≤ id < 9e12); fictional IDs use ≥ 9e12
 *  R7  no token/phrase whose SHA-256 is on the committed denylist (scripts/scan/denylist.json) or the optional
 *      private denylist (built outside the repo by scripts/scan/build-denylist.ts) — matches are reported by hash only
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const IMAGE = /\.(png|jpe?g|gif|webp|avif|heic|bmp|tiff?|ico|svg)$/i;
const DATA_DUMP = /\.(csv|tsv|sql|sqlite3?|db|zip|tar|gz|tgz|7z|ndjson|jsonl)$/i;
const SKIP_CONTENT = /(^|\/)(package-lock\.json)$|\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|map)$/i;
const ALLOWED_EMAIL_DOMAINS = /@(example\.(com|org|net)|proofly\.test)$/i;
const ALLOWED_SHOPS = new Set(["proofly-dev", "proofly-test-a", "proofly-test-b", "proofly-test-gone", "proofly-test-c", "proofly-test-d", "proofly-test-e", "proofly-test-f", "proofly-test-g", "proofly-test-h", "proofly-test-i", "example", "your-store", "shop"]); // fictional / template placeholders

type Finding = { rule: string; file: string; line?: number; detail: string };
const findings: Finding[] = [];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const deny = new Set<string>();
let maxN = 1;
function loadDenylist(file: string) {
  for (const e of JSON.parse(readFileSync(file, "utf8")) as { n: number; h: string }[]) { deny.add(e.h); maxN = Math.max(maxN, e.n); }
}
loadDenylist(path.join(ROOT, "scripts/scan/denylist.json"));
const privatePath = process.env.PROOFLY_PRIVATE_DENYLIST;
if (privatePath) {
  if (path.resolve(privatePath).startsWith(ROOT + path.sep)) throw new Error("The private denylist must live outside the repository.");
  loadDenylist(privatePath);
}

/** Lower-case alphanumeric tokens; phrases are hashed as their tokens concatenated (so “a-b”, “a b”, “ab” all match). */
const tokenize = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter(Boolean);

function scanText(file: string, text: string, build: boolean) {
  const lines = text.split("\n");
  lines.forEach((line, idx) => {
    const at = { file, line: idx + 1 };
    for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g))
      if (!ALLOWED_EMAIL_DOMAINS.test(m[0]) && !/@[\d.]+$/.test(m[0]) && !/\.(png|jpe?g|webp|js|css)$/i.test(m[0])) findings.push({ rule: "R3 email", ...at, detail: m[0].replace(/^[^@]+/, "***") });
    if (!build && /(?<![\w.])\+?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w])/.test(line)) findings.push({ rule: "R4 phone", ...at, detail: "phone-like number" });
    for (const m of line.matchAll(/([a-z0-9][a-z0-9-]*)\.myshopify\.com/gi))
      if (!ALLOWED_SHOPS.has(m[1].toLowerCase())) findings.push({ rule: "R5 shop domain", ...at, detail: `${m[1]}.myshopify.com` });
    for (const m of line.matchAll(/(?<![\d.])\d{13}(?![\d.])/g)) {
      const n = Number(m[0]);
      if (n >= 1e12 && n < 9e12 && !build) findings.push({ rule: "R6 real-range id", ...at, detail: m[0] });
    }
    const toks = tokenize(line);
    for (let i = 0; i < toks.length; i++) {
      let phrase = "";
      for (let n = 1; n <= maxN && i + n <= toks.length; n++) {
        phrase += toks[i + n - 1];
        if (deny.has(sha(phrase))) findings.push({ rule: "R7 denylist", ...at, detail: `${n}-token match ${sha(phrase).slice(0, 12)}…` });
      }
    }
  });
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [path.relative(ROOT, p)];
  });
}

// 1. Repository files (tracked + untracked-not-ignored, i.e. everything that could be committed)
const repoFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n").filter((f) => f && existsSync(f));
for (const f of repoFiles) {
  if (IMAGE.test(f) && !/^(brand|public)\//.test(f)) findings.push({ rule: "R2 tracked image", file: f, detail: "images allowed only in brand/ and public/" });
  if (/^prisma\/migrations\/.+\/migration\.sql$/.test(f)) {
    // Schema migrations are allowed only if they contain no data statements.
    if (/\b(INSERT\s+INTO|COPY\s+\S+\s+FROM|VALUES\s*\()/i.test(readFileSync(f, "utf8"))) findings.push({ rule: "R1 data in migration", file: f, detail: "migration contains data statements" });
  } else if (DATA_DUMP.test(f)) findings.push({ rule: "R1 data file", file: f, detail: "data dump tracked in repository" });
  if (!SKIP_CONTENT.test(f)) scanText(f, readFileSync(f, "utf8"), false);
}

// 2. Production build artefacts (what actually ships): app build + theme extension
const buildFiles = [...walk("build"), ...walk("extensions")];
if (!walk("build").length) findings.push({ rule: "R1 build missing", file: "build/", detail: "run `npm run build` before scanning" });
for (const f of buildFiles) {
  if (DATA_DUMP.test(f)) findings.push({ rule: "R1 data file", file: f, detail: "data dump in build output" });
  if (IMAGE.test(f) && !/favicon\.ico$/.test(f)) findings.push({ rule: "R1 image", file: f, detail: "image in build output" });
  if (!SKIP_CONTENT.test(f) && !IMAGE.test(f)) scanText(f, readFileSync(f, "utf8"), true);
}

const scanned = new Set([...repoFiles, ...buildFiles]).size;
console.log(`merchant-data scan: ${repoFiles.length} repository files, ${buildFiles.length} build/extension files (${scanned} unique), denylist ${deny.size} hashes${privatePath ? " incl. private" : ""}`);
for (const f of findings) console.log(`✗ ${f.rule}  ${f.file}${f.line ? `:${f.line}` : ""}  ${f.detail}`);
console.log(findings.length ? `\nFAIL — ${findings.length} finding(s)` : "\nPASS — no merchant/customer data found");
process.exitCode = findings.length ? 1 : 0;
