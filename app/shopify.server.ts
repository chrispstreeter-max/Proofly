import "@shopify/shopify-app-react-router/adapters/node";
import { AppDistribution, shopifyApp } from "@shopify/shopify-app-react-router/server";
import prisma from "./db.server";
import { API_VERSION } from "./shopify-api-version";
import { EncryptedSessionStorage } from "./lib/session-storage.server";
import { reconcileBilling } from "./lib/billing.server";
import { upsertShopFromAuth } from "./lib/tenant.server";

// Fail fast: an empty API secret would make every HMAC/JWT check forgeable, so never start without these.
const REQUIRED_ENV = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL", "SCOPES", "TOKEN_ENCRYPTION_KEY"] as const;
// Production additionally needs durable shared media storage (local disk is per-instance and ephemeral), separate
// private/public buckets, a real IP-hash salt and the Shopify app handle (plan page links).
const PRODUCTION_ENV = ["DATABASE_URL", "IP_HASH_SALT", "SHOPIFY_APP_HANDLE", "MEDIA_PUBLIC_URL", "S3_BUCKET_PRIVATE", "S3_BUCKET_PUBLIC", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
export function envProblems(env: Record<string, string | undefined>) {
  const problems = REQUIRED_ENV.filter((k) => !env[k]).map((k) => `missing ${k}`);
  if (env.NODE_ENV !== "production") return problems;
  problems.push(...PRODUCTION_ENV.filter((k) => !env[k]).map((k) => `missing ${k}`));
  if (env.MEDIA_DRIVER !== "s3") problems.push("MEDIA_DRIVER must be s3 in production");
  if (env.S3_BUCKET_PRIVATE && env.S3_BUCKET_PRIVATE === env.S3_BUCKET_PUBLIC) problems.push("S3_BUCKET_PRIVATE and S3_BUCKET_PUBLIC must differ");
  if ((env.IP_HASH_SALT ?? "").length < 32) problems.push("IP_HASH_SALT must be at least 32 characters");
  if (!env.SHOPIFY_APP_URL?.startsWith("https://")) problems.push("SHOPIFY_APP_URL must be https");
  return problems;
}
const problems = envProblems(process.env);
if (problems.length) throw new Error(`Invalid environment: ${problems.join("; ")}`);

/**
 * Install / reinstall / token refresh. Runs after every token exchange (Shopify-managed installation): creates or
 * reactivates the tenant from the shop identity the Admin API reports for this session — never from request input.
 */
export const afterAuth = async ({ session, admin }: { session: { shop: string }; admin: { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> } }) => {
  const shop = await upsertShopFromAuth(session.shop, (q, o) => admin.graphql(q, o));
  // Entitlements follow Shopify App Pricing. Best effort: a failure leaves the plan unchanged (never a downgrade).
  await reconcileBilling(shop.id, (q, o) => admin.graphql(q, o)).catch((e) => console.warn("billing reconcile deferred", shop.id, e));
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
