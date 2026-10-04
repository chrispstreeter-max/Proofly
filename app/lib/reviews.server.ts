import type { Prisma } from "@prisma/client";
import { mediaUrl } from "./media.server";
import type { Tenant } from "./tenant.server";

export const PAGE_SIZE = 10;

/**
 * The ONLY definition of "publicly visible": published and not held (pending, rejected, hidden and plan-limited
 * reviews never reach the storefront). Aggregates, metafields, lists and card ratings all use it.
 */
export const PUBLIC_REVIEW = { status: "published", holdReason: null } as const satisfies Prisma.ReviewWhereInput;
/** Only optimised media that is currently servable (not storage-limited / processing / failed). */
export const PUBLIC_MEDIA = { mediaStatus: "published" } as const satisfies Prisma.ReviewImageWhereInput;
export type Sort = "recent" | "highest" | "lowest";

const ORDER: Record<Sort, Prisma.ReviewOrderByWithRelationInput[]> = {
  recent: [{ reviewDate: "desc" }, { id: "desc" }],
  highest: [{ rating: "desc" }, { reviewDate: "desc" }, { id: "desc" }],
  lowest: [{ rating: "asc" }, { reviewDate: "desc" }, { id: "desc" }],
};

export function parseListParams(url: URL) {
  const sort = (["recent", "highest", "lowest"] as const).find((s) => s === url.searchParams.get("sort")) ?? "recent";
  const ratingRaw = Number(url.searchParams.get("rating"));
  const rating = Number.isInteger(ratingRaw) && ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : undefined;
  const photos = url.searchParams.get("photos") === "1";
  const page = Math.min(Math.max(1, Number(url.searchParams.get("page")) || 1), 1000);
  return { sort, rating, photos, page };
}

/** This shop's product for a Shopify product id, or null (unknown and other-shop products look the same). */
export function findProduct({ db, shopId }: Tenant, shopifyProductId: bigint) {
  return db.product.findFirst({ where: { shopId, shopifyProductId, deletedAt: null } });
}

const EMPTY_SUMMARY = { count: 0, average: 0, distribution: [0, 0, 0, 0, 0], withPhotos: 0 };

export async function productSummary({ db, shopId }: Tenant, productId: string | null) {
  if (!productId) return EMPTY_SUMMARY;
  const p = await db.product.findFirst({ where: { shopId, id: productId } });
  if (!p) return EMPTY_SUMMARY;
  return {
    count: p.reviewCount,
    average: Number(p.averageRating),
    distribution: [p.rating1, p.rating2, p.rating3, p.rating4, p.rating5],
    withPhotos: p.photoReviewCount, // from the canonical aggregate (storage-limited photos excluded)
  };
}

/**
 * Public, allow-listed shape. Never add ids, email, customer/order IDs, IP hashes, status or flags here.
 * `replies`: whether the shop's CURRENT plan includes the Replies capability (entitlements.server `can(t, "replies")`,
 * decided server-side). Without it a stored reply — imported, or kept after a downgrade — is omitted exactly as if the
 * review had none (`reply: null`); it is never deleted and reappears when the plan allows.
 */
type ReviewRow = Prisma.ReviewGetPayload<{ include: { images: true; reply: true } }>;
export function serializeReview(r: ReviewRow, { replies }: { replies: boolean }) {
  return {
    rating: r.rating,
    title: r.title,
    body: r.body,
    name: r.reviewerName,
    date: r.reviewDate.toISOString().slice(0, 10),
    verified: r.verifiedPurchase,
    images: r.images
      .filter((i) => i.mediaStatus === "published") // also filtered in the query; never trust a caller's include
      .sort((a, b) => a.position - b.position)
      .map((i) => ({ thumb: mediaUrl(i.publicId, 320), large: mediaUrl(i.publicId, 1600), w: i.width, h: i.height })),
    reply: replies && r.reply ? { body: r.reply.reply, date: r.reply.createdAt.toISOString().slice(0, 10) } : null,
  };
}

export async function listReviews(
  { db, shopId }: Tenant,
  productId: string | null,
  { sort, rating, photos, page }: ReturnType<typeof parseListParams>,
  visibility: { replies: boolean },
) {
  if (!productId) return { reviews: [], page, hasMore: false }; // unknown and other-shop products: identical response
  const where: Prisma.ReviewWhereInput = {
    shopId,
    productId,
    ...PUBLIC_REVIEW,
    ...(rating ? { rating } : {}),
    ...(photos ? { images: { some: PUBLIC_MEDIA } } : {}),
  };
  const rows = await db.review.findMany({
    where,
    orderBy: ORDER[sort],
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE + 1, // one extra row tells us whether there is another page
    include: { images: { where: PUBLIC_MEDIA }, reply: true },
  });
  return { reviews: rows.slice(0, PAGE_SIZE).map((r) => serializeReview(r, visibility)), page, hasMore: rows.length > PAGE_SIZE };
}

/**
 * Batched card ratings for this shop by product handle: { "<handle>": [average, count] }. Handles of other shops,
 * unknown handles and products without public reviews are simply absent. Reads the aggregates (published, not held).
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
