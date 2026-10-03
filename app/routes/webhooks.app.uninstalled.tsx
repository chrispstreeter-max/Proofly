import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { markUninstalled } from "../lib/tenant.server";

// app/uninstalled (HMAC-verified): the tenant becomes inactive immediately — admin and storefront stop serving it —
// and its sessions (access tokens) are deleted. Merchant data is retained until shop/redact (deletion: checkpoint 10).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);
  await db.session.deleteMany({ where: { shop } }); // idempotent: webhooks may be delivered more than once
  await markUninstalled(shop);
  return new Response();
};
