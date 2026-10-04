// Preloaded before every test file (npm test: --import): the suite must never reach the network. The Shopify library
// captures globalThis.fetch when it loads, so this runs first. Only the local test server may be called.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new TypeError(`network access blocked in tests: ${url.host}`);
  return realFetch(input, init);
}) as typeof fetch;
