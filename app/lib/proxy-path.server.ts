/**
 * The single place that knows about Shopify app-proxy PATHS.
 *
 * Shopify routes https://<store>/<prefix>/<subpath>/* to this app's /proxy/* and signs the request, including
 * `path_prefix` (the path the shopper actually used). Merchants can change prefix/subpath in their Shopify admin, so
 * the path is per-merchant configuration:
 *   - stored per shop in shop_settings.proxy_path (set explicitly at install to the app's configured default),
 *   - published to an app-data metafield (AppInstallation, namespace "proofly", key "proxy_path") that the theme app
 *     extension reads through Liquid's `app` object — the storefront never hard-codes a path,
 *   - enforced on every storefront request: the signed path_prefix must equal the shop's configured path.
 * There is no global fallback: a shop's requests are only valid through that shop's own configured path.
 */
import type { Tenant } from "./tenant.server";

/** The app's default proxy location — must equal [app_proxy] prefix/subpath in shopify.app.toml (test-enforced). */
export const DEFAULT_PROXY_PATH = "/apps/proofly";

/** Shopify allows these prefixes; the subpath is a short slug. */
const PROXY_PATH = /^\/(apps|a|community|tools)\/[a-z0-9][a-z0-9_-]{0,63}$/;

/** Normalised, validated proxy path ("/apps/proofly"), or null if Shopify would not accept it. */
export function parseProxyPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = `/${raw.trim().toLowerCase().replace(/^\/+|\/+$/g, "")}`;
  return PROXY_PATH.test(path) ? path : null;
}

/** App-data metafield read by the theme app extension: {{ app.metafields.proofly.proxy_path.value }} */
export const PROXY_PATH_METAFIELD = { namespace: "proofly", key: "proxy_path", type: "single_line_text_field" } as const;

type Graphql = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;

export const CURRENT_APP_INSTALLATION_QUERY = `#graphql
  query ProoflyCurrentAppInstallation { currentAppInstallation { id } }`;
export const SET_APP_METAFIELD_MUTATION = `#graphql
  mutation ProoflySetAppMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message code } }
  }`;

/** Writes the shop's proxy path to its app-data metafield (idempotent). Throws on Shopify errors. */
export async function publishProxyPath(graphql: Graphql, path: string) {
  const inst = (await (await graphql(CURRENT_APP_INSTALLATION_QUERY)).json()) as { data?: { currentAppInstallation?: { id: string } } };
  const ownerId = inst.data?.currentAppInstallation?.id;
  if (!ownerId) throw new Error("currentAppInstallation unavailable");
  const res = (await (await graphql(SET_APP_METAFIELD_MUTATION, {
    variables: { metafields: [{ ownerId, ...PROXY_PATH_METAFIELD, value: path }] },
  })).json()) as { data?: { metafieldsSet?: { userErrors: unknown[] } }; errors?: unknown };
  if (res.errors || !res.data?.metafieldsSet || res.data.metafieldsSet.userErrors.length) throw new Error(`proxy path metafield: ${JSON.stringify(res.errors ?? res.data)}`);
}

/** Merchant changes their proxy path (must match what they configured in Shopify). Returns the saved path or null. */
export async function setProxyPath({ db, shopId }: Tenant, raw: unknown, actor: string) {
  const path = parseProxyPath(raw);
  if (!path) return null;
  const before = await db.shopSettings.findUniqueOrThrow({ where: { shopId }, select: { proxyPath: true } });
  if (before.proxyPath === path) return path;
  await db.shopSettings.update({ where: { shopId }, data: { proxyPath: path } }); // proxy_path_published now differs → republish
  await db.auditLog.create({ data: { shopId, actor, action: "settings.proxy_path", entity: "shop", entityId: shopId, details: { from: before.proxyPath, to: path } } });
  return path;
}
