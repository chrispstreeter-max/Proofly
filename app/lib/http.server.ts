import { createHash } from "node:crypto";
import prisma from "../db.server";

/**
 * Shared fixed-window rate limit (Postgres, so every app instance sees the same counters). One atomic upsert per call;
 * the key is hashed (it contains a shop id and an IP-derived value) and never linked to any review.
 * Returns true while the caller is within `max` requests per `windowMs`.
 */
export async function rateLimit(key: string, max: number, windowMs: number): Promise<boolean> {
  const k = createHash("sha256").update(`${process.env.IP_HASH_SALT ?? ""}:${key}`).digest("hex");
  const since = new Date(Date.now() - windowMs);
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limits (key, window_start, count) VALUES (${k}, now(), 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start < ${since} THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start < ${since} THEN now() ELSE rate_limits.window_start END
    RETURNING count`;
  return (rows[0]?.count ?? 1) <= max;
}

/** Retention: counters older than a day are useless; the maintenance job deletes them. */
export const purgeRateLimits = () => prisma.$executeRaw`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`;

/** Shopify's app proxy forwards the shopper's IP as the first X-Forwarded-For entry. */
export function clientIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

export function ipHash(ip: string) {
  return createHash("sha256").update(`${process.env.IP_HASH_SALT ?? ""}:${ip}`).digest("hex");
}

export function json(data: unknown, init: ResponseInit & { cache?: number } = {}) {
  const { cache, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", cache ? `public, max-age=${cache}` : "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(data), { ...rest, headers });
}

/**
 * Cross-site POST guard: if the browser sent an Origin, its host must be one of THIS shop's storefront hosts
 * (its myshopify domain or the hosts recorded from Shopify at install). STOREFRONT_ORIGINS is honoured only in
 * development (local preview). No global, cross-merchant allow-list.
 */
export function originAllowed(request: Request, shop: { shopDomain: string; storefrontHosts: string[] }) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // same-origin form posts from some browsers omit it; HMAC + rate limit still apply
  let host: string;
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  if (!origin.startsWith("https://") && process.env.NODE_ENV !== "development") return false;
  if (host === shop.shopDomain || shop.storefrontHosts.includes(host)) return true;
  return process.env.NODE_ENV === "development" && (process.env.STOREFRONT_ORIGINS ?? "").split(",").map((s) => s.trim()).includes(origin);
}
