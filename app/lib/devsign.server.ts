import { createHmac } from "node:crypto";

/** Shopify app-proxy signature: HMAC-SHA256 over sorted "k=v" pairs joined with "" (values comma-joined). */
export function signProxyParams(params: URLSearchParams, secret: string) {
  const grouped = new Map<string, string[]>();
  for (const [k, v] of params) if (k !== "signature") grouped.set(k, [...(grouped.get(k) ?? []), v]);
  // Same canonical form as Shopify's verifier: keys sorted with localeCompare, then "key=value" concatenated.
  const message = [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v.join(",")}`).join("");
  params.set("signature", createHmac("sha256", secret).update(message).digest("hex"));
  return params;
}

/** Dev-only routes are fail-closed: enabled only when NODE_ENV is exactly "development" (unset/other → disabled). */
export const isDev = () => process.env.NODE_ENV === "development";

/**
 * The local development shop (fictional, DEV_SHOP_DOMAIN). Dev pages only ever see this tenant, through the same
 * tenant transaction (RLS) as production code. Returns null outside development or when it is not registered.
 */
export async function devShop() {
  if (!isDev()) return null;
  const { activeShopByDomain } = await import("./tenant.server");
  return activeShopByDomain(process.env.DEV_SHOP_DOMAIN ?? "proofly-dev.myshopify.com");
}
