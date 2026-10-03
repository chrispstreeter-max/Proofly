import { ApiVersion } from "@shopify/shopify-app-react-router/server";

/**
 * The ONE Shopify API version Proofly uses: Admin GraphQL calls (shopify.server.ts), GraphQL codegen (.graphqlrc.ts)
 * and webhooks (`[webhooks] api_version` in shopify.app.toml, kept equal by tests/sync.test.ts).
 */
export const API_VERSION = ApiVersion.October26;
