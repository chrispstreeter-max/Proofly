import { authenticate } from "../shopify.server";

/** Admin auth + an actor id for the audit log (Shopify staff user id from the session token when present). */
export async function adminContext(request: Request) {
  const ctx = await authenticate.admin(request);
  const sub = (ctx as { sessionToken?: { sub?: string } }).sessionToken?.sub;
  return { ...ctx, actor: sub ? `staff:${sub}` : `admin:${ctx.session.shop}` };
}
