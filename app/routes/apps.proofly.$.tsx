import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { isDev, signProxyParams } from "../lib/devsign.server";

// DEV ONLY: stands in for Shopify's app proxy (shop.com/apps/proofly/* → app /proxy/*) so the storefront
// widget can be exercised locally. It signs the request exactly like Shopify does, so the real
// HMAC verification in the /proxy routes runs. Returns 404 in production.

async function forward(request: Request, path: string) {
  if (!isDev()) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const params = new URLSearchParams(url.search);
  params.set("shop", process.env.DEV_SHOP_DOMAIN ?? "proofly-dev.myshopify.com");
  params.set("path_prefix", "/apps/proofly");
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
