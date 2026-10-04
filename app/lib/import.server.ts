import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { recomputeProducts } from "./aggregates.server";
import { parseCsv } from "./csv";
import { BULK_MAX_BYTES } from "./bulk.server";
import { bumpStats, bumpStatsMany, can, releaseEligibleReviews } from "./entitlements.server";
import { syncAfterRatingChange } from "./rating-cache.server";
import { createReview, findByHandles, finishBulkCreate, reviewHandle, scanReviews, startBulkCreate, updateReview, type ReviewInput, type ShopApi, type StoredReview } from "./review-store.server";
import { importFileKey, readPrivate, storePrivateFile } from "./storage.server";
import { isShopActive, withTenant, type Tenant } from "./tenant.server";

/**
 * Merchant-owned review import engine (generic CSV; provider presets only map columns). docs/IMPORT.md.
 *
 *  createImport  → validates limits, stores the CSV privately, parses + VALIDATES + MATCHES every record (nothing is
 *                  written to reviews yet), saves the analysis and per-product matches → job "queued".
 *  runImport     → claims the job and writes records in small batches, each batch committed together with the job's
 *                  cursor (resume = continue at the cursor; no giant transaction). Then FINALIZE once: admit the job's
 *                  reviews to public view by date order (entitlements), recompute aggregates, flag
 *                  duplicates. Rating cache sync goes through rating-cache.server.
 *  Lifecycle: queued → running → completed | completed_with_warnings | failed (resumable) | cancelled.
 *
 * Locked rules honoured here: imports never truncated (plan limits only hold reviews back, oldest-first admission);
 * nothing deleted; title is never an automatic product-matching key; review photos are not supported (photo columns are
 * ignored like any other unknown column); unknown statuses never become public; a source
 * "published" row still goes through Proofly's admission; tenant = the authenticated shop only.
 */

const MB = 1024 ** 2;
export const IMPORT_LIMITS = Object.freeze({
  csvBytes: 50 * MB,
  bodyChars: 20_000, titleChars: 255, nameChars: 255, batchRows: 50, reportProblems: 1_000,
  // Imports with at least this many rows write in Shopify bulk operations of up to bulkRows rows each.
  bulkMinRows: 250, bulkRows: 5_000,
});

export class ImportError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

// ---------------------------------------------------------------------------------------------------------------
// Columns (generic template + common aliases). Anything else — e.g. email columns — is ignored, never stored.
const ALIASES = {
  sourceReviewId: ["review_id", "source_review_id", "id"],
  productId: ["product_id", "shopify_product_id"],
  handle: ["product_handle", "handle"],
  sku: ["sku", "product_sku", "variant_sku"],
  productTitle: ["product_title"],
  rating: ["rating", "stars", "score"],
  title: ["title", "review_title"],
  body: ["body", "review_body", "content", "review"],
  reviewerName: ["reviewer_name", "author", "name", "reviewer"],
  reviewDate: ["review_date", "date", "created_at"],
  status: ["status", "state"],
  reply: ["reply", "reply_content", "merchant_reply", "store_reply"],
} as const;
type Field = keyof typeof ALIASES;
export type PublishMode = "publish" | "moderate";
export interface ImportOptions { source?: string; publishMode: PublishMode; mapping?: Partial<Record<Field, string>> }

const STATUS_WORDS: Record<string, "published" | "pending" | "rejected" | "hidden"> = {
  published: "published", approved: "published", active: "published", visible: "published", public: "published",
  pending: "pending", unpublished: "pending", awaiting: "pending", new: "pending", draft: "pending",
  rejected: "rejected", declined: "rejected", spam: "rejected",
  hidden: "hidden", archived: "hidden",
};

const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** ISO-8601 date / date-time (UTC unless an offset is given) or "YYYY-MM-DD HH:MM[:SS]". Ambiguous formats are rejected. */
export function parseReviewDate(raw: string, now = Date.now()): Date | null {
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", sec = "00", tz] = m;
  const d0 = new Date(`${y}-${mo}-${d}T${h}:${mi}:${sec}${tz ?? "Z"}`);
  if (Number.isNaN(+d0)) return null;
  // Calendar check (2021-02-30 → invalid, not rolled over).
  const check = new Date(Date.UTC(+y, +mo - 1, +d));
  if (check.getUTCFullYear() !== +y || check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d) return null;
  if (+d0 > now + 86_400_000 || +y < 1990) return null;
  return d0;
}

export function parseRating(raw: string): number | null {
  const m = /^\s*([1-5])(?:\.0+)?\s*$/.exec(raw);
  return m ? Number(m[1]) : null;
}

/** The source product identifiers of a record, as a stable key. Title is kept only to produce suggestions. */
const productRef = (r: { productId: string; handle: string; sku: string; productTitle: string }) =>
  JSON.stringify({ id: r.productId, handle: r.handle, sku: r.sku, title: r.productTitle });

/**
 * Identity when the source has no review id: sha256 over the source product reference, reviewer, date and body
 * (normalised). Deterministic and collision-resistant; scoped by (shop, source) like any source id.
 */
export const fallbackId = (ref: string, reviewer: string, date: Date, body: string) =>
  `h_${sha(JSON.stringify([ref, norm(reviewer).toLowerCase(), date.toISOString(), norm(body)]))}`;
const contentHash = (reviewer: string, body: string) => sha(`${norm(reviewer).toLowerCase()}\n${norm(body).toLowerCase()}`);

type Intent = "published" | "pending" | "rejected" | "hidden";
export interface Analysed {
  record: number; // 1-based data record number in the CSV (header excluded)
  ok: boolean;
  code?: string; // why the record is not imported
  warnings: string[];
  sourceReviewId: string;
  ref: string;
  rating: number; title: string; body: string; reviewerName: string; reviewDate: Date; intent: Intent; reply: string;
}

function pickColumns(header: string[], mapping: ImportOptions["mapping"] = {}) {
  const lower = new Map(header.map((h) => [h.trim().toLowerCase(), h]));
  return Object.fromEntries((Object.keys(ALIASES) as Field[]).map((f) => {
    const explicit = mapping[f];
    const col = explicit ? lower.get(explicit.trim().toLowerCase()) : ALIASES[f].map((a) => lower.get(a)).find(Boolean);
    return [f, col ?? null];
  })) as Record<Field, string | null>;
}

/** Validates every record (pure — no database). Also resolves duplicate source ids deterministically. */
export function analyseRecords(csvText: string, opts: ImportOptions, now = Date.now()) {
  const rows = parseCsv(csvText);
  const header = rows.length ? Object.keys(rows[0]) : [];
  const col = pickColumns(header, opts.mapping);
  if (!col.rating || !col.body || !col.reviewDate) throw new ImportError("missing_columns", "The file needs rating, body and review date columns.");
  if (!col.productId && !col.handle && !col.sku && !col.productTitle) throw new ImportError("missing_columns", "The file needs a product id, handle or SKU column.");
  const get = (r: Record<string, string>, f: Field) => (col[f] ? (r[col[f]!] ?? "") : "");

  const out: Analysed[] = rows.map((r, i) => {
    const warnings: string[] = [];
    const productId = get(r, "productId").trim(), handle = get(r, "handle").trim().toLowerCase(), sku = get(r, "sku").trim(), productTitle = norm(get(r, "productTitle"));
    const ref = productRef({ productId, handle, sku, productTitle });
    const rating = parseRating(get(r, "rating"));
    const body = get(r, "body").replace(/\r\n/g, "\n").trim();
    const reviewDate = parseReviewDate(get(r, "reviewDate"), now);
    let reviewerName = norm(get(r, "reviewerName"));
    if (!reviewerName) { reviewerName = "Anonymous"; warnings.push("missing_reviewer_name"); }
    const title = norm(get(r, "title"));
    const rawStatus = get(r, "status").trim().toLowerCase();
    let intent: Intent;
    if (!rawStatus) intent = opts.publishMode === "publish" ? "published" : "pending";
    else if (STATUS_WORDS[rawStatus]) intent = STATUS_WORDS[rawStatus];
    else { intent = "pending"; warnings.push("unknown_status"); } // never public by accident
    if (intent === "published" && opts.publishMode === "moderate") intent = "pending";
    let code: string | undefined;
    if (!productId && !handle && !sku && !productTitle) code = "missing_product_reference";
    else if (productId && !/^\d{1,20}$/.test(productId)) code = "invalid_product_id";
    else if (rating === null) code = "invalid_rating";
    else if (!reviewDate) code = "invalid_date";
    else if (!body) code = "missing_body";
    else if (body.length > IMPORT_LIMITS.bodyChars) code = "body_too_long";
    else if (title.length > IMPORT_LIMITS.titleChars) code = "title_too_long";
    else if (reviewerName.length > IMPORT_LIMITS.nameChars) code = "name_too_long";
    const rawId = norm(get(r, "sourceReviewId"));
    if (!code && rawId.length > 255) code = "invalid_review_id";
    const sourceReviewId = code ? rawId : rawId || fallbackId(ref, reviewerName, reviewDate!, body);
    return { record: i + 1, ok: !code, code, warnings, sourceReviewId, ref, rating: rating ?? 0, title, body, reviewerName, reviewDate: reviewDate ?? new Date(0), intent, reply: get(r, "reply").trim() };
  });

  // Same source id more than once: identical records → keep one; conflicting → none (never "first wins", which would
  // make the result depend on row order).
  const groups = new Map<string, Analysed[]>();
  for (const a of out) if (a.ok) groups.set(a.sourceReviewId, [...(groups.get(a.sourceReviewId) ?? []), a]);
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const sig = (a: Analysed) => JSON.stringify([a.ref, a.rating, a.title, a.body, a.reviewerName, +a.reviewDate, a.intent, a.reply]);
    if (new Set(g.map(sig)).size === 1) g.slice(1).forEach((a) => { a.ok = false; a.code = "duplicate_source_row"; });
    else g.forEach((a) => { a.ok = false; a.code = "conflicting_duplicate_id"; });
  }
  return { rows: out, columns: col };
}

// ---------------------------------------------------------------------------------------------------------------
// Product matching: Shopify product id → handle → SKU → (merchant-confirmed manual match, checkpoint 8).
// TITLE IS NEVER AN AUTOMATIC MATCHING KEY: exact (trimmed, case-insensitive) title matches are suggestions only.
export type SkuLookup = (skus: string[]) => Promise<Map<string, bigint[]>>; // sku → Shopify product ids (exact sku)

interface Catalogue { id: string; shopifyProductId: bigint; handle: string; title: string; deletedAt: Date | null }
export interface MatchResult { status: "matched" | "unmatched" | "ambiguous"; method: "id" | "handle" | "sku" | "manual" | null; productId: string | null; reason: string | null; candidates: { productId: string; title: string; handle: string; via: string }[] }

export function matchProduct(refJson: string, catalogue: Catalogue[], skuMap: Map<string, bigint[]> | null): MatchResult {
  const ref = JSON.parse(refJson) as { id: string; handle: string; sku: string; title: string };
  const live = catalogue.filter((p) => !p.deletedAt);
  const cand = (p: Catalogue, via: string) => ({ productId: p.id, title: p.title, handle: p.handle, via });
  const found: { method: "id" | "handle" | "sku"; products: Catalogue[] }[] = [];
  const notes: string[] = [];
  if (ref.id) {
    const any = catalogue.filter((p) => p.shopifyProductId === BigInt(ref.id));
    const ok = any.filter((p) => !p.deletedAt);
    if (ok.length) found.push({ method: "id", products: ok });
    else notes.push(any.length ? "product_id_deleted_in_shopify" : "product_id_not_in_catalogue");
  }
  if (ref.handle) {
    const ok = live.filter((p) => p.handle === ref.handle);
    if (ok.length) found.push({ method: "handle", products: ok });
  }
  if (ref.sku) {
    if (!skuMap) notes.push("sku_lookup_unavailable");
    else {
      const ids = new Set(skuMap.get(ref.sku) ?? []);
      const ok = live.filter((p) => ids.has(p.shopifyProductId));
      if (ok.length) found.push({ method: "sku", products: ok });
    }
  }
  const titleKey = ref.title.toLowerCase();
  const titleSuggestions = titleKey ? live.filter((p) => norm(p.title).toLowerCase() === titleKey).map((p) => cand(p, "title")) : [];
  const distinct = [...new Map(found.flatMap((f) => f.products).map((p) => [p.id, p])).values()];

  if (found.some((f) => f.products.length > 1)) {
    return { status: "ambiguous", method: null, productId: null, reason: "identifier_matches_several_products", candidates: [...distinct.map((p) => cand(p, "identifier")), ...titleSuggestions] };
  }
  if (distinct.length > 1) {
    return { status: "ambiguous", method: null, productId: null, reason: "identifiers_disagree", candidates: [...found.map((f) => cand(f.products[0], f.method)), ...titleSuggestions] };
  }
  if (distinct.length === 1 && (notes.includes("product_id_not_in_catalogue") || notes.includes("product_id_deleted_in_shopify"))) {
    // The source names a Shopify product id that is not this live product: identity uncertain → don't guess.
    return { status: "ambiguous", method: null, productId: null, reason: notes[0], candidates: [...distinct.map((p) => cand(p, found[0].method)), ...titleSuggestions] };
  }
  if (distinct.length === 1) return { status: "matched", method: found[0].method, productId: distinct[0].id, reason: null, candidates: [] };
  return { status: "unmatched", method: null, productId: null, reason: notes[0] ?? (titleSuggestions.length ? "title_only_needs_confirmation" : "no_matching_product"), candidates: titleSuggestions };
}

export const SKU_LOOKUP_QUERY = `#graphql
  query ProoflySkuLookup($query: String!, $after: String) {
    productVariants(first: 250, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes { sku product { legacyResourceId } }
    }
  }`;

/** SKU → Shopify product ids through THIS shop's Admin API (exact SKU equality re-checked locally). */
export function skuLookupFromAdmin(graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response>): SkuLookup {
  return async (skus) => {
    const map = new Map<string, bigint[]>();
    const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    for (let i = 0; i < skus.length; i += 20) {
      const batch = skus.slice(i, i + 20);
      let after: string | null = null;
      do {
        const body = (await (await graphql(SKU_LOOKUP_QUERY, { variables: { query: batch.map((s) => `sku:${quote(s)}`).join(" OR "), after } })).json()) as { data?: { productVariants?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { sku: string | null; product: { legacyResourceId: string } }[] } }; errors?: unknown };
        const pv = body.data?.productVariants;
        if (!pv) throw new ImportError("sku_lookup_failed", "Shopify SKU lookup failed.");
        for (const n of pv.nodes) {
          const sku = n.sku?.trim();
          if (sku && batch.includes(sku)) map.set(sku, [...new Set([...(map.get(sku) ?? []), BigInt(n.product.legacyResourceId)])]);
        }
        after = pv.pageInfo.hasNextPage ? pv.pageInfo.endCursor : null;
      } while (after);
    }
    return map;
  };
}

// ---------------------------------------------------------------------------------------------------------------
const ACTIVE = ["queued", "running"];
export const STALE_MS = 10 * 60_000;
const lockImports = (t: Tenant) => t.db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`imports:${t.shopId}`}))`;
const sourceLabel = (s?: string) => {
  const v = (s ?? "csv").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(v)) throw new ImportError("invalid_source", "Invalid source name.");
  return v;
};

/**
 * Creates an import for the AUTHENTICATED shop (shopId comes from the verified session, never from the file or the
 * client). Validates limits, stores the CSV privately, analyses and matches every record; writes no reviews.
 */
export async function createImport(shopId: string, input: { csv: Buffer; options: ImportOptions; actor: string; skuLookup?: SkuLookup | null }) {
  if (!(await isShopActive(shopId))) throw new ImportError("shop_inactive", "This store has uninstalled Proofly.");
  if (input.csv.length > IMPORT_LIMITS.csvBytes) throw new ImportError("csv_too_large", "The CSV file is larger than 50 MB.");
  if (input.csv.includes(0)) throw new ImportError("csv_not_text", "The CSV file is not a UTF-8 text file.");
  const options: ImportOptions = { source: sourceLabel(input.options.source), publishMode: input.options.publishMode === "moderate" ? "moderate" : "publish", mapping: input.options.mapping ?? {} };
  const text = input.csv.toString("utf8");
  const { rows } = analyseRecords(text, options);

  const catalogue = await withTenant(shopId, ({ db }) => db.product.findMany({ where: { shopId }, select: { id: true, shopifyProductId: true, handle: true, title: true, deletedAt: true } }));
  const refs = [...new Set(rows.filter((r) => r.ok).map((r) => r.ref))].sort();
  const skus = [...new Set(refs.map((r) => (JSON.parse(r) as { sku: string }).sku).filter(Boolean))].sort();
  let skuMap: Map<string, bigint[]> | null = null;
  if (skus.length && input.skuLookup) { try { skuMap = await input.skuLookup(skus); } catch { skuMap = null; } }
  const matches = new Map(refs.map((ref) => [ref, matchProduct(ref, catalogue, skuMap)]));
  // Merchant-confirmed manual matches from earlier imports of this source fill in what automatic matching could not
  // resolve (never override an automatic match; the product must still be live).
  const confirmations = await withTenant(shopId, ({ db }) => db.productMatchConfirmation.findMany({ where: { shopId, source: options.source!, sourceProductRef: { in: refs } } }));
  for (const c of confirmations) {
    const m = matches.get(c.sourceProductRef);
    if (m && m.status !== "matched" && catalogue.some((p) => p.id === c.productId && !p.deletedAt)) matches.set(c.sourceProductRef, { status: "matched", method: "manual", productId: c.productId, reason: null, candidates: [] });
  }
  for (const r of rows) if (r.ok && matches.get(r.ref)!.status !== "matched") { r.ok = false; r.code = `product_${matches.get(r.ref)!.status}`; }

  const analysis = summarise(rows, matches);
  const jobId = randomUUID();
  const fileKey = importFileKey(shopId, jobId);
  await storePrivateFile(fileKey, input.csv, "text/csv");

  return withTenant(shopId, async (t) => {
    const { db } = t;
    await lockImports(t);
    const busy = await db.importJob.findFirst({ where: { shopId, status: { in: ACTIVE }, OR: [{ status: "queued" }, { heartbeatAt: { gt: new Date(Date.now() - STALE_MS) } }] } });
    if (busy) throw new ImportError("import_in_progress", "Another import is already in progress for this store.");
    await db.importJob.create({ data: { id: jobId, shopId, source: options.source!, status: "queued", options: options as object, fileKey, analysis: analysis as object, totalRows: rows.length, actor: input.actor } });
    for (const [ref, m] of matches) {
      await db.importProductMatch.create({ data: { shopId, importJobId: jobId, sourceProductRef: ref, status: m.status, method: m.method, productId: m.productId, reason: m.reason, candidates: m.candidates, rows: rows.filter((r) => r.ref === ref).length } });
    }
    await db.auditLog.create({ data: { shopId, actor: input.actor, action: "import.created", entity: "import", entityId: jobId, details: { totalRows: rows.length, validRows: analysis.validRows } } });
    return { jobId, analysis };
  });
}

function summarise(rows: Analysed[], matches: Map<string, MatchResult>) {
  const count = (code: string) => rows.filter((r) => r.code === code).length;
  const problems = rows.filter((r) => !r.ok || r.warnings.length)
    .slice(0, IMPORT_LIMITS.reportProblems)
    .map((r) => ({ record: r.record, code: r.code ?? null, warnings: r.warnings, sourceReviewId: r.sourceReviewId.slice(0, 80) || null }));
  const m = [...matches.values()];
  return {
    totalRows: rows.length,
    validRows: rows.filter((r) => r.ok).length,
    invalidRows: rows.filter((r) => !r.ok && !["duplicate_source_row", "product_unmatched", "product_ambiguous"].includes(r.code!)).length,
    duplicateSourceRows: count("duplicate_source_row"),
    conflictingSourceIds: count("conflicting_duplicate_id"),
    unmatchedRows: count("product_unmatched"),
    ambiguousRows: count("product_ambiguous"),
    products: { matched: m.filter((x) => x.status === "matched").length, unmatched: m.filter((x) => x.status === "unmatched").length, ambiguous: m.filter((x) => x.status === "ambiguous").length },
    warnings: rows.reduce((n, r) => n + r.warnings.length, 0),
    problems,
  };
}

// ---------------------------------------------------------------------------------------------------------------
type Counts = Record<"imported" | "alreadyImported" | "adopted" | "repliesImported" | "importedPending" | "importedHidden" | "importedRejected", number>;
const ZERO: Counts = { imported: 0, alreadyImported: 0, adopted: 0, repliesImported: 0, importedPending: 0, importedHidden: 0, importedRejected: 0 };

/**
 * Runs (or resumes) an import for the authenticated shop, writing reviews into its Shopify store through the review
 * store (app/lib/review-store.server.ts). Safe to call again after any failure: it continues at the job's cursor;
 * a review is never written twice (its handle is derived from source + source review id).
 */
export interface RunOptions {
  batchRows?: number; failAfterBatches?: number; syncRatings?: boolean;
  /** Tests: bulk thresholds, poll sleep, and a simulated crash right after a bulk operation started. */
  bulkMinRows?: number; bulkRows?: number; sleep?: (ms: number) => Promise<void>; crashAfterBulkStart?: boolean;
}

export async function runImport(api: ShopApi, jobId: string, opts: RunOptions = {}) {
  const { shopId } = api;
  const job = await withTenant(shopId, async (t) => {
    const { db } = t;
    await lockImports(t);
    const j = await db.importJob.findFirst({ where: { shopId, id: jobId } });
    if (!j) throw new ImportError("not_found", "Import not found.");
    if (!["queued", "failed", "running"].includes(j.status) || (j.status === "running" && j.heartbeatAt && Date.now() - +j.heartbeatAt < STALE_MS)) {
      throw new ImportError("not_runnable", `This import is ${j.status}.`);
    }
    if (!(await isShopActive(shopId))) throw new ImportError("shop_inactive", "This store has uninstalled Proofly.");
    const other = await db.importJob.findFirst({ where: { shopId, id: { not: jobId }, status: "running", heartbeatAt: { gt: new Date(Date.now() - STALE_MS) } } });
    if (other) throw new ImportError("import_in_progress", "Another import is already running for this store.");
    return db.importJob.update({ where: { id: jobId }, data: { status: "running", error: null, startedAt: j.startedAt ?? new Date(), heartbeatAt: new Date() } });
  });

  try {
    const options = job.options as unknown as ImportOptions;
    const csv = await readPrivate(job.fileKey!);
    if (!csv) throw new ImportError("file_missing", "The uploaded file is no longer available.");
    const { rows } = analyseRecords(csv.toString("utf8"), options, +job.createdAt);
    const { matches, shopifyIds } = await withTenant(shopId, async ({ db }) => ({
      matches: new Map((await db.importProductMatch.findMany({ where: { shopId, importJobId: jobId } })).map((m) => [m.sourceProductRef, m])),
      shopifyIds: new Map((await db.product.findMany({ where: { shopId }, select: { id: true, shopifyProductId: true } })).map((p) => [p.id, p.shopifyProductId])),
    }));
    for (const r of rows) if (r.ok && matches.get(r.ref)?.status !== "matched") { r.ok = false; r.code = "product_not_matched"; }
    // Repeated text inside the file (admin information only — never used for publication).
    const byText = new Map<string, Analysed[]>();
    for (const r of rows) if (r.ok) byText.set(contentHash(r.reviewerName, r.body), [...(byText.get(contentHash(r.reviewerName, r.body)) ?? []), r]);
    const dupFlag = new Map<Analysed, string>();
    for (const g of byText.values()) {
      if (g.length < 2) continue;
      for (const r of g) dupFlag.set(r, g.some((o) => o !== r && o.ref === r.ref) ? "possible_duplicate" : "cross_product_repeat");
    }

    const written: StoredReview[] = []; // what THIS run wrote — finalize must not rely on Shopify's lagging search alone
    let start = job.cursor;
    // A bulk operation started by an earlier, interrupted run: collect its results instead of writing the chunk again.
    const pending = job.bulkOperation as { id: string; nextCursor: number } | null;
    if (pending) { written.push(...await finishBulkWrite(api, jobId, pending.id, pending.nextCursor, opts)); start = pending.nextCursor; }
    const bulkMode = rows.length - start >= (opts.bulkMinRows ?? IMPORT_LIMITS.bulkMinRows);
    const size = opts.batchRows ?? (bulkMode ? opts.bulkRows ?? IMPORT_LIMITS.bulkRows : IMPORT_LIMITS.batchRows);
    let batches = 0;
    for (let cursor = start, end = 0; cursor < rows.length; cursor = end) {
      end = bulkMode ? bulkChunkEnd(rows, cursor, size) : Math.min(cursor + size, rows.length);
      const cancelled = await withTenant(shopId, ({ db }) => db.importJob.findFirst({ where: { shopId, id: jobId }, select: { cancelRequestedAt: true } }));
      if (cancelled?.cancelRequestedAt) {
        await withTenant(shopId, ({ db }) => db.importJob.update({ where: { id: jobId }, data: { status: "cancelled", finishedAt: new Date() } }));
        return getImport(shopId, jobId);
      }
      if (opts.failAfterBatches !== undefined && batches++ >= opts.failAfterBatches) throw new Error("simulated process failure");
      const productOf = (r: Analysed) => shopifyIds.get(matches.get(r.ref)!.productId!)!;
      written.push(...await writeBatch(api, job.source, jobId, rows.slice(cursor, end), productOf, dupFlag, end, bulkMode ? opts : { ...opts, bulkMinRows: Infinity }));
    }
    await finalize(api, jobId, written, opts.sleep);
  } catch (e) {
    const msg = e instanceof ImportError ? e.message : "The import stopped unexpectedly. It can be resumed.";
    console.warn("import failed", jobId, e instanceof Error ? e.message.slice(0, 120) : "");
    await withTenant(shopId, ({ db }) => db.importJob.update({ where: { id: jobId }, data: { status: "failed", error: msg } }));
    throw e;
  }
  if (opts.syncRatings !== false) await syncAfterRatingChange(shopId, api.graphql);
  return getImport(shopId, jobId);
}

/** End of the next bulk chunk: ≤ `rows` rows and safely below Shopify's bulk input limit (≈2× text + 2 KB per row). */
function bulkChunkEnd(rows: Analysed[], cursor: number, max: number) {
  let bytes = 0, end = cursor;
  while (end < rows.length && end - cursor < max) {
    const r = rows[end];
    bytes += 2 * Buffer.byteLength(`${r.title}${r.body}${r.reviewerName}${r.reply ?? ""}`) + 2_048;
    if (bytes > BULK_MAX_BYTES && end > cursor) break;
    end++;
  }
  return end;
}

async function writeBatch(api: ShopApi, source: string, jobId: string, batch: Analysed[], productOf: (r: Analysed) => bigint, dupFlag: Map<Analysed, string>, nextCursor: number, opts: RunOptions) {
  const { shopId } = api;
  const written: StoredReview[] = [];
  const toCreate: { r: Analysed; input: ReviewInput }[] = [];
  const valid = batch.filter((r) => r.ok);
  const job = await withTenant(shopId, ({ db }) => db.importJob.findFirstOrThrow({ where: { shopId, id: jobId }, select: { counts: true } }));
  const c: Counts = { ...ZERO, ...(job.counts as Partial<Counts>) };
  const existing = await findByHandles(api, valid.map((r) => reviewHandle(source, r.sourceReviewId)));
  for (const r of valid) {
    const e = existing.get(reviewHandle(source, r.sourceReviewId));
    if (e) {
      // Already stored: unchanged — unless it belongs to an import that never finished; then this job adopts it so
      // finalize admits it in date order with everything else (no review is ever written twice).
      if (e.importJobId && e.importJobId !== jobId) {
        const prev = await withTenant(shopId, ({ db }) => db.importJob.findFirst({ where: { shopId, id: e.importJobId! }, select: { finalizedAt: true } }));
        if (prev && !prev.finalizedAt) { written.push(await updateReview(api, e, { importJobId: jobId })); c.adopted++; continue; }
      }
      if (e.importJobId !== jobId) c.alreadyImported++;
      continue;
    }
    const flags = [...(r.warnings.includes("unknown_status") ? ["unknown_source_status"] : []), ...(dupFlag.has(r) ? [dupFlag.get(r)!] : [])];
    toCreate.push({ r, input: {
      productId: productOf(r), source, sourceReviewId: r.sourceReviewId, rating: r.rating, title: r.title, body: r.body,
      reviewerName: r.reviewerName, reviewDate: r.reviewDate, status: r.intent,
      // Published rows enter HELD; finalize admits them oldest-first within the plan allowance.
      held: r.intent === "published", reply: r.reply ? r.reply.slice(0, 5_000) : null, replyDate: r.reply ? r.reviewDate : null,
      imported: true, importJobId: jobId, flags,
    } });
  }
  if (toCreate.length >= (opts.bulkMinRows ?? IMPORT_LIMITS.bulkMinRows)) {
    // One Shopify bulk operation for the chunk. Recorded before waiting, so a crash resumes it (runImport).
    const id = await startBulkCreate(api, toCreate.map((x) => x.input));
    await withTenant(shopId, ({ db }) => db.importJob.update({ where: { id: jobId }, data: { bulkOperation: { id, nextCursor }, counts: c, heartbeatAt: new Date() } }));
    if (opts.crashAfterBulkStart) throw new Error("simulated process failure");
    return [...written, ...await finishBulkWrite(api, jobId, id, nextCursor, opts)];
  }
  for (const { r, input } of toCreate) {
    const created = await createReview(api, input);
    if (!created) { c.alreadyImported++; continue; } // created concurrently
    written.push(created);
    await bumpStats(shopId, null, created);
    count(c, created);
    if (r.reply) c.repliesImported++;
  }
  await withTenant(shopId, ({ db }) => db.importJob.update({ where: { id: jobId }, data: { cursor: nextCursor, counts: c, heartbeatAt: new Date() } }));
  return written;
}

function count(c: Counts, created: StoredReview) {
  c.imported++;
  if (created.status === "pending") c.importedPending++;
  if (created.status === "hidden") c.importedHidden++;
  if (created.status === "rejected") c.importedRejected++;
}

/**
 * Collects a bulk create's results and moves the job past its chunk. Rows Shopify rejected (other than "already
 * exists") stop the import before the cursor moves, so resuming writes them again (creation never duplicates).
 */
async function finishBulkWrite(api: ShopApi, jobId: string, bulkId: string, nextCursor: number, opts: RunOptions) {
  const { shopId } = api;
  const heartbeat = async () => { await withTenant(shopId, ({ db }) => db.importJob.update({ where: { id: jobId }, data: { heartbeatAt: new Date() } })); };
  const res = await finishBulkCreate(api, bulkId, { sleep: opts.sleep, onPoll: heartbeat });
  await bumpStatsMany(shopId, res.created.map((r) => [null, r]));
  await withTenant(shopId, async ({ db }) => {
    const job = await db.importJob.findFirstOrThrow({ where: { shopId, id: jobId }, select: { counts: true } });
    const c: Counts = { ...ZERO, ...(job.counts as Partial<Counts>) };
    for (const r of res.created) { count(c, r); if (r.reply) c.repliesImported++; }
    c.alreadyImported += res.taken;
    await db.importJob.update({ where: { id: jobId }, data: { counts: c, bulkOperation: Prisma.DbNull, heartbeatAt: new Date(), ...(res.failed ? {} : { cursor: nextCursor }) } });
  });
  if (res.failed) throw new ImportError("bulk_rows_failed", `Shopify couldn't store ${res.failed} review${res.failed === 1 ? "" : "s"}. Resume the import to retry them.`);
  return res.created;
}

async function finalize(api: ShopApi, jobId: string, written: StoredReview[], sleep?: (ms: number) => Promise<void>) {
  const { shopId } = api;
  const job = await withTenant(shopId, ({ db }) => db.importJob.findFirstOrThrow({ where: { shopId, id: jobId } }));
  // The job's reviews: what this run wrote (exact) plus what a search finds (earlier, interrupted runs of the job).
  // Shopify's metaobject search lags writes by seconds, so the search alone would miss this run's latest reviews.
  const mine = new Map<string, StoredReview>();
  for await (const r of scanReviews(api, { importJobId: jobId })) mine.set(r.id, r);
  for (const r of written) mine.set(r.id, r);
  // 1. Admission across the WHOLE job, date order only (entitlements), so the result never depends on row order.
  const admitted = await releaseEligibleReviews(api, { reviews: [...mine.values()].filter((r) => r.status === "published" && r.held), actor: job.actor ?? "import", known: [...mine.values()], sleep });
  // 2. Outcome + aggregates through the one aggregate path (the released reviews were re-read under the lock).
  for (const r of admitted.reviews) mine.set(r.id, r);
  let published = 0, planLimited = 0, pending = 0, replies = 0;
  const products = new Set<bigint>();
  for (const r of mine.values()) {
    products.add(r.productId);
    if (r.status === "published") { if (r.held) planLimited++; else published++; }
    if (r.status === "pending") pending++;
    if (r.reply) replies++;
  }
  await recomputeProducts(api, products, [...mine.values()]);
  await withTenant(shopId, async (t) => {
    const repliesVisible = (await can(t, "replies")) ? replies : 0;
    const c = { ...ZERO, ...(job.counts as Partial<Counts>), published, planLimited, awaitingModeration: pending, repliesVisible, repliesSuppressed: replies - repliesVisible };
    const a = job.analysis as { validRows: number; totalRows: number; warnings: number };
    const warnings = a.validRows < a.totalRows || a.warnings > 0;
    await t.db.importJob.update({ where: { id: jobId }, data: { status: warnings ? "completed_with_warnings" : "completed", counts: c, finalizedAt: new Date(), finishedAt: new Date(), heartbeatAt: new Date() } });
    await t.db.auditLog.create({ data: { shopId, actor: job.actor ?? "import", action: "import.finished", entity: "import", entityId: jobId, details: { imported: c.imported, published, planLimited } } });
  });
}

/** Cancels an import of the authenticated shop (another shop's job id is "not found"). Imported rows are kept. */
export async function cancelImport(shopId: string, jobId: string, actor: string) {
  return withTenant(shopId, async ({ db }) => {
    const j = await db.importJob.findFirst({ where: { shopId, id: jobId } });
    if (!j) throw new ImportError("not_found", "Import not found.");
    if (j.status === "queued" || j.status === "failed") await db.importJob.update({ where: { id: jobId }, data: { status: "cancelled", cancelRequestedAt: new Date(), finishedAt: new Date() } });
    else if (j.status === "running") await db.importJob.update({ where: { id: jobId }, data: { cancelRequestedAt: new Date() } });
    else throw new ImportError("not_cancellable", `This import is ${j.status}.`);
    await db.auditLog.create({ data: { shopId, actor, action: "import.cancel_requested", entity: "import", entityId: jobId } });
    return true;
  });
}

/** Merchant-visible summary of one import (RLS-scoped: another shop's job is simply not found). */
export async function getImport(shopId: string, jobId: string) {
  return withTenant(shopId, async ({ db }) => {
    const j = await db.importJob.findFirst({ where: { shopId, id: jobId }, include: { matches: { orderBy: { sourceProductRef: "asc" } } } });
    if (!j) return null;
    return {
      id: j.id, status: j.status, source: j.source, createdAt: j.createdAt, finishedAt: j.finishedAt, error: j.error,
      totalRows: j.totalRows, processedRows: j.cursor, analysis: j.analysis, counts: j.counts, filesDeletedAt: j.filesDeletedAt,
      stalled: j.status === "running" && (!j.heartbeatAt || Date.now() - +j.heartbeatAt > STALE_MS), // worker stopped: resumable now
      matches: j.matches.map((m) => ({ ref: JSON.parse(m.sourceProductRef), status: m.status, method: m.method, productId: m.productId, reason: m.reason, candidates: m.candidates, rows: m.rows })),
    };
  });
}

export const listImports = (shopId: string) =>
  withTenant(shopId, ({ db }) => db.importJob.findMany({ where: { shopId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, status: true, source: true, createdAt: true, finishedAt: true, totalRows: true, cursor: true, counts: true, analysis: true, error: true } }));

// ---------------------------------------------------------------------------------------------------------------
// Guided import (checkpoint 8): manual matching, re-import of newly matched rows, problem report.

/** Merchant-facing explanations for every code the importer reports. */
export const EXPLAIN: Record<string, string> = {
  missing_product_reference: "No product id, handle or SKU — add one so the review can be matched to a product.",
  invalid_product_id: "The product id is not a Shopify product id (digits only).",
  invalid_rating: "The rating must be a whole number from 1 to 5.",
  invalid_date: "The date is missing, in the future, or in an unclear format. Use YYYY-MM-DD (optionally with a time).",
  missing_body: "The review text is empty.",
  body_too_long: "The review text is longer than 20,000 characters.",
  title_too_long: "The review title is longer than 255 characters.",
  name_too_long: "The reviewer name is longer than 255 characters.",
  invalid_review_id: "The review id is longer than 255 characters.",
  duplicate_source_row: "This exact review appears more than once in the file; it was imported once.",
  conflicting_duplicate_id: "The same review id appears more than once with different content; none of those rows were imported.",
  product_unmatched: "No product in your store matches this row. Match it manually below, or fix the product reference.",
  product_ambiguous: "The product reference could point to more than one product. Choose the right one manually.",
  product_not_matched: "The product for this row was not matched.",
  missing_reviewer_name: "No reviewer name — shown as “Anonymous”.",
  unknown_status: "The status was not recognised, so the review was held for moderation.",
  title_only_needs_confirmation: "Only the product title matched. Titles are never matched automatically — please confirm the product.",
  identifier_matches_several_products: "This identifier belongs to several products. Choose the right one.",
  identifiers_disagree: "The product id, handle and SKU point to different products. Choose the right one.",
  product_id_not_in_catalogue: "That Shopify product id is not in your store's product list.",
  product_id_deleted_in_shopify: "That product has been deleted in Shopify.",
  sku_lookup_unavailable: "SKUs could not be checked with Shopify. Try again later or use product ids or handles.",
  no_matching_product: "No product in your store matches this reference.",
  skipped_by_merchant: "You chose to skip these reviews.",
};
export const explain = (code: string) => EXPLAIN[code] ?? code;

/**
 * The merchant explicitly matches (or skips) an unresolved source product. The product must be a live product of the
 * AUTHENTICATED shop — a client-supplied id of another shop, a deleted product or garbage is refused. Saved on the job
 * and as a shop-level confirmation re-used by later imports of the same source. Automatic matches cannot be overridden.
 */
export async function resolveProductMatch(shopId: string, jobId: string, sourceProductRef: string, productId: string | null, actor: string) {
  return withTenant(shopId, async ({ db }) => {
    const job = await db.importJob.findFirst({ where: { shopId, id: jobId } });
    if (!job) throw new ImportError("not_found", "Import not found.");
    const match = await db.importProductMatch.findFirst({ where: { shopId, importJobId: jobId, sourceProductRef } });
    if (!match) throw new ImportError("not_found", "That product reference is not part of this import.");
    if (match.status === "matched" && match.method !== "manual") throw new ImportError("already_matched", "This product was matched automatically.");
    if (productId === null) {
      await db.importProductMatch.update({ where: { id: match.id }, data: { status: "unmatched", method: null, productId: null, reason: "skipped_by_merchant" } });
      await db.auditLog.create({ data: { shopId, actor, action: "import.match_skipped", entity: "import", entityId: jobId } });
      return null;
    }
    const product = typeof productId === "string" && /^[0-9a-f-]{36}$/.test(productId) ? await db.product.findFirst({ where: { shopId, id: productId, deletedAt: null } }) : null;
    if (!product) throw new ImportError("invalid_product", "Choose one of your store's products.");
    await db.importProductMatch.update({ where: { id: match.id }, data: { status: "matched", method: "manual", productId: product.id, reason: null } });
    await db.productMatchConfirmation.upsert({
      where: { shopId_source_sourceProductRef: { shopId, source: job.source, sourceProductRef } },
      create: { shopId, source: job.source, sourceProductRef, productId: product.id, actor },
      update: { productId: product.id, actor },
    });
    await db.auditLog.create({ data: { shopId, actor, action: "import.match_confirmed", entity: "import", entityId: jobId, details: { productId: product.id } } });
    return product;
  });
}

/** Re-computes a queued job's analysis after manual matching (so counts and the Start button reflect it). */
export async function refreshAnalysis(shopId: string, jobId: string) {
  const job = await withTenant(shopId, ({ db }) => db.importJob.findFirst({ where: { shopId, id: jobId } }));
  if (!job?.fileKey) return null;
  const csv = await readPrivate(job.fileKey);
  if (!csv) return null;
  const { rows } = analyseRecords(csv.toString("utf8"), job.options as unknown as ImportOptions, +job.createdAt);
  const stored = await withTenant(shopId, ({ db }) => db.importProductMatch.findMany({ where: { shopId, importJobId: jobId } }));
  const matches = new Map(stored.map((m) => [m.sourceProductRef, { status: m.status as MatchResult["status"], method: m.method as MatchResult["method"], productId: m.productId, reason: m.reason, candidates: m.candidates as MatchResult["candidates"] }]));
  for (const r of rows) if (r.ok && matches.get(r.ref)?.status !== "matched") { r.ok = false; r.code = `product_${matches.get(r.ref)?.status === "ambiguous" ? "ambiguous" : "unmatched"}`; }
  const analysis = summarise(rows, matches);
  await withTenant(shopId, ({ db }) => db.importJob.update({ where: { id: jobId }, data: { analysis: analysis as object } }));
  return analysis;
}

/**
 * After an import finished, newly confirmed matches are imported by a NEW import of the same stored file: rows already
 * imported are skipped (idempotent), the newly matched ones are written and admitted by date order.
 */
export async function reimportFromJob(shopId: string, jobId: string, actor: string, skuLookup: SkuLookup | null = null) {
  const job = await withTenant(shopId, ({ db }) => db.importJob.findFirst({ where: { shopId, id: jobId } }));
  if (!job) throw new ImportError("not_found", "Import not found.");
  const csv = job.fileKey ? await readPrivate(job.fileKey) : null;
  if (!csv) throw new ImportError("file_missing", "The original file is no longer kept (import files are deleted 30 days after an import finishes). Upload it again — rows already imported are skipped.");
  return createImport(shopId, { csv, options: job.options as unknown as ImportOptions, actor, skuLookup });
}

/** Every row that was not (fully) imported, with a plain-English reason — as CSV. Never includes review text. */
export async function importProblemReport(shopId: string, jobId: string) {
  const job = await withTenant(shopId, ({ db }) => db.importJob.findFirst({ where: { shopId, id: jobId } }));
  if (!job?.fileKey) return null;
  const csv = await readPrivate(job.fileKey);
  if (!csv) return null;
  const { rows } = analyseRecords(csv.toString("utf8"), job.options as unknown as ImportOptions, +job.createdAt);
  const matches = new Map((await withTenant(shopId, ({ db }) => db.importProductMatch.findMany({ where: { shopId, importJobId: jobId } }))).map((m) => [m.sourceProductRef, m]));
  const q = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const lines = [["record", "review_id", "product_id", "product_handle", "sku", "product_title", "problem", "explanation"].join(",")];
  for (const r of rows) {
    const ref = JSON.parse(r.ref) as { id: string; handle: string; sku: string; title: string };
    const m = matches.get(r.ref);
    const problems: string[] = [];
    if (!r.ok && r.code) problems.push(r.code);
    else if (m && m.status !== "matched") problems.push(m.reason ?? `product_${m.status}`);
    problems.push(...r.warnings);
    for (const p of [...new Set(problems)]) lines.push([String(r.record), r.sourceReviewId.startsWith("h_") ? "" : r.sourceReviewId, ref.id, ref.handle, ref.sku, ref.title, p, explain(p)].map(q).join(","));
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------------------------
/** Typed-row convenience (tests, internal callers): rows → template CSV → the same engine (one import mechanism). */
export interface ImportRow { sourceReviewId: string; shopifyProductId: bigint; rating: number; title?: string; body: string; reviewerName: string; reviewDate: Date; status?: Intent; reply?: string }
export async function importReviews(api: ShopApi, input: { source: string; rows: ImportRow[]; actor: string; publishMode?: PublishMode; run?: RunOptions }) {
  const q = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const csv = ["review_id,product_id,rating,title,body,reviewer_name,review_date,status,reply",
    ...input.rows.map((r) => [r.sourceReviewId, String(r.shopifyProductId), String(r.rating), r.title ?? "", r.body, r.reviewerName, r.reviewDate.toISOString(), r.status ?? "", r.reply ?? ""].map(q).join(","))].join("\n");
  const { jobId } = await createImport(api.shopId, { csv: Buffer.from(csv), options: { source: input.source, publishMode: input.publishMode ?? "publish" }, actor: input.actor });
  const done = await runImport(api, jobId, input.run);
  const a = done!.analysis as { totalRows: number; invalidRows: number; duplicateSourceRows: number; conflictingSourceIds: number; unmatchedRows: number; ambiguousRows: number };
  const c = done!.counts as Counts & { published: number; planLimited: number; awaitingModeration: number };
  return {
    jobId, received: a.totalRows, imported: c.imported, published: c.published, planLimited: c.planLimited,
    notPublished: c.importedPending + c.importedHidden + c.importedRejected, duplicates: c.alreadyImported + a.duplicateSourceRows,
    unmatchedProduct: a.unmatchedRows + a.ambiguousRows, invalid: a.invalidRows,
  };
}
