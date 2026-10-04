import { randomBytes } from "node:crypto";
import { recomputeProduct } from "./aggregates.server";
import { admitReviews, bumpStats } from "./entitlements.server";
import { createReview as storeCreate, type ShopApi } from "./review-store.server";
import { withTenant, type Tenant } from "./tenant.server";

type AdminContext = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> } | undefined;

export const LIMITS = { title: 120, body: 5000, name: 60 };

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

  return { rating, title, body, name }; // no email, no photos: only these fields are ever read from the form
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

export async function createReview(api: ShopApi, input: { shopifyProductId: bigint; data: Awaited<ReturnType<typeof parseSubmission>> }) {
  const { data } = input;
  // Moderation on (default): the review waits for approval. Off: it is published at once, subject to the plan allowance.
  const settings = await withTenant(api.shopId, ({ db, shopId }) => db.shopSettings.findUnique({ where: { shopId }, select: { moderationEnabled: true } }));
  const autoPublish = settings?.moderationEnabled === false;
  const review = await storeCreate(api, {
    productId: input.shopifyProductId, sourceReviewId: `pf_${randomBytes(9).toString("hex")}`, source: "storefront",
    rating: data.rating, title: data.title, body: data.body, reviewerName: data.name, reviewDate: new Date(),
    status: autoPublish ? "published" : "pending", held: autoPublish, // auto-published reviews enter held; admission decides
    verified: false, // V1 has no order access; verified purchase is V1.1
  });
  if (!review) throw new SubmitError("form", "Something went wrong. Please try again.", 500); // random id collision
  await bumpStats(api.shopId, null, review);
  if (autoPublish) {
    await admitReviews(api, [review], "storefront");
    await recomputeProduct(api, input.shopifyProductId);
  }
  await withTenant(api.shopId, ({ db, shopId }) => db.auditLog.create({ data: { shopId, actor: "storefront", action: "review.submitted", entity: "review", entityId: review.id } }));
  return review;
}
