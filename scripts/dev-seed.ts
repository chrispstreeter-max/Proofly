/**
 * LOCAL DEVELOPMENT ONLY: (re)creates the fictional dev shop (DEV_SHOP_DOMAIN) with a few fictional products and
 * reviews so /dev/preview can show the storefront blocks. Every review state is represented (pending, rejected,
 * hidden, plan-limited) to show they stay off the storefront.
 *   npm run dev:seed
 * Refuses to run unless the database is a local *_dev database. Never run against a real merchant's data.
 */
import { PrismaClient } from "@prisma/client";
import { Session } from "@shopify/shopify-api";
import { recomputeAll } from "../app/lib/aggregates.server";
import { registerShop, withTenant } from "../app/lib/tenant.server";
import { sessionStorage } from "../app/shopify.server";

const domain = process.env.DEV_SHOP_DOMAIN ?? "";
const url = new URL(process.env.DIRECT_DATABASE_URL ?? "postgresql://x/none");
if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_dev") || !/^proofly-dev[\w-]*\.myshopify\.com$/.test(domain)) {
  throw new Error("dev:seed only runs against a local *_dev database and a proofly-dev*.myshopify.com dev shop");
}

const owner = new PrismaClient({ datasources: { db: { url: url.toString() } } });
await owner.shop.deleteMany({ where: { shopDomain: domain } }); // cascades to all of the dev shop's rows
await owner.session.deleteMany({ where: { shop: domain } });
await owner.$disconnect();

const shop = await registerShop({ shopDomain: domain, shopifyShopId: 1n, shopName: "Example Store", storefrontHosts: ["localhost"] });
await sessionStorage.storeSession(new Session({ id: `offline_${domain}`, shop: domain, state: "", isOnline: false, scope: process.env.SCOPES, accessToken: "local-dev-token" }));

const NAMES = ["Alex P.", "Sam R.", "Jordan K.", "Taylor M.", "Casey L.", "Morgan D.", "Riley S.", "Jamie B.", "Avery T.", "Quinn H."];
const TEXT = [
  ["Exactly as described", "Fits well and the material feels sturdy. Would buy again."],
  ["Great value", "Arrived quickly, well packed. Does what it says."],
  ["Good, not perfect", "Nice overall, the colour is a little darker than the photos."],
  ["Love it", "Second one I have bought. Still going strong after months of use."],
  ["", "Solid product. Customer service answered my question the same day."],
  ["Okay", "Works, but the instructions could be clearer."],
];
const PRODUCTS = [
  { handle: "everyday-backpack", title: "Everyday Backpack", reviews: 27 },
  { handle: "canvas-tote", title: "Canvas Tote", reviews: 3 },
  { handle: "travel-mug", title: "Travel Mug", reviews: 0 },
  { handle: "wool-beanie", title: "Wool Beanie", reviews: 8 },
  { handle: "linen-shirt", title: "Linen Shirt", reviews: 12 },
  { handle: "leather-wallet", title: "Leather Wallet", reviews: 5 },
];

let n = 0;
for (const [pi, def] of PRODUCTS.entries()) {
  await withTenant(shop.id, async ({ db, shopId }) => {
    const product = await db.product.create({ data: { shopId, shopifyProductId: BigInt(8_000_000_000_000 + pi), handle: def.handle, title: def.title, status: "active" } });
    // Public reviews, then one of each non-public state (never shown on the storefront).
    const states = [
      ...Array.from({ length: def.reviews }, () => ({ status: "published" as const, holdReason: null })),
      { status: "pending" as const, holdReason: "moderation" as const },
      { status: "rejected" as const, holdReason: null },
      { status: "hidden" as const, holdReason: null },
      { status: "pending" as const, holdReason: "plan_limit" as const },
    ];
    for (const [i, st] of states.entries()) {
      const [title, body] = TEXT[(n + i) % TEXT.length];
      const review = await db.review.create({
        data: {
          shopId, productId: product.id, source: "dev-seed", sourceReviewId: `dev-${pi}-${i}`, rating: [5, 5, 4, 5, 3, 4, 2, 5, 1, 4][(n + i) % 10],
          title, body: st.status === "published" ? body : `[${st.holdReason ?? st.status}] This review must never appear on the storefront.`,
          reviewerName: NAMES[(n + i) % NAMES.length], reviewDate: new Date(Date.UTC(2026, 8, 28 - ((n + i) % 200))), ...st,
        },
      });
      if (i === 1 && st.status === "published") await db.reviewReply.create({ data: { shopId, reviewId: review.id, reply: "Thanks for the kind words!" } });
    }
    n += states.length;
  });
}
await withTenant(shop.id, (t) => recomputeAll(t));
console.log(`dev:seed — ${domain}: ${PRODUCTS.length} fictional products. Open /dev/preview`);
process.exit(0);
