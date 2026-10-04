import dns from "node:dns";
import net from "node:net";

// Preloaded before every test file (npm test: --import): the suite must never reach the network. The Shopify library
// captures globalThis.fetch when it loads, so this runs first. Only the local test server may be called.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  // Admin API calls of a test shop go to that shop's in-memory FakeShopify (tests/helpers.ts registers the handler).
  const fake = (globalThis as { __prooflyFakeAdmin?: (url: URL, init?: RequestInit) => Promise<Response> }).__prooflyFakeAdmin;
  if (fake && url.hostname.endsWith(".myshopify.com") && url.pathname.includes("/admin/api/")) return fake(url, init);
  // Shopify's staged-upload storage for bulk operations: the test shop's in-memory storage (tests/helpers.ts).
  const storage = (globalThis as { __prooflyFakeStorage?: (url: URL, init?: RequestInit) => Promise<Response> }).__prooflyFakeStorage;
  if (storage && url.hostname === "fake-shopify-storage.test") return storage(url, init);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new TypeError(`network access blocked in tests: ${url.host}`);
  return realFetch(input, init);
}) as typeof fetch;

// Also guard raw sockets (node:https / node:net — used by the remote-image fetcher), not only fetch().
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const o = (typeof args[0] === "object" && args[0] !== null ? args[0] : { port: args[0], host: typeof args[1] === "string" ? args[1] : undefined }) as { host?: string; path?: string };
  if (!o.path && !LOCAL.has(o.host ?? "localhost")) {
    process.nextTick(() => this.destroy(new Error(`network access blocked in tests: ${o.host}`)));
    return this;
  }
  return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

// …and DNS: name resolution of anything but localhost is refused (dns.lookup does not go through sockets).
const realLookup = dns.lookup;
const blockedLookup = ((host: string, ...rest: unknown[]) => {
  const cb = rest[rest.length - 1] as (e: Error | null) => void;
  if (LOCAL.has(host)) return (realLookup as (...a: unknown[]) => void)(host, ...rest);
  process.nextTick(() => cb(new Error(`network access blocked in tests: dns ${host}`)));
}) as typeof dns.lookup;
dns.lookup = blockedLookup;
const realPromisesLookup = dns.promises.lookup;
dns.promises.lookup = ((host: string, ...rest: unknown[]) =>
  LOCAL.has(host)
    ? (realPromisesLookup as (...a: unknown[]) => Promise<unknown>)(host, ...rest)
    : Promise.reject(new Error(`network access blocked in tests: dns ${host}`))) as typeof dns.promises.lookup;
