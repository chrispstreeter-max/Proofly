import { Prisma } from "@prisma/client";
import { PUBLIC_REVIEW } from "./reviews.server";
import { withTenant, type Tenant } from "./tenant.server";

/** Recompute review_count / average / distribution from PUBLIC reviews (published, not held) of one product of this shop. */
export async function recomputeProduct({ db, shopId }: Tenant, productId: string) {
  const rows = await db.review.groupBy({
    by: ["rating"],
    where: { shopId, productId, ...PUBLIC_REVIEW },
    _count: { _all: true },
  });
  const dist = [0, 0, 0, 0, 0];
  for (const r of rows) dist[r.rating - 1] = r._count._all;
  const count = dist.reduce((a, b) => a + b, 0);
  const sum = dist.reduce((a, n, i) => a + n * (i + 1), 0);
  const average = count ? Math.round((sum / count) * 100) / 100 : 0;
  await db.product.updateMany({
    where: { shopId, id: productId },
    data: {
      reviewCount: count,
      averageRating: new Prisma.Decimal(average),
      rating1: dist[0], rating2: dist[1], rating3: dist[2], rating4: dist[3], rating5: dist[4],
    },
  });
}

export async function recomputeAll(t: Tenant) {
  const products = await t.db.product.findMany({ where: { shopId: t.shopId }, select: { id: true } });
  for (const p of products) await recomputeProduct(t, p.id);
  return products.length;
}

type AdminGraphql = (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;

async function gql(graphql: AdminGraphql, query: string, variables?: Record<string, unknown>) {
  const res = await graphql(query, { variables });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Admin GraphQL response
  const json = (await res.json()) as { data?: any; errors?: unknown };
  if (json.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  return json.data;
}

/** Enable Shopify's standard product-review metafield definitions on the authenticated shop (idempotent). */
export async function ensureReviewMetafieldDefinitions(graphql: AdminGraphql) {
  for (const key of ["rating", "rating_count"]) {
    const data = await gql(
      graphql,
      `mutation($ownerType: MetafieldOwnerType!, $namespace: String!, $key: String!) {
        standardMetafieldDefinitionEnable(ownerType: $ownerType, namespace: $namespace, key: $key, pin: false) {
          userErrors { code message }
        }
      }`,
      { ownerType: "PRODUCT", namespace: "reviews", key },
    );
    const errs = data.standardMetafieldDefinitionEnable.userErrors.filter((e: { code: string }) => e.code !== "TAKEN");
    if (errs.length) throw new Error(`metafield definition ${key}: ${JSON.stringify(errs)}`);
  }
}

/**
 * Mirror this shop's DB aggregates into its Shopify standard metafields (derived cache). `graphql` must be the
 * Admin API client of the same authenticated shop. DB reads/writes run in tenant transactions; the Shopify calls
 * happen outside them.
 */
export async function syncMetafields(shopId: string, graphql: AdminGraphql, opts: { force?: boolean } = {}) {
  const products = await withTenant(shopId, ({ db }) => db.product.findMany({ where: { shopId } }));
  const changed = products.filter(
    (p) => opts.force || p.syncedCount !== p.reviewCount || !p.syncedAverage?.equals(p.averageRating),
  );
  for (let i = 0; i < changed.length; i += 12) {
    const batch = changed.slice(i, i + 12); // ≤2 metafields each, metafieldsSet max 25
    // A rating of 0 is outside the 1–5 scale, so it is only written when count > 0.
    const metafields = batch.flatMap((p) => [
      ...(p.reviewCount > 0
        ? [{
            ownerId: `gid://shopify/Product/${p.shopifyProductId}`,
            namespace: "reviews",
            key: "rating",
            type: "rating",
            value: JSON.stringify({ value: p.averageRating.toFixed(2), scale_min: "1.0", scale_max: "5.0" }),
          }]
        : []),
      { ownerId: `gid://shopify/Product/${p.shopifyProductId}`, namespace: "reviews", key: "rating_count", type: "number_integer", value: String(p.reviewCount) },
    ]);
    const data = await gql(graphql, `mutation($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }`, { metafields });
    if (data.metafieldsSet.userErrors.length) throw new Error(JSON.stringify(data.metafieldsSet.userErrors));
    await withTenant(shopId, async ({ db }) => {
      for (const p of batch) await db.product.updateMany({ where: { shopId, id: p.id }, data: { syncedCount: p.reviewCount, syncedAverage: p.averageRating } });
    });
  }
  return changed.length;
}
