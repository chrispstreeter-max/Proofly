// Liveness for the host's health check (Render): the process is up. It deliberately does NOT touch the database, so a
// serverless Postgres (Neon) can scale to zero between real requests. Database health stays on /healthz.
export const loader = () => new Response("ok", { headers: { "Cache-Control": "no-store" } });
