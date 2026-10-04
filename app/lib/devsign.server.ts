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
