import { createHmac } from "node:crypto";

/** Shopify app-proxy signature: HMAC-SHA256 over sorted "k=v" pairs joined with "" (values comma-joined). */
export function signProxyParams(params: URLSearchParams, secret: string) {
  const grouped = new Map<string, string[]>();
  for (const [k, v] of params) if (k !== "signature") grouped.set(k, [...(grouped.get(k) ?? []), v]);
  const message = [...grouped].map(([k, v]) => `${k}=${v.join(",")}`).sort().join("");
  params.set("signature", createHmac("sha256", secret).update(message).digest("hex"));
  return params;
}

export const isDev = () => process.env.NODE_ENV !== "production";
