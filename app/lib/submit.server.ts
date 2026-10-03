import { randomBytes } from "node:crypto";
import { ALLOWED_TYPES, sniffType, storeReviewImage } from "./media.server";
import type { Tenant } from "./tenant.server";

type AdminContext = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> } | undefined;

export const LIMITS = { title: 120, body: 5000, name: 60, images: 5, imageBytes: 10 * 1024 * 1024 };

export class SubmitError extends Error {
  constructor(public field: string, message: string, public status = 400) { super(message); }
}

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim() : "");

/** Validates the untrusted form; throws SubmitError with a customer-facing message. */
export async function parseSubmission(form: FormData) {
  if (str(form.get("website"))) throw new SubmitError("form", "Submission rejected."); // honeypot
  const rating = Number(str(form.get("rating")));
  const title = str(form.get("title"));
  const body = str(form.get("body"));
  const name = str(form.get("name"));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new SubmitError("rating", "Choose a star rating.");
  if (title.length > LIMITS.title) throw new SubmitError("title", `Keep the title under ${LIMITS.title} characters.`);
  if (body.length < 2) throw new SubmitError("body", "Write a few words about the product.");
  if (body.length > LIMITS.body) throw new SubmitError("body", `Keep the review under ${LIMITS.body} characters.`);
  if (!name || name.length > LIMITS.name) throw new SubmitError("name", "Enter the name to show with your review.");

  const files = form.getAll("images").filter((f): f is File => typeof f !== "string" && f.size > 0);
  if (files.length > LIMITS.images) throw new SubmitError("images", `Add up to ${LIMITS.images} photos.`);
  const images: Buffer[] = [];
  for (const f of files) {
    if (f.size > LIMITS.imageBytes) throw new SubmitError("images", "Each photo must be under 10 MB.");
    const buf = Buffer.from(await f.arrayBuffer());
    if (!sniffType(buf)) throw new SubmitError("images", `Photos must be ${Object.values(ALLOWED_TYPES).join(", ").toUpperCase()}.`);
    images.push(buf);
  }
  return { rating, title, body, name, images }; // no email: V1 stores no reviewer contact data
}

export const PRODUCT_LOOKUP_QUERY = `#graphql
  query ProoflyProductLookup($id: ID!) { product(id: $id) { handle title status updatedAt } }`;

/**
 * Makes sure this shop has a product row (FK) for a product that had no reviews before. The product is looked up
 * through the Admin API of the SAME authenticated shop, so another shop's product id can never be attached.
 */
export async function ensureProduct({ db, shopId }: Tenant, admin: AdminContext, shopifyProductId: bigint) {
  const existing = await db.product.findFirst({ where: { shopId, shopifyProductId, deletedAt: null } });
  if (existing) return existing;
  if (!admin) throw new SubmitError("product", "Product not found.", 404);
  const res = await admin.graphql(PRODUCT_LOOKUP_QUERY, { variables: { id: `gid://shopify/Product/${shopifyProductId}` } });
  const p = (await res.json()).data?.product;
  if (!p || p.status !== "ACTIVE") throw new SubmitError("product", "Product not found.", 404);
  return db.product.create({
    data: { shopId, shopifyProductId, handle: p.handle.toLowerCase(), title: p.title, status: "active", shopifyUpdatedAt: new Date(p.updatedAt), lastSeenAt: new Date() },
  });
}

export async function createReview(
  t: Tenant,
  input: {
    productId: string; // internal products.id of this shop
    data: Awaited<ReturnType<typeof parseSubmission>>;
    source: "storefront";
    ipHash: string;
  },
) {
  const { db, shopId } = t;
  const { data } = input;
  const review = await db.review.create({
    data: {
      shopId,
      productId: input.productId,
      sourceReviewId: `pf_${randomBytes(9).toString("hex")}`,
      rating: data.rating,
      title: data.title,
      body: data.body,
      reviewerName: data.name,
      reviewDate: new Date(),
      status: "pending", // every new review is moderated before publishing
      verifiedPurchase: false, // V1 has no order access; verified purchase is V1.1
      imported: false,
      source: input.source,
      submitterIpHash: input.ipHash,
    },
  });
  for (const [position, buf] of data.images.entries()) {
    const stored = await storeReviewImage(shopId, review.id, buf);
    await db.reviewImage.create({ data: { shopId, reviewId: review.id, position, originalFilename: `upload-${position + 1}`, ...stored } });
  }
  await db.auditLog.create({
    data: { shopId, actor: "storefront", action: "review.submitted", entity: "review", entityId: review.id, details: { images: data.images.length } },
  });
  return review;
}
