import { databaseReachable } from "../lib/http.server";

// GET /healthz — platform health check. Reveals nothing but up/down.
export const loader = async () =>
  (await databaseReachable())
    ? new Response("ok", { headers: { "Cache-Control": "no-store" } })
    : new Response("database unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
