import "@shopify/shopify-app-react-router/adapters/node";
import { AppDistribution, shopifyApp } from "@shopify/shopify-app-react-router/server";
import prisma from "./db.server";
import { API_VERSION } from "./shopify-api-version";
import { EncryptedSessionStorage } from "./lib/session-storage.server";
import { upsertShopFromAuth } from "./lib/tenant.server";

// Fail fast: an empty API secret would make every HMAC/JWT check forgeable, so never start without these.
const REQUIRED_ENV = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL", "SCOPES", "TOKEN_ENCRYPTION_KEY"] as const;
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);

/**
 * Install / reinstall / token refresh. Runs after every token exchange (Shopify-managed installation): creates or
 * reactivates the tenant from the shop identity the Admin API reports for this session — never from request input.
 */
export const afterAuth = async ({ session, admin }: { session: { shop: string }; admin: { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> } }) => {
  await upsertShopFromAuth(session.shop, (q, o) => admin.graphql(q, o));
};

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  apiVersion: API_VERSION,
  scopes: process.env.SCOPES!.split(","),
  appUrl: process.env.SHOPIFY_APP_URL!,
  authPathPrefix: "/auth",
  sessionStorage: new EncryptedSessionStorage(prisma), // access/refresh tokens encrypted at rest
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: { afterAuth },
});

export default shopify;
export const apiVersion = API_VERSION;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
