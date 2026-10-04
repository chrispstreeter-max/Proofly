import type { Prisma, Shop } from "@prisma/client";
import prisma from "../db.server";
import { DEFAULT_PROXY_PATH, publishAppMetafields, publishProxyPath, STOREFRONT_SETTINGS_METAFIELD } from "./proxy-path.server";

/**
 * Tenant boundary.
 *
 * 1. A shop is resolved ONLY from Shopify-verified context: the admin session token (authenticate.admin),
 *    the HMAC-signed app-proxy request (authenticate.public.appProxy) or an HMAC-verified webhook. Shop domains,
 *    shop ids or tenant ids supplied by a browser are never used to choose the tenant.
 * 2. All merchant data access runs inside withTenant(): a transaction that sets app.shop_id, so Postgres row-level
 *    security only exposes that shop's rows. Code inside still filters by shopId explicitly (defence in depth).
 * 3. Relations between merchant rows are composite (shop_id, id) foreign keys, so cross-shop links are impossible.
 * 4. Lookups that miss — whether the row does not exist or belongs to another shop — return the same "not found".
 */

export type Db = Prisma.TransactionClient;
export interface Tenant {
  shopId: string;
  db: Db;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (s: string | null | undefined): s is string => !!s && UUID.test(s);

export async function withTenant<T>(shopId: string, fn: (t: Tenant) => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
  if (!isUuid(shopId)) throw new Error("withTenant: invalid shop id");
  // ponytail: one interactive transaction per tenant operation; move long network work (S3, Shopify API) outside
  // the transaction if connection-pool pressure shows up.
  return prisma.$transaction(
    async (db) => {
      await db.$executeRaw`SELECT set_config('app.shop_id', ${shopId}, true)`;
      return fn({ shopId, db });
    },
    { maxWait: 5_000, timeout: opts.timeoutMs ?? 20_000 },
  );
}

/** Normalised myshopify domain (as provided by Shopify's authenticated context). */
const normalise = (domain: string) => domain.trim().toLowerCase();

/** The installed (not uninstalled) shop for an authenticated Shopify domain, or null. */
export function activeShopByDomain(domain: string) {
  return prisma.shop.findFirst({ where: { shopDomain: normalise(domain), uninstalledAt: null } });
}

/** True while the shop has Proofly installed (imports and other merchant jobs refuse to run otherwise). */
export async function isShopActive(shopId: string) {
  return !!(await prisma.shop.findFirst({ where: { id: shopId, uninstalledAt: null }, select: { id: true } }));
}

/** Any shop row for an authenticated domain (including uninstalled — used by compliance webhooks). */
export function shopByDomain(domain: string) {
  return prisma.shop.findUnique({ where: { shopDomain: normalise(domain) } });
}

export const SHOP_IDENTITY_QUERY = `#graphql
  query ProoflyShopIdentity { shop { id name myshopifyDomain primaryDomain { host } } }`;

type GraphqlFn = (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response>;

/**
 * Install / reinstall lifecycle. Called from Shopify's afterAuth hook (and lazily on the first authenticated admin
 * request if needed). Identity (numeric shop id, name) comes from the Admin API of the authenticated session.
 */
export async function upsertShopFromAuth(sessionShop: string, graphql: GraphqlFn): Promise<Shop> {
  const res = await graphql(SHOP_IDENTITY_QUERY);
  const data = (await res.json()) as { data?: { shop?: { id: string; name: string; myshopifyDomain: string; primaryDomain?: { host?: string } } } };
  const s = data.data?.shop;
  if (!s || normalise(s.myshopifyDomain) !== normalise(sessionShop)) throw new Error("Shop identity mismatch");
  const shopifyShopId = BigInt(s.id.split("/").pop()!);
  const storefrontHosts = s.primaryDomain?.host ? [normalise(s.primaryDomain.host)] : [];
  const shop = await registerShop({ shopDomain: sessionShop, shopifyShopId, shopName: s.name, storefrontHosts });
  // The theme extension reads the shop's proxy path from an app-data metafield. Best effort: a failure here must not
  // block authentication; it is retried on the next token exchange and from the admin Storefront settings.
  await publishShopProxyPath(shop.id, graphql).catch((e) => console.warn("proxy path metafield not published", shop.id, e));
  return shop;
}

/** Publishes the shop's configured proxy path to its app-data metafield if it changed since the last publish. */
export async function publishShopProxyPath(shopId: string, graphql: GraphqlFn, opts: { force?: boolean } = {}) {
  const s = await withTenant(shopId, ({ db }) => db.shopSettings.findUniqueOrThrow({ where: { shopId } }));
  if (!opts.force && s.proxyPathPublished === s.proxyPath) return false;
  await publishProxyPath(graphql, s.proxyPath);
  await withTenant(shopId, ({ db }) => db.shopSettings.update({ where: { shopId }, data: { proxyPathPublished: s.proxyPath } }));
  return true;
}

/** Publishes the storefront switches (submissions, photos) to the app-data metafield the extension reads. */
export async function publishStorefrontSettings(shopId: string, graphql: GraphqlFn) {
  const s = await withTenant(shopId, ({ db }) => db.shopSettings.findUniqueOrThrow({ where: { shopId } }));
  await publishAppMetafields(graphql, [{ ...STOREFRONT_SETTINGS_METAFIELD, value: JSON.stringify({ submissions: s.reviewSubmissionEnabled, photos: s.photoReviewsEnabled }) }]);
}

/**
 * Public media resolver — the only cross-tenant read in the app. Maps an opaque public asset id to its internal
 * storage key, and ONLY while the photo is public (see proofly_public_media_key in the checkpoint 4 migration).
 */
export async function publicMediaKey(publicId: string, size: 320 | 1600): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ key: string | null }[]>`SELECT proofly_public_media_key(${publicId}, ${size}::int) AS key`;
  return rows[0]?.key ?? null;
}

/** Creates the tenant (and its default settings) or reactivates it on reinstall. Data of a reinstalled shop is kept. */
export async function registerShop(input: { shopDomain: string; shopifyShopId: bigint | null; shopName: string | null; storefrontHosts?: string[] }): Promise<Shop> {
  const shopDomain = normalise(input.shopDomain);
  const existing = await prisma.shop.findUnique({ where: { shopDomain } });
  const shop = existing
    ? await prisma.shop.update({
        where: { id: existing.id },
        data: {
          shopifyShopId: input.shopifyShopId ?? existing.shopifyShopId,
          shopName: input.shopName ?? existing.shopName,
          ...(input.storefrontHosts ? { storefrontHosts: input.storefrontHosts } : {}),
          ...(existing.uninstalledAt ? { uninstalledAt: null, installedAt: new Date() } : {}),
        },
      })
    : await prisma.shop.create({ data: { shopDomain, shopifyShopId: input.shopifyShopId, shopName: input.shopName, storefrontHosts: input.storefrontHosts ?? [] } });
  // Only lifecycle changes go to the permanent audit trail; a routine token exchange/refresh of an active shop does not.
  const lifecycle = !existing ? "shop.installed" : existing.uninstalledAt ? "shop.reinstalled" : null;
  await withTenant(shop.id, async ({ db, shopId }) => {
    await db.shopSettings.upsert({ where: { shopId }, create: { shopId, proxyPath: DEFAULT_PROXY_PATH }, update: {} });
    // Every merchant starts on Free (unverified until billing.server reconciles with Shopify).
    await db.billingState.upsert({ where: { shopId }, create: { shopId, plan: "FREE" }, update: {} });
    if (lifecycle) await db.auditLog.create({ data: { shopId, actor: "shopify", action: lifecycle, entity: "shop", entityId: shopId } });
  });
  return shop;
}

/** app/uninstalled: tenant becomes inactive immediately (storefront + admin stop serving), data is retained.
 *  Idempotent: Shopify may deliver the webhook more than once. */
export async function markUninstalled(domain: string) {
  const shop = await shopByDomain(domain);
  if (!shop || shop.uninstalledAt) return shop;
  await prisma.shop.update({ where: { id: shop.id }, data: { uninstalledAt: new Date() } });
  await withTenant(shop.id, ({ db, shopId }) =>
    db.auditLog.create({ data: { shopId, actor: "shopify", action: "shop.uninstalled", entity: "shop", entityId: shopId } }),
  );
  return shop;
}
