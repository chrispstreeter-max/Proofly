import { createHash, randomBytes } from "node:crypto";
import prisma from "../db.server";
import { ALLOWED_TYPES, sniffType, storeReviewImage } from "./media.server";

type AdminContext = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> } | undefined;

export const LIMITS = { title: 120, body: 5000, name: 60, email: 254, images: 5, imageBytes: 10 * 1024 * 1024 };

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

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
  const email = str(form.get("email")).toLowerCase();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new SubmitError("rating", "Choose a star rating.");
  if (title.length > LIMITS.title) throw new SubmitError("title", `Keep the title under ${LIMITS.title} characters.`);
  if (body.length < 2) throw new SubmitError("body", "Write a few words about the product.");
  if (body.length > LIMITS.body) throw new SubmitError("body", `Keep the review under ${LIMITS.body} characters.`);
  if (!name || name.length > LIMITS.name) throw new SubmitError("name", "Enter the name to show with your review.");
  if (email && (email.length > LIMITS.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    throw new SubmitError("email", "Enter a valid email or leave it blank.");

  const files = form.getAll("images").filter((f): f is File => typeof f !== "string" && f.size > 0);
  if (files.length > LIMITS.images) throw new SubmitError("images", `Add up to ${LIMITS.images} photos.`);
  const images: Buffer[] = [];
  for (const f of files) {
    if (f.size > LIMITS.imageBytes) throw new SubmitError("images", "Each photo must be under 10 MB.");
    const buf = Buffer.from(await f.arrayBuffer());
    if (!sniffType(buf)) throw new SubmitError("images", `Photos must be ${Object.values(ALLOWED_TYPES).join(", ").toUpperCase()}.`);
    images.push(buf);
  }
  return { rating, title, body, name, email: email || null, images };
}

/** Makes sure we have a product row (FK) for products that had no reviews before. */
export async function ensureProduct(admin: AdminContext, shopifyProductId: bigint) {
  const existing = await prisma.product.findUnique({ where: { shopifyProductId } });
  if (existing) return existing;
  if (!admin) throw new SubmitError("product", "Product not found.", 404);
  const res = await admin.graphql(
    `query($id: ID!) { product(id: $id) { handle title status featuredMedia { preview { image { url } } } } }`,
    { variables: { id: `gid://shopify/Product/${shopifyProductId}` } },
  );
  const p = (await res.json()).data?.product;
  if (!p || p.status !== "ACTIVE") throw new SubmitError("product", "Product not found.", 404);
  return prisma.product.create({
    data: {
      shopifyProductId, handle: p.handle, title: p.title, status: "active",
      image: p.featuredMedia?.preview?.image?.url ?? null,
    },
  });
}

/**
 * Verified purchase for a logged-in shopper (customer id comes from Shopify's signed app-proxy params).
 * ponytail: checks the customer's 25 most recent orders; widen if long-tail purchases need verifying.
 */
export async function findPurchase(admin: AdminContext, customerId: bigint, productId: bigint): Promise<bigint | null> {
  if (!admin) return null;
  const res = await admin.graphql(
    `query($id: ID!) { customer(id: $id) { orders(first: 25, sortKey: PROCESSED_AT, reverse: true) {
      nodes { legacyResourceId cancelledAt lineItems(first: 30) { nodes { product { legacyResourceId } } } } } } }`,
    { variables: { id: `gid://shopify/Customer/${customerId}` } },
  );
  type Order = { legacyResourceId: string; cancelledAt: string | null; lineItems: { nodes: { product: { legacyResourceId: string } | null }[] } };
  const orders: Order[] = (await res.json()).data?.customer?.orders?.nodes ?? [];
  const hit = orders.find(
    (o) => !o.cancelledAt && o.lineItems.nodes.some((li) => li.product?.legacyResourceId === productId.toString()),
  );
  return hit ? BigInt(hit.legacyResourceId) : null;
}

export async function openRequests(token: string) {
  return prisma.reviewRequest.findMany({
    where: { tokenHash: hashToken(token), completedAt: null, expiresAt: { gt: new Date() } },
  });
}

export async function createReview(input: {
  productId: bigint;
  data: Awaited<ReturnType<typeof parseSubmission>>;
  verified: boolean;
  source: "storefront" | "request";
  customerId?: bigint | null;
  orderId?: bigint | null;
  requestId?: string;
  ipHash: string;
}) {
  const { data } = input;
  const review = await prisma.$transaction(async (tx) => {
    if (input.requestId) {
      // Single use: only succeeds if the request is still open (guards against double submits).
      const done = await tx.reviewRequest.updateMany({
        where: { id: input.requestId, completedAt: null },
        data: { completedAt: new Date() },
      });
      if (done.count !== 1) throw new SubmitError("form", "This review link has already been used.", 409);
    }
    const r = await tx.review.create({
      data: {
        sourceReviewId: `cc_${randomBytes(9).toString("hex")}`,
        shopifyProductId: input.productId,
        rating: data.rating,
        title: data.title,
        body: data.body,
        reviewerName: data.name,
        reviewerEmail: data.email,
        reviewDate: new Date(),
        status: "pending", // every new review is moderated before publishing
        verifiedPurchase: input.verified,
        imported: false,
        source: input.source,
        shopifyCustomerId: input.customerId ?? null,
        shopifyOrderId: input.orderId ?? null,
        submitterIpHash: input.ipHash,
      },
    });
    if (input.requestId) await tx.reviewRequest.update({ where: { id: input.requestId }, data: { reviewId: r.id } });
    return r;
  });
  for (const [position, buf] of data.images.entries()) {
    const stored = await storeReviewImage(review.id, buf);
    await prisma.reviewImage.create({ data: { reviewId: review.id, position, originalFilename: `upload-${position + 1}`, ...stored } });
  }
  await prisma.auditLog.create({
    data: { actor: "storefront", action: "review.submitted", entity: "review", entityId: review.id, details: { verified: input.verified, images: data.images.length } },
  });
  return review;
}
