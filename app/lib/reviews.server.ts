import type { Prisma } from "@prisma/client";
import { publicUrl } from "./media.server";
import type { Tenant } from "./tenant.server";

export const PAGE_SIZE = 10;
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
  return db.product.findFirst({ where: { shopId, shopifyProductId } });
}

const EMPTY_SUMMARY = { count: 0, average: 0, distribution: [0, 0, 0, 0, 0], withPhotos: 0 };

export async function productSummary({ db, shopId }: Tenant, productId: string | null) {
  if (!productId) return EMPTY_SUMMARY;
  const p = await db.product.findFirst({ where: { shopId, id: productId } });
  if (!p) return EMPTY_SUMMARY;
  const withPhotos = await db.review.count({ where: { shopId, productId, status: "published", images: { some: {} } } });
  return {
    count: p.reviewCount,
    average: Number(p.averageRating),
    distribution: [p.rating1, p.rating2, p.rating3, p.rating4, p.rating5],
    withPhotos,
  };
}

/** Public, allow-listed shape. Never add email, customer/order IDs or IP hashes here. */
type ReviewRow = Prisma.ReviewGetPayload<{ include: { images: true; reply: true } }>;
export function serializeReview(r: ReviewRow) {
  return {
    id: r.id,
    rating: r.rating,
    title: r.title,
    body: r.body,
    name: r.reviewerName,
    date: r.reviewDate.toISOString().slice(0, 10),
    verified: r.verifiedPurchase,
    images: r.images
      .sort((a, b) => a.position - b.position)
      .map((i) => ({ thumb: publicUrl(i.thumbKey), large: publicUrl(i.largeKey), w: i.width, h: i.height })),
    reply: r.reply ? { body: r.reply.reply, date: r.reply.createdAt.toISOString().slice(0, 10) } : null,
  };
}

export async function listReviews(
  { db, shopId }: Tenant,
  productId: string | null,
  { sort, rating, photos, page }: ReturnType<typeof parseListParams>,
) {
  if (!productId) return { reviews: [], page, hasMore: false }; // unknown and other-shop products: identical response
  const where: Prisma.ReviewWhereInput = {
    shopId,
    productId,
    status: "published",
    ...(rating ? { rating } : {}),
    ...(photos ? { images: { some: {} } } : {}),
  };
  const rows = await db.review.findMany({
    where,
    orderBy: ORDER[sort],
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE + 1, // one extra row tells us whether there is another page
    include: { images: true, reply: true },
  });
  return { reviews: rows.slice(0, PAGE_SIZE).map(serializeReview), page, hasMore: rows.length > PAGE_SIZE };
}

/** Batched card ratings for this shop: { "<shopifyProductId>": { c, a } } — ids of other shops are simply absent. */
export async function ratingsFor({ db, shopId }: Tenant, ids: bigint[]) {
  const rows = await db.product.findMany({
    where: { shopId, shopifyProductId: { in: ids }, reviewCount: { gt: 0 } },
    select: { shopifyProductId: true, reviewCount: true, averageRating: true },
  });
  return Object.fromEntries(rows.map((r) => [r.shopifyProductId.toString(), { c: r.reviewCount, a: Number(r.averageRating) }]));
}

/** Parses "1,2,3" into ≤limit valid Shopify numeric IDs. */
export function parseIds(raw: string | null, limit = 100): bigint[] {
  return [...new Set((raw ?? "").split(",").filter((s) => /^\d{1,20}$/.test(s)))].slice(0, limit).map(BigInt);
}
