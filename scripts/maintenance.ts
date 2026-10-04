/** Scheduled maintenance entry point (production: run hourly from the platform scheduler). See app/lib/maintenance.server.ts. */
import prisma from "../app/db.server";
import { runMaintenance } from "../app/lib/maintenance.server";
import { unauthenticated } from "../app/shopify.server";

// The daily recount and projection retries need each installed shop's Admin API (offline session).
const report = await runMaintenance(new Date(), async (shopId) => {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop || shop.uninstalledAt) return null;
  const { admin } = await unauthenticated.admin(shop.shopDomain);
  return { shopId, graphql: (q, o) => admin.graphql(q, o) };
});
console.log(JSON.stringify({ maintenance: report, at: new Date().toISOString() }));
process.exit(0);
