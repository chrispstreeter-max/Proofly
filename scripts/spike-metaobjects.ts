/* eslint-disable @typescript-eslint/no-explicit-any -- throwaway spike reading untyped GraphQL responses */
/**
 * PHASE 0 SPIKE (docs/SHOPIFY-DATA.md §4) — run only against the development store "Proofly Test".
 *   npx tsx --env-file=.env scripts/spike-metaobjects.ts proofly-test-g3yjndjl.myshopify.com
 * Proves (or disproves) the Shopify behaviours the reviews-in-Shopify design depends on. Synthetic data only; every
 * entry it creates has type proofly_review and a "spike-" handle, and --cleanup deletes them again.
 */
import { unauthenticated } from "../app/shopify.server";

const shop = process.argv[2];
if (!/^proofly-test-[a-z0-9]+\.myshopify\.com$/.test(shop ?? "")) throw new Error("Development store 'Proofly Test' only");
const { admin } = await unauthenticated.admin(shop);
const gql = async (query: string, variables: Record<string, unknown> = {}) => {
  const r = await admin.graphql(query, { variables });
  const body = (await r.json()) as { data?: any; errors?: unknown };
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 500));
  return body.data;
};
const results: Record<string, unknown> = {};
const TYPE = "proofly_review";

if (process.argv.includes("--cleanup")) {
  let n = 0;
  for (;;) {
    const d = await gql(`query($t:String!){ metaobjects(type:$t, first:250, query:"handle:spike-*"){ nodes{ id } } }`, { t: TYPE });
    if (!d.metaobjects.nodes.length) break;
    for (const m of d.metaobjects.nodes) { await gql(`mutation($id:ID!){ metaobjectDelete(id:$id){ userErrors{ message } } }`, { id: m.id }); n++; }
  }
  console.log(JSON.stringify({ deleted: n }));
  process.exit(0);
}

// 4a. Merchant-owned definition created by the app (no $app prefix). Storefront access NONE.
let def = (await gql(`query($t:String!){ metaobjectDefinitionByType(type:$t){ id type access{ admin storefront } } }`, { t: TYPE })).metaobjectDefinitionByType;
if (!def) {
  const d = await gql(`mutation($d: MetaobjectDefinitionCreateInput!){ metaobjectDefinitionCreate(definition:$d){ metaobjectDefinition{ id type access{ admin storefront } } userErrors{ field message code } } }`, { d: {
    type: TYPE, name: "Proofly review", displayNameKey: "sort_key", access: { storefront: "NONE" },
    fieldDefinitions: [
      { key: "product", name: "Product", type: "product_reference", required: true },
      { key: "rating", name: "Rating", type: "number_integer", required: true, validations: [{ name: "min", value: "1" }, { name: "max", value: "5" }] },
      { key: "body", name: "Review", type: "multi_line_text_field", required: true },
      { key: "reviewer_name", name: "Reviewer name", type: "single_line_text_field", required: true },
      { key: "review_date", name: "Review date", type: "date_time", required: true },
      { key: "status", name: "Status", type: "single_line_text_field", required: true },
      { key: "sort_key", name: "Sort key", type: "single_line_text_field", required: true },
    ],
  } });
  results.definitionCreate = d.metaobjectDefinitionCreate.userErrors.length ? d.metaobjectDefinitionCreate.userErrors : "created";
  def = d.metaobjectDefinitionCreate.metaobjectDefinition;
}
// 1a. Field filtering needs adminFilterable on the field definition.
const upd = await gql(`mutation($id: ID!, $d: MetaobjectDefinitionUpdateInput!){ metaobjectDefinitionUpdate(id:$id, definition:$d){ metaobjectDefinition{ fieldDefinitions{ key capabilities{ adminFilterable{ enabled } } } } userErrors{ field message code } } }`, {
  id: def.id, d: { fieldDefinitions: ["product", "status"].map((key) => ({ update: { key, capabilities: { adminFilterable: { enabled: true } } } })) },
});
results.adminFilterableUpdate = upd.metaobjectDefinitionUpdate.userErrors.length ? upd.metaobjectDefinitionUpdate.userErrors : upd.metaobjectDefinitionUpdate.metaobjectDefinition.fieldDefinitions.filter((f: { key: string }) => ["product", "status"].includes(f.key));
results.definition = def;

// Two synthetic products of the store.
const products = (await gql(`{ products(first: 2, query: "vendor:'Proofly Test' AND status:active"){ nodes{ id handle } } }`)).products.nodes as { id: string; handle: string }[];
results.products = products.map((p) => p.handle);

// Seed 30 entries (20 on product 0, 10 on product 1), dates out of insertion order.
const iso = (i: number) => new Date(Date.UTC(2024, (i * 7) % 12, 1 + ((i * 11) % 27))).toISOString();
for (let i = 0; i < 30; i++) {
  const p = products[i < 20 ? 0 : 1];
  const date = iso(i);
  await gql(`mutation($h: MetaobjectHandleInput!, $m: MetaobjectUpsertInput!){ metaobjectUpsert(handle:$h, metaobject:$m){ userErrors{ message } } }`, {
    h: { type: TYPE, handle: `spike-${i}` },
    m: { fields: [
      { key: "product", value: p.id }, { key: "rating", value: String(1 + (i % 5)) }, { key: "body", value: `Synthetic spike review ${i}` },
      { key: "reviewer_name", value: "Spike Example" }, { key: "review_date", value: date }, { key: "status", value: i % 4 === 0 ? "pending" : "published" },
      { key: "sort_key", value: `${date}|spike-${i}` },
    ] },
  });
}

// 1. Filter by product reference.
const count = async (q: string) => {
  let n = 0, after: string | null = null;
  do {
    const d: any = await gql(`query($t:String!,$q:String!,$a:String){ metaobjects(type:$t, first:250, after:$a, query:$q){ nodes{ handle } pageInfo{ hasNextPage endCursor } } }`, { t: TYPE, q, a: after });
    n += d.metaobjects.nodes.filter((x: { handle: string }) => x.handle.startsWith("spike-")).length;
    after = d.metaobjects.pageInfo.hasNextPage ? d.metaobjects.pageInfo.endCursor : null;
  } while (after);
  return n;
};
const pid = products[0].id, numeric = pid.split("/").pop();
results.filterByProductGid = await count(`fields.product:"${pid}"`);
results.filterByProductNumeric = await count(`fields.product:${numeric}`);
results.filterByProductAndStatus = await count(`fields.product:"${pid}" AND fields.status:published`);
results.expected = { product0: 20, product0Published: 15 };

// 2. Newest-first by display name (sort_key).
const page = await gql(`query($t:String!,$q:String!){ metaobjects(type:$t, first:10, sortKey:"display_name", reverse:true, query:$q){ nodes{ displayName } } }`, { t: TYPE, q: `fields.product:"${pid}"` });
const names = page.metaobjects.nodes.map((n: { displayName: string }) => n.displayName);
results.newestFirst = { names, sorted: names.every((n: string, i: number) => i === 0 || names[i - 1] >= n) };

// 3. Bulk mutation support for metaobjectUpsert (schema introspection only; no bulk job is started here).
const bulkArg = await gql(`{ __type(name: "Mutation"){ fields(includeDeprecated: false){ name } } }`);
results.bulkMutationAvailable = bulkArg.__type.fields.some((f: { name: string }) => f.name === "bulkOperationRunMutation");

// 5. Largest product JSON metafield accepted (app namespace), and Liquid can read it (checked in the theme separately).
const tryJson = async (kb: number) => {
  const value = JSON.stringify({ pad: "x".repeat(kb * 1024 - 12) });
  const d = await gql(`mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ message code } } }`, { m: [{ ownerId: pid, namespace: "$app", key: "spike_reviews", type: "json", value }] });
  return d.metafieldsSet.userErrors.length ? d.metafieldsSet.userErrors[0].message : "ok";
};
results.json120kb = await tryJson(120);
results.json130kb = await tryJson(130);
const sample = JSON.stringify({ r: 5, t: "Great quality", b: "x".repeat(300), n: "Alex Example", d: "2025-01-01", rep: null });
results.reviewsPer128kb = Math.floor((128 * 1024) / (sample.length + 1));

console.log(JSON.stringify(results, null, 1));
process.exit(0);
