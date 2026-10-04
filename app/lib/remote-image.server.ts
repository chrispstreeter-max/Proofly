import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import net from "node:net";

/**
 * SSRF-safe download of an image referenced by URL in an import (checkpoint 8).
 *  - https only, port 443, no credentials in the URL
 *  - EVERY address the name resolves to must be public (no private, loopback, link-local, CGNAT, documentation,
 *    multicast, reserved or IPv4-embedded-in-IPv6 ranges); the connection is pinned to the vetted address so a
 *    second DNS answer cannot redirect it (DNS rebinding)
 *  - ≤ 3 redirects, each re-validated; 10 s timeout; size capped while streaming
 * The URL itself is never logged or reported (it may be a private link) — only the outcome code.
 */
export class RemoteImageError extends Error {
  constructor(public code: string) { super(code); }
}

const v4ToInt = (ip: string) => ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const inV4 = (ip: string, cidr: string) => {
  const [base, bits] = cidr.split("/");
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
};
const BLOCKED_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
  "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"];

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4ToInt(v4[1]);
    s = s.replace(v4[1], `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`);
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  if (tail === undefined && h.length !== 8) return null;
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return !BLOCKED_V4.some((c) => inV4(ip, c)) && ip !== "255.255.255.255";
  if (!net.isIPv6(ip)) return false;
  const g = expandV6(ip);
  if (!g) return false;
  const embeddedV4 = (hi: number, lo: number) => `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicAddress(embeddedV4(g[6], g[7])); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPublicAddress(embeddedV4(g[6], g[7])); // NAT64
  if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return false; // :: and ::1
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00) return false; // ULA, link-local, multicast
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return false; // documentation, Teredo
  if (g[0] === 0x2002) return false; // 6to4 (embeds IPv4)
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return false; // discard-only
  return (g[0] & 0xe000) === 0x2000; // global unicast 2000::/3 only
}

export interface Transport {
  lookup(host: string): Promise<{ address: string; family: number }[]>;
  get(o: { url: URL; address: string; family: number; timeoutMs: number }): Promise<{ status: number; location?: string; length?: number; body: AsyncIterable<Buffer>; abort(): void }>;
}

export const realTransport: Transport = {
  lookup: (host) => dnsLookup(host, { all: true, verbatim: true }),
  get: ({ url, address, family, timeoutMs }) => new Promise((resolve, reject) => {
    const req = https.request({
      host: url.hostname, servername: url.hostname, port: 443, path: `${url.pathname}${url.search}`, method: "GET",
      headers: { "User-Agent": "Proofly-Importer/1", Accept: "image/jpeg,image/png,image/webp" },
      lookup: (_h, _o, cb) => cb(null, address, family), // pinned to the vetted address
      timeout: timeoutMs,
    }, (res) => resolve({
      status: res.statusCode ?? 0, location: res.headers.location, length: Number(res.headers["content-length"]) || undefined,
      body: res, abort: () => res.destroy(),
    }));
    req.on("timeout", () => req.destroy(new RemoteImageError("timeout")));
    req.on("error", reject);
    req.end();
  }),
};

export async function fetchRemoteImage(raw: string, opts: { maxBytes: number; timeoutMs?: number; transport?: Transport }): Promise<Buffer> {
  const t = opts.transport ?? realTransport;
  let url: URL;
  try { url = new URL(raw); } catch { throw new RemoteImageError("invalid_url"); }
  for (let hop = 0; hop <= 3; hop++) {
    if (url.protocol !== "https:") throw new RemoteImageError("insecure_url");
    if (url.username || url.password) throw new RemoteImageError("invalid_url");
    if (url.port && url.port !== "443") throw new RemoteImageError("invalid_port");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await t.lookup(host).catch(() => { throw new RemoteImageError("dns_failed"); });
    if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address))) throw new RemoteImageError("blocked_address");
    let res;
    try { res = await t.get({ url, address: addrs[0].address, family: addrs[0].family, timeoutMs: opts.timeoutMs ?? 10_000 }); }
    catch (e) { throw e instanceof RemoteImageError ? e : new RemoteImageError("download_failed"); }
    if ([301, 302, 303, 307, 308].includes(res.status) && res.location) {
      res.abort();
      try { url = new URL(res.location, url); } catch { throw new RemoteImageError("invalid_redirect"); }
      continue;
    }
    if (res.status !== 200) { res.abort(); throw new RemoteImageError(`http_${res.status}`); }
    if (res.length && res.length > opts.maxBytes) { res.abort(); throw new RemoteImageError("too_large"); }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > opts.maxBytes) { res.abort(); throw new RemoteImageError("too_large"); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new RemoteImageError("too_many_redirects");
}
