/**
 * Builds a PRIVATE hashed denylist from a private dataset, for scripts/scan-merchant-data.ts.
 * Run locally only; write the output OUTSIDE this repository. Only SHA-256 hashes are written.
 *
 *   npx tsx scripts/scan/build-denylist.ts --out /outside/repo/denylist.json \
 *     --csv /private/reviews.csv --phrase reviewer_name,product_handle,product_title --long-phrase review_title --id product_id --text review_text \
 *     [--json /private/catalogue.json --phrase handle,title --id id]
 *
 *  --phrase cols  names/handles/titles: ≥ 2 tokens and ≥ 6 characters, hashed as whole phrases
 *  --long-phrase cols  generic short text (e.g. review titles): only ≥ 4 tokens, to avoid common phrases
 *  --id cols      identifiers (≥ 6 characters) hashed as single tokens
 *  --text cols    free text hashed as 6-token shingles (detects copied review content)
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseCsv } from "../../app/lib/csv";

const SHINGLE = 6;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tokenize = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
const out = new Map<string, number>();
const add = (toks: string[]) => { if (toks.length) out.set(sha(toks.join("")), toks.length); };

const argv = process.argv.slice(2);
const outPath = argv[argv.indexOf("--out") + 1];
if (!outPath || path.resolve(outPath).startsWith(process.cwd() + path.sep)) throw new Error("--out must be a path outside this repository");

// Walk args in order: each --csv/--json starts a source; following --phrase/--id/--text apply to it.
let rows: Record<string, unknown>[] = [];
for (let i = 0; i < argv.length; i += 2) {
  const [flag, val] = [argv[i], argv[i + 1]];
  if (flag === "--csv") rows = parseCsv(readFileSync(val, "utf8"));
  else if (flag === "--json") rows = JSON.parse(readFileSync(val, "utf8"));
  else if (flag === "--phrase" || flag === "--long-phrase" || flag === "--id" || flag === "--text") {
    for (const r of rows) for (const col of val.split(",")) {
      const toks = tokenize(String(r[col] ?? ""));
      const chars = toks.join("").length;
      if (flag === "--id") toks.filter((t) => t.length >= 6).forEach((t) => add([t]));
      else if (flag === "--phrase") { if (toks.length >= 2 && chars >= 6) add(toks); }
      else if (flag === "--long-phrase") { if (toks.length >= 4) add(toks); }
      else for (let s = 0; s + SHINGLE <= toks.length; s++) add(toks.slice(s, s + SHINGLE));
    }
  }
}
writeFileSync(outPath, JSON.stringify([...out].map(([h, n]) => ({ n, h }))));
console.log(`private denylist: ${out.size} hashes → ${outPath}`);
