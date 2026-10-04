/**
 * Validates every Admin GraphQL operation Proofly sends against Shopify's published Admin API schema for API_VERSION.
 *   npm run check:graphql                       # downloads the schema from Shopify's public schema proxy (no credentials)
 *   npm run check:graphql -- --schema file.json # or uses a saved introspection result
 * Needs network unless --schema is given, so it is a separate check, not part of `npm test`.
 */
import { readFileSync } from "node:fs";
import { buildClientSchema, getIntrospectionQuery, parse, validate } from "graphql";
import { API_VERSION } from "../app/shopify-api-version";
import { SUBSCRIPTION_STATE_QUERY } from "../app/lib/billing.server";
import { SKU_LOOKUP_QUERY } from "../app/lib/import.server";
import { PRODUCTS_PAGE_QUERY } from "../app/lib/products.server";
import { CURRENT_APP_INSTALLATION_QUERY, SET_APP_METAFIELD_MUTATION } from "../app/lib/proxy-path.server";
import { DELETE_RATINGS_MUTATION, ENABLE_DEFINITION_MUTATION, READ_RATINGS_QUERY, SET_RATINGS_MUTATION } from "../app/lib/rating-cache.server";
import {
  CREATE_REVIEW_DEFINITION_MUTATION, CREATE_REVIEW_MUTATION, REVIEW_DEFINITION_QUERY, REVIEW_QUERY, REVIEWS_QUERY, UPDATE_REVIEW_DEFINITION_MUTATION, UPDATE_REVIEW_MUTATION,
} from "../app/lib/review-store.server";
import { PRODUCT_LOOKUP_QUERY } from "../app/lib/submit.server";
import { SHOP_IDENTITY_QUERY } from "../app/lib/tenant.server";

const OPERATIONS = {
  SHOP_IDENTITY_QUERY, CURRENT_APP_INSTALLATION_QUERY, SET_APP_METAFIELD_MUTATION, PRODUCTS_PAGE_QUERY, PRODUCT_LOOKUP_QUERY,
  SET_RATINGS_MUTATION, DELETE_RATINGS_MUTATION, READ_RATINGS_QUERY, ENABLE_DEFINITION_MUTATION, SUBSCRIPTION_STATE_QUERY, SKU_LOOKUP_QUERY,
  // Reviews stored in Shopify (app/lib/review-store.server.ts)
  REVIEW_DEFINITION_QUERY, CREATE_REVIEW_DEFINITION_MUTATION, UPDATE_REVIEW_DEFINITION_MUTATION, REVIEWS_QUERY, REVIEW_QUERY, CREATE_REVIEW_MUTATION, UPDATE_REVIEW_MUTATION,
};

const i = process.argv.indexOf("--schema");
const introspection = i > -1
  ? JSON.parse(readFileSync(process.argv[i + 1], "utf8"))
  : await (await fetch(`https://shopify.dev/admin-graphql-direct-proxy/${API_VERSION}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: getIntrospectionQuery() }),
    })).json();
const schema = buildClientSchema(introspection.data);

let failed = 0;
for (const [name, op] of Object.entries(OPERATIONS)) {
  const errors = validate(schema, parse(op));
  console.log(`${errors.length ? "✗" : "✓"} ${name}${errors.length ? `: ${errors.map((e) => e.message).join("; ")}` : ""}`);
  failed += errors.length ? 1 : 0;
}
console.log(`${Object.keys(OPERATIONS).length - failed}/${Object.keys(OPERATIONS).length} Admin operations valid against ${API_VERSION}`);
process.exit(failed ? 1 : 0);
