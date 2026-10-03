import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { devShop, isDev, signProxyParams } from "../lib/devsign.server";
import { withTenant } from "../lib/tenant.server";

// DEV ONLY: stands in for Shopify's app proxy (store/apps/<subpath>/* → app /proxy/*) for the local dev shop, using
// that shop's configured proxy path. It signs the request exactly like Shopify does, so the real HMAC and
// path_prefix verification in the /proxy routes runs. Returns 404 outside development.

async function forward(request: Request, splat: string) {
  const shop = isDev() ? await devShop() : null;
  if (!shop) return new Response("Not found", { status: 404 });
  const proxyPath = await withTenant(shop.id, ({ db, shopId }) => db.shopSettings.findUniqueOrThrow({ where: { shopId } })).then((s) => s.proxyPath);
  const full = `/apps/${splat}`;
  if (!full.startsWith(`${proxyPath}/`)) return new Response("Not found", { status: 404 });
  const path = full.slice(proxyPath.length + 1);
  const url = new URL(request.url);
  const params = new URLSearchParams(url.search);
  params.set("shop", shop.shopDomain);
  params.set("path_prefix", proxyPath);
  params.set("timestamp", String(Math.floor(Date.now() / 1000)));
  if (url.searchParams.get("as_customer")) params.set("logged_in_customer_id", url.searchParams.get("as_customer")!);
  else params.set("logged_in_customer_id", "");
  params.delete("as_customer");
  signProxyParams(params, process.env.SHOPIFY_API_SECRET ?? "");
  const target = `${url.origin}/proxy/${path}?${params}`;
  const res = await fetch(target, {
    method: request.method,
    headers: Object.fromEntries(
      [["x-forwarded-for", "127.0.0.1"], ...["content-type", "origin"].flatMap((h) => (request.headers.get(h) ? [[h, request.headers.get(h)!]] : []))],
    ),
    body: request.method === "GET" ? undefined : await request.arrayBuffer(),
    redirect: "manual",
  });
  const headers = new Headers(res.headers);
  // Shopify renders application/liquid inside the theme; locally just show the HTML.
  if (headers.get("content-type")?.startsWith("application/liquid")) headers.set("content-type", "text/html; charset=utf-8");
  return new Response(res.body, { status: res.status, headers });
}

export const loader = ({ request, params }: LoaderFunctionArgs) => forward(request, params["*"] ?? "");
export const action = ({ request, params }: ActionFunctionArgs) => forward(request, params["*"] ?? "");
