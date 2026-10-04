import { createHash, createHmac } from "node:crypto";
import { STATUSES, type ReviewStatus } from "./review-status";

/**
 * THE review store (docs/SHOPIFY-DATA.md): reviews live in each merchant's Shopify store as entries of the
 * merchant-owned metaobject type `proofly_review`. Every read and write of review data goes through this module.
 *
 *  - Tenant safety is Shopify-native: a ShopApi is the Admin API client of ONE authenticated shop, so it can only ever
 *    reach that shop's entries. Callers obtain it from authenticate.admin / appProxy / unauthenticated.admin(shop).
 *  - The type has NO storefront access: everything public goes through Proofly's own allow-listed responses.
 *  - Merchant-owned data can be edited by the merchant in Shopify admin. Proofly signs the fields it writes
 *    (`integrity`, HMAC keyed from TOKEN_ENCRYPTION_KEY) and treats an entry changed outside Proofly as NOT public
 *    until it is approved again in Proofly (which re-signs it): Proofly only ever displays reviews exactly as it
 *    recorded them. It cannot prevent the edit itself.
 *  - Handles are derived from (source, source review id), so creating the same review twice is impossible
 *    (idempotent imports and retries).
 */
export type GraphqlFn = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
export interface ShopApi { shopId: string; graphql: GraphqlFn }

export const REVIEW_TYPE = "proofly_review";
export { STATUSES, type ReviewStatus };

/** Field definitions. `filter` = admin-filterable (required for `fields.<key>:` queries, verified in Phase 0). */
const FIELDS = [
  { key: "product", name: "Product", type: "product_reference", required: true, filter: true },
  { key: "status", name: "Status", type: "single_line_text_field", required: true, filter: true },
  { key: "held", name: "Held by plan limit", type: "boolean", required: true, filter: true },
  { key: "public", name: "Public", type: "boolean", required: true, filter: true },
  { key: "rating", name: "Rating", type: "number_integer", required: true, filter: true },
  { key: "title", name: "Title", type: "single_line_text_field", required: false, filter: false },
  { key: "body", name: "Review", type: "multi_line_text_field", required: true, filter: false },
  { key: "reviewer_name", name: "Reviewer name", type: "single_line_text_field", required: true, filter: true },
  { key: "review_date", name: "Review date", type: "date_time", required: true, filter: true },
  { key: "source", name: "Source", type: "single_line_text_field", required: true, filter: true },
  { key: "source_review_id", name: "Source review id", type: "single_line_text_field", required: true, filter: false },
  { key: "reply", name: "Reply", type: "multi_line_text_field", required: false, filter: false },
  { key: "reply_date", name: "Reply date", type: "date_time", required: false, filter: false },
  { key: "verified", name: "Verified purchase", type: "boolean", required: false, filter: false },
  { key: "flagged", name: "Flagged", type: "boolean", required: false, filter: true },
  { key: "flags", name: "Flags", type: "json", required: false, filter: false },
  { key: "imported", name: "Imported", type: "boolean", required: false, filter: false },
  { key: "import_job", name: "Import", type: "single_line_text_field", required: false, filter: true },
  { key: "sort_key", name: "Sort key", type: "single_line_text_field", required: true, filter: false },
  { key: "integrity", name: "Proofly signature", type: "single_line_text_field", required: false, filter: false },
] as const;

export interface StoredReview {
  id: string; // metaobject GID — the review id everywhere in Proofly
  handle: string;
  productId: bigint; // Shopify product id
  status: ReviewStatus;
  held: boolean;
  isPublic: boolean;
  rating: number;
  title: string;
  body: string;
  reviewerName: string;
  reviewDate: Date;
  source: string;
  sourceReviewId: string;
  reply: string | null;
  replyDate: Date | null;
  verified: boolean;
  flags: string[];
  imported: boolean;
  importJobId: string | null;
  updatedAt: Date;
  /** The entry was changed outside Proofly (its signed fields no longer match the signature) — never public. */
  editedOutside: boolean;
}

export type ReviewInput = Pick<StoredReview, "productId" | "status" | "held" | "rating" | "title" | "body" | "reviewerName" | "reviewDate" | "source" | "sourceReviewId">
  & Partial<Pick<StoredReview, "reply" | "replyDate" | "verified" | "flags" | "imported" | "importJobId">>;

export class StoreError extends Error {}

const productGid = (id: bigint) => `gid://shopify/Product/${id}`;
export const reviewHandle = (source: string, sourceReviewId: string) => `r-${createHash("sha256").update(`${source}\n${sourceReviewId}`).digest("hex").slice(0, 40)}`;
const isPublicState = (status: ReviewStatus, held: boolean) => status === "published" && !held;

/** HMAC over the fields Proofly owns. A merchant edit in Shopify admin changes the content but cannot re-sign it. */
function sign(r: Omit<StoredReview, "id" | "handle" | "updatedAt" | "editedOutside" | "isPublic" | "flags" | "imported" | "importJobId">) {
  const payload = JSON.stringify([String(r.productId), r.status, r.held, r.rating, r.title, r.body, r.reviewerName, r.reviewDate.toISOString(), r.source, r.sourceReviewId, r.reply ?? "", r.verified]);
  return createHmac("sha256", `proofly-review-signature:${process.env.TOKEN_ENCRYPTION_KEY ?? ""}`).update(payload).digest("hex").slice(0, 32);
}

function toFields(r: ReviewInput & { reply: string | null; replyDate: Date | null; verified: boolean; flags: string[]; imported: boolean; importJobId: string | null }, handle: string) {
  const v: Record<string, string> = {
    product: productGid(r.productId), status: r.status, held: String(r.held), public: String(isPublicState(r.status, r.held)),
    rating: String(r.rating), title: r.title, body: r.body, reviewer_name: r.reviewerName, review_date: r.reviewDate.toISOString(),
    source: r.source, source_review_id: r.sourceReviewId, reply: r.reply ?? "", reply_date: r.replyDate?.toISOString() ?? "",
    verified: String(r.verified), flagged: String(r.flags.length > 0), flags: JSON.stringify(r.flags), imported: String(r.imported),
    import_job: r.importJobId ?? "", sort_key: `${r.reviewDate.toISOString()}|${handle}`, integrity: sign(r),
  };
  return Object.entries(v).map(([key, value]) => ({ key, value }));
}

type Node = { id: string; handle: string; updatedAt: string; fields: { key: string; value: string | null }[] };
const NODE = "id handle updatedAt fields { key value }";

function fromNode(n: Node): StoredReview {
  const f = Object.fromEntries(n.fields.map((x) => [x.key, x.value ?? ""]));
  const status = (STATUSES as readonly string[]).includes(f.status) ? (f.status as ReviewStatus) : "pending"; // unknown → never public
  const r = {
    productId: BigInt(f.product?.split("/").pop() || "0"), status, held: f.held === "true", rating: Number(f.rating) || 0, title: f.title ?? "",
    body: f.body ?? "", reviewerName: f.reviewer_name ?? "", reviewDate: new Date(f.review_date || 0), source: f.source ?? "",
    sourceReviewId: f.source_review_id ?? "", reply: f.reply || null, replyDate: f.reply_date ? new Date(f.reply_date) : null, verified: f.verified === "true",
  };
  let flags: string[] = [];
  try { flags = f.flags ? (JSON.parse(f.flags) as string[]) : []; } catch { /* edited outside Proofly */ }
  const editedOutside = f.integrity !== sign(r);
  return {
    id: n.id, handle: n.handle, updatedAt: new Date(n.updatedAt), ...r, flags, imported: f.imported === "true", importJobId: f.import_job || null,
    // Public only when Proofly's own state says so AND the entry is still exactly as Proofly wrote it.
    isPublic: isPublicState(status, r.held) && f.public === "true" && !editedOutside,
    editedOutside,
  };
}

export const REVIEW_DEFINITION_QUERY = `#graphql
  query ProoflyReviewDefinition($type: String!) { metaobjectDefinitionByType(type: $type) { id fieldDefinitions { key capabilities { adminFilterable { enabled } } } } }`;
export const CREATE_REVIEW_DEFINITION_MUTATION = `#graphql
  mutation ProoflyCreateReviewDefinition($d: MetaobjectDefinitionCreateInput!) { metaobjectDefinitionCreate(definition: $d) { userErrors { message } } }`;
export const UPDATE_REVIEW_DEFINITION_MUTATION = `#graphql
  mutation ProoflyUpdateReviewDefinition($id: ID!, $d: MetaobjectDefinitionUpdateInput!) { metaobjectDefinitionUpdate(id: $id, definition: $d) { userErrors { message } } }`;
export const REVIEWS_QUERY = `#graphql
  query ProoflyReviews($type: String!, $query: String, $first: Int!, $after: String, $reverse: Boolean) {
    metaobjects(type: $type, query: $query, first: $first, after: $after, sortKey: "display_name", reverse: $reverse) { nodes { ${NODE} } pageInfo { hasNextPage endCursor } }
  }`;
export const REVIEW_QUERY = `#graphql
  query ProoflyReview($id: ID!) { metaobject(id: $id) { type ${NODE} } }`;
export const CREATE_REVIEW_MUTATION = `#graphql
  mutation ProoflyCreateReview($m: MetaobjectCreateInput!) { metaobjectCreate(metaobject: $m) { metaobject { ${NODE} } userErrors { message code } } }`;
export const UPDATE_REVIEW_MUTATION = `#graphql
  mutation ProoflyUpdateReview($id: ID!, $m: MetaobjectUpdateInput!) { metaobjectUpdate(id: $id, metaobject: $m) { metaobject { ${NODE} } userErrors { message } } }`;

async function call<T>(api: ShopApi, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await api.graphql(query, { variables });
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors || !body.data) throw new StoreError(`Shopify request failed: ${JSON.stringify(body.errors ?? "no data").slice(0, 200)}`);
  return body.data;
}
const userErrors = (errs: { message: string }[] | undefined) => { if (errs?.length) throw new StoreError(errs.map((e) => e.message).join("; ")); };

// ---------------------------------------------------------------------------------------------------------------
/** Shopify-side definitions Proofly needs: the `proofly_review` metaobject type and the storefront projection metafield. */
export async function ensureReviewDefinition(api: ShopApi) {
  await ensureMetaobjectDefinition(api);
  await ensureProjectionDefinition(api);
}

/** Creates the `proofly_review` definition, or brings an existing one up to date (missing fields, filter capability). */
async function ensureMetaobjectDefinition(api: ShopApi) {
  const d = await call<{ metaobjectDefinitionByType: { id: string; fieldDefinitions: { key: string; capabilities: { adminFilterable: { enabled: boolean } } }[] } | null }>(api, REVIEW_DEFINITION_QUERY, { type: REVIEW_TYPE });
  const def = d.metaobjectDefinitionByType;
  const spec = (f: (typeof FIELDS)[number]) => ({ key: f.key, name: f.name, type: f.type, required: f.required, capabilities: { adminFilterable: { enabled: f.filter } } });
  if (!def) {
    const r = await call<{ metaobjectDefinitionCreate: { userErrors: { message: string }[] } }>(api, CREATE_REVIEW_DEFINITION_MUTATION, {
      d: { type: REVIEW_TYPE, name: "Proofly review", displayNameKey: "sort_key", access: { storefront: "NONE" }, fieldDefinitions: FIELDS.map(spec) },
    });
    return userErrors(r.metaobjectDefinitionCreate.userErrors);
  }
  const have = new Map(def.fieldDefinitions.map((f) => [f.key, f.capabilities.adminFilterable.enabled]));
  const changes = FIELDS.flatMap((f): Record<string, unknown>[] => {
    if (!have.has(f.key)) return [{ create: { ...spec(f), required: false } }]; // existing entries may lack the new field
    return f.filter && !have.get(f.key) ? [{ update: { key: f.key, capabilities: { adminFilterable: { enabled: true } } } }] : [];
  });
  if (!changes.length) return;
  const r = await call<{ metaobjectDefinitionUpdate: { userErrors: { message: string }[] } }>(api, UPDATE_REVIEW_DEFINITION_MUTATION, { id: def.id, d: { fieldDefinitions: changes } });
  userErrors(r.metaobjectDefinitionUpdate.userErrors);
}

/**
 * The storefront projection (app/lib/projection.server.ts): an APP-OWNED product metafield ($app reserved namespace —
 * only Proofly can write it; merchants can read it, not edit it). The theme app extension reads it as
 * product.metafields["$app:proofly"].reviews. Its content is public by design (it is what the widget shows).
 */
export const PROJECTION = { namespace: "$app:proofly", key: "reviews", type: "json" } as const;
export const CREATE_PROJECTION_DEFINITION_MUTATION = `#graphql
  mutation ProoflyCreateProjectionDefinition($d: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $d) { createdDefinition { id } userErrors { code message } }
  }`;

export const PROJECTION_DEFINITION = { ...PROJECTION, name: "Proofly reviews (storefront)", ownerType: "PRODUCT", access: { admin: "MERCHANT_READ", storefront: "PUBLIC_READ" } } as const;

async function ensureProjectionDefinition(api: ShopApi) {
  const r = await call<{ metafieldDefinitionCreate: { userErrors: { code: string; message: string }[] } }>(api, CREATE_PROJECTION_DEFINITION_MUTATION, { d: PROJECTION_DEFINITION });
  userErrors(r.metafieldDefinitionCreate.userErrors.filter((e) => e.code !== "TAKEN")); // TAKEN = already defined
}

// ---------------------------------------------------------------------------------------------------------------
/** Shopify search syntax for the filterable fields. Values are quoted/escaped; only known keys exist. */
export interface ReviewQuery {
  productIds?: bigint[]; status?: ReviewStatus; held?: boolean; isPublic?: boolean; rating?: number; minRating?: number; source?: string;
  reviewerPrefix?: string; from?: Date; to?: Date; flagged?: boolean; importJobId?: string; handles?: string[];
}
const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
export function buildQuery(q: ReviewQuery) {
  const parts: string[] = [];
  if (q.productIds?.length) parts.push(`(${q.productIds.map((id) => `fields.product:${quote(productGid(id))}`).join(" OR ")})`);
  if (q.status) parts.push(`fields.status:${q.status}`);
  if (q.held !== undefined) parts.push(`fields.held:${q.held}`);
  if (q.isPublic !== undefined) parts.push(`fields.public:${q.isPublic}`);
  if (q.rating) parts.push(`fields.rating:${q.rating}`);
  if (q.minRating) parts.push(`fields.rating:>=${q.minRating}`);
  if (q.source) parts.push(`fields.source:${quote(q.source)}`);
  if (q.reviewerPrefix) parts.push(`fields.reviewer_name:${q.reviewerPrefix.replace(/[^\p{L}\p{N} .'-]/gu, "").trim().replace(/ /g, "\\ ")}*`);
  if (q.from) parts.push(`fields.review_date:>=${q.from.toISOString()}`);
  if (q.to) parts.push(`fields.review_date:<=${q.to.toISOString()}`);
  if (q.flagged !== undefined) parts.push(`fields.flagged:${q.flagged}`);
  if (q.importJobId) parts.push(`fields.import_job:${quote(q.importJobId)}`);
  if (q.handles?.length) parts.push(`(${q.handles.map((h) => `handle:${h}`).join(" OR ")})`);
  return parts.join(" AND ");
}

export interface Page { reviews: StoredReview[]; next: string | null }
/** One page, newest first by default (display name = "review date | handle", verified in Phase 0). */
export async function pageReviews(api: ShopApi, q: ReviewQuery, opts: { first?: number; after?: string | null; oldestFirst?: boolean } = {}): Promise<Page> {
  const d = await call<{ metaobjects: { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(api, REVIEWS_QUERY, { type: REVIEW_TYPE, query: buildQuery(q) || null, first: Math.min(opts.first ?? 50, 250), after: opts.after ?? null, reverse: !opts.oldestFirst });
  return { reviews: d.metaobjects.nodes.map(fromNode), next: d.metaobjects.pageInfo.hasNextPage ? d.metaobjects.pageInfo.endCursor : null };
}

/** Every matching review (export, aggregates, recounts). */
export async function* scanReviews(api: ShopApi, q: ReviewQuery, opts: { oldestFirst?: boolean } = {}) {
  let after: string | null = null;
  do {
    const page: Page = await pageReviews(api, q, { first: 250, after, oldestFirst: opts.oldestFirst });
    yield* page.reviews;
    after = page.next;
  } while (after);
}

export async function getReview(api: ShopApi, id: string): Promise<StoredReview | null> {
  if (!/^gid:\/\/shopify\/Metaobject\/\d{1,20}$/.test(id)) return null;
  const d = await call<{ metaobject: (Node & { type: string }) | null }>(api, REVIEW_QUERY, { id });
  return d.metaobject && d.metaobject.type === REVIEW_TYPE ? fromNode(d.metaobject) : null; // other types look missing
}

/** Existing reviews by handle (batched; used for idempotency). */
export async function findByHandles(api: ShopApi, handles: string[]) {
  const out = new Map<string, StoredReview>();
  for (let i = 0; i < handles.length; i += 50) {
    for await (const r of scanReviews(api, { handles: handles.slice(i, i + 50) })) out.set(r.handle, r);
  }
  return out;
}

const DEFAULTS = { reply: null, replyDate: null, verified: false, flags: [] as string[], imported: false, importJobId: null };

/** Creates a review. Returns null when a review with the same (source, source review id) already exists. */
export async function createReview(api: ShopApi, input: ReviewInput): Promise<StoredReview | null> {
  const handle = reviewHandle(input.source, input.sourceReviewId);
  const full = { ...DEFAULTS, ...input };
  const d = await call<{ metaobjectCreate: { metaobject: Node | null; userErrors: { message: string; code?: string }[] } }>(api, CREATE_REVIEW_MUTATION, {
    m: { type: REVIEW_TYPE, handle, fields: toFields(full, handle) },
  });
  if (d.metaobjectCreate.userErrors.some((e) => e.code === "TAKEN" || /taken|already exists/i.test(e.message))) return null;
  userErrors(d.metaobjectCreate.userErrors);
  return fromNode(d.metaobjectCreate.metaobject!);
}

/** Writes a review's Proofly-owned state (status, hold, reply, …) and re-signs it. */
export async function updateReview(api: ShopApi, current: StoredReview, patch: Partial<ReviewInput>): Promise<StoredReview> {
  const next = { ...current, ...patch };
  const d = await call<{ metaobjectUpdate: { metaobject: Node | null; userErrors: { message: string }[] } }>(api, UPDATE_REVIEW_MUTATION, {
    id: current.id, m: { fields: toFields(next, current.handle) },
  });
  userErrors(d.metaobjectUpdate.userErrors);
  return fromNode(d.metaobjectUpdate.metaobject!);
}

/** The bucket a review counts in for plan usage and the dashboard. */
export const bucketOf = (r: Pick<StoredReview, "status" | "held">) => (r.status === "published" ? (r.held ? "planLimited" : "published") : r.status);
