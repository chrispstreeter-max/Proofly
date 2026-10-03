import { createHash } from "node:crypto";

// ponytail: in-memory fixed-window limiter — correct for the single app instance V1 runs on;
// move to a Postgres/Redis counter if the app is ever scaled horizontally.
const hits = new Map<string, { n: number; reset: number }>();

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) {
    hits.set(key, { n: 1, reset: now + windowMs });
    if (hits.size > 50_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return true;
  }
  return ++h.n <= max;
}

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

/** Cross-site POST guard: if the browser sent an Origin, it must be one of the store's own origins. */
export function originAllowed(request: Request, shop: string | null | undefined) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // same-origin form posts from some browsers omit it; HMAC + rate limit still apply
  const allowed = new Set(
    [`https://${shop}`, ...(process.env.STOREFRONT_ORIGINS ?? "").split(",")].map((s) => s.trim()).filter(Boolean),
  );
  return allowed.has(origin);
}
