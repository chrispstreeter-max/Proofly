import type { Prisma, Shop } from "@prisma/client";
import prisma from "../db.server";

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

export async function withTenant<T>(shopId: string, fn: (t: Tenant) => Promise<T>): Promise<T> {
  if (!isUuid(shopId)) throw new Error("withTenant: invalid shop id");
  // ponytail: one interactive transaction per tenant operation; move long network work (S3, Shopify API) outside
  // the transaction if connection-pool pressure shows up.
  return prisma.$transaction(
    async (db) => {
      await db.$executeRaw`SELECT set_config('app.shop_id', ${shopId}, true)`;
      return fn({ shopId, db });
    },
    { maxWait: 5_000, timeout: 20_000 },
  );
}

/** Normalised myshopify domain (as provided by Shopify's authenticated context). */
const normalise = (domain: string) => domain.trim().toLowerCase();

/** The installed (not uninstalled) shop for an authenticated Shopify domain, or null. */
export function activeShopByDomain(domain: string) {
  return prisma.shop.findFirst({ where: { shopDomain: normalise(domain), uninstalledAt: null } });
}

/** Any shop row for an authenticated domain (including uninstalled — used by compliance webhooks). */
export function shopByDomain(domain: string) {
  return prisma.shop.findUnique({ where: { shopDomain: normalise(domain) } });
}

type GraphqlFn = (q: string) => Promise<Response>;

/**
 * Install / reinstall lifecycle. Called from Shopify's afterAuth hook (and lazily on the first authenticated admin
 * request if needed). Identity (numeric shop id, name) comes from the Admin API of the authenticated session.
 */
export async function upsertShopFromAuth(sessionShop: string, graphql: GraphqlFn): Promise<Shop> {
  const res = await graphql(`{ shop { id name myshopifyDomain primaryDomain { host } } }`);
  const data = (await res.json()) as { data?: { shop?: { id: string; name: string; myshopifyDomain: string; primaryDomain?: { host?: string } } } };
  const s = data.data?.shop;
  if (!s || normalise(s.myshopifyDomain) !== normalise(sessionShop)) throw new Error("Shop identity mismatch");
  const shopifyShopId = BigInt(s.id.split("/").pop()!);
  const storefrontHosts = s.primaryDomain?.host ? [normalise(s.primaryDomain.host)] : [];
  return registerShop({ shopDomain: sessionShop, shopifyShopId, shopName: s.name, storefrontHosts });
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
    await db.shopSettings.upsert({ where: { shopId }, create: { shopId }, update: {} });
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
