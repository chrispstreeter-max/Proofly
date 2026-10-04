import { pageReviews, scanReviews, type ShopApi, type StoredReview } from "./review-store.server";
import type { Tenant } from "./tenant.server";

export const PAGE_SIZE = 10;
/** Rating sorts read the product's public reviews in memory; beyond this many only the newest are considered. */
export const RATING_SORT_LIMIT = 2_000;
export type Sort = "recent" | "highest" | "lowest";

export function parseListParams(url: URL) {
  const sort = (["recent", "highest", "lowest"] as const).find((s) => s === url.searchParams.get("sort")) ?? "recent";
  const ratingRaw = Number(url.searchParams.get("rating"));
  const rating = Number.isInteger(ratingRaw) && ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : undefined;
  const page = Math.min(Math.max(1, Number(url.searchParams.get("page")) || 1), 200);
  return { sort, rating, page };
}

/** This shop's live product for a Shopify product id, or null (unknown and other-shop products look the same). */
export function findProduct({ db, shopId }: Tenant, shopifyProductId: bigint) {
  return db.product.findFirst({ where: { shopId, shopifyProductId, deletedAt: null } });
}

const EMPTY_SUMMARY = { count: 0, average: 0, distribution: [0, 0, 0, 0, 0] };

/** Summary from the canonical aggregate (app/lib/aggregates.server.ts), cached per product. */
export async function productSummary({ db, shopId }: Tenant, shopifyProductId: bigint | null) {
  if (!shopifyProductId) return EMPTY_SUMMARY;
  const p = await db.product.findFirst({ where: { shopId, shopifyProductId, deletedAt: null } });
  if (!p) return EMPTY_SUMMARY;
  return { count: p.reviewCount, average: Number(p.averageRating), distribution: [p.rating1, p.rating2, p.rating3, p.rating4, p.rating5] };
}

/**
 * Public, allow-listed shape. Never add ids, handles, status, flags, source fields or anything private here.
 * `replies`: whether the shop's CURRENT plan includes Replies (entitlements `can(t, "replies")`, decided server-side).
 * Without it a stored reply is omitted exactly as if the review had none (`reply: null`); it is never deleted.
 */
export function serializeReview(r: StoredReview, { replies }: { replies: boolean }) {
  return {
    rating: r.rating,
    title: r.title,
    body: r.body,
    name: r.reviewerName,
    date: r.reviewDate.toISOString().slice(0, 10),
    verified: r.verified,
    reply: replies && r.reply ? { body: r.reply, date: (r.replyDate ?? r.reviewDate).toISOString().slice(0, 10) } : null,
  };
}

/**
 * Public reviews of one of this shop's live products. `isPublic` is re-checked on every entry (the Shopify filter
 * is an index, not a guarantee: an entry edited outside Proofly is never shown).
 */
export async function listReviews(api: ShopApi, shopifyProductId: bigint | null, { sort, rating, page }: ReturnType<typeof parseListParams>, visibility: { replies: boolean }) {
  if (!shopifyProductId) return { reviews: [], page, hasMore: false }; // unknown and other-shop products: identical response
  const q = { productIds: [shopifyProductId], isPublic: true, ...(rating ? { rating } : {}) };
  const want = page * PAGE_SIZE + 1; // one extra row tells us whether there is another page
  let rows: StoredReview[] = [];
  if (sort === "recent") {
    let after: string | null = null;
    while (rows.length < want) {
      const p: Awaited<ReturnType<typeof pageReviews>> = await pageReviews(api, q, { first: Math.min(250, want - rows.length + 5), after });
      rows.push(...p.reviews.filter((r) => r.isPublic));
      if (!(after = p.next)) break;
    }
  } else {
    for await (const r of scanReviews(api, q)) { if (r.isPublic) rows.push(r); if (rows.length >= RATING_SORT_LIMIT) break; }
    const dir = sort === "highest" ? -1 : 1;
    rows = rows.sort((a, b) => dir * (a.rating - b.rating) || +b.reviewDate - +a.reviewDate || (a.handle < b.handle ? 1 : -1));
  }
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return { reviews: slice.map((r) => serializeReview(r, visibility)), page, hasMore: rows.length > page * PAGE_SIZE };
}

/**
 * Batched card ratings for this shop by product handle: { "<handle>": [average, count] }. Handles of other shops,
 * unknown handles and products without public reviews are simply absent. Reads the aggregate cache.
 */
export async function ratingsByHandle({ db, shopId }: Tenant, handles: string[]) {
  const rows = await db.product.findMany({
    where: { shopId, handle: { in: handles }, reviewCount: { gt: 0 }, deletedAt: null }, // a recreated product's handle never resolves to the old one
    select: { handle: true, reviewCount: true, averageRating: true },
  });
  return Object.fromEntries(rows.map((r) => [r.handle, [Number(r.averageRating), r.reviewCount] as const]));
}

/** Parses "a,b,c" into ≤limit distinct, plausible Shopify product handles (lower-case, no separators/markup). */
export function parseHandles(raw: string | null, limit = 100): string[] {
  return [...new Set((raw ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => /^[^\s/?#<>"',]{1,255}$/u.test(h)))].slice(0, limit);
}

/** Parses "1,2,3" into ≤limit valid Shopify numeric IDs. */
export function parseIds(raw: string | null, limit = 100): bigint[] {
  return [...new Set((raw ?? "").split(",").filter((s) => /^\d{1,20}$/.test(s)))].slice(0, limit).map(BigInt);
}
