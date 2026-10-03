import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminTenant } from "../lib/admin.server";
import { ensureReviewMetafieldDefinitions, recomputeAll, syncMetafields } from "../lib/aggregates.server";
import { withTenant } from "../lib/tenant.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdminTenant(request);
  return withTenant(shop.id, async ({ db, shopId }) => {
    const [settings, byStatus, total, withPhotos, verified, flagged, products, unsynced] = await Promise.all([
      db.shopSettings.findUnique({ where: { shopId } }),
      db.review.groupBy({ by: ["status"], where: { shopId }, _count: { _all: true } }),
      db.review.count({ where: { shopId } }),
      db.review.count({ where: { shopId, images: { some: {} } } }),
      db.review.count({ where: { shopId, verifiedPurchase: true } }),
      db.review.count({ where: { shopId, NOT: { flags: { isEmpty: true } } } }),
      db.product.count({ where: { shopId, reviewCount: { gt: 0 } } }),
      db.$queryRaw<{ n: bigint }[]>`select count(*) as n from products where shop_id = ${shopId}::uuid
        and (synced_count is distinct from review_count or synced_average is distinct from average_rating)`,
    ]);
    // Theme editor deep links: they only open the merchant's editor with the block/embed preselected; the merchant
    // decides whether to save. The app never edits theme files.
    const editor = `https://${shop.shopDomain}/admin/themes/current/editor`;
    const key = process.env.SHOPIFY_API_KEY;
    const status = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all]));
    return {
      stats: { total, published: status.published ?? 0, pending: status.pending ?? 0, rejected: status.rejected ?? 0, hidden: status.hidden ?? 0, withPhotos, verified, flagged, products },
      unsynced: Number(unsynced[0]?.n ?? 0),
      onboarding: {
        done: !!settings?.onboardingCompletedAt,
        reviewsBlockUrl: `${editor}?template=product&addAppBlockId=${key}/reviews&target=mainSection`,
        summaryBlockUrl: `${editor}?template=product&addAppBlockId=${key}/rating-summary&target=mainSection`,
        ratingsEmbedUrl: `${editor}?context=apps&activateAppId=${key}/card-ratings`,
      },
    };
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, actor, shop } = await requireAdminTenant(request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "sync") {
    await withTenant(shop.id, (t) => recomputeAll(t));
    await ensureReviewMetafieldDefinitions(admin.graphql);
    const n = await syncMetafields(shop.id, admin.graphql);
    await withTenant(shop.id, ({ db, shopId }) => db.auditLog.create({ data: { shopId, actor, action: "metafields.sync", entity: "products", details: { written: n } } }));
    return { message: `Ratings synced to Shopify for ${n} product${n === 1 ? "" : "s"}.` };
  }
  if (intent === "complete_onboarding") {
    await withTenant(shop.id, async ({ db, shopId }) => {
      await db.shopSettings.update({ where: { shopId }, data: { onboardingCompletedAt: new Date() } });
      await db.auditLog.create({ data: { shopId, actor, action: "onboarding.completed", entity: "shop", entityId: shopId } });
    });
    return { message: "Setup complete." };
  }
  return { message: "Unknown action." };
};

const Stat = ({ label, value, href }: { label: string; value: number; href?: string }) => (
  <s-box padding="base" border="base" borderRadius="base" background="base">
    <s-stack gap="small-200">
      <s-text color="subdued">{label}</s-text>
      {href ? <s-link href={href}><s-heading>{value.toLocaleString()}</s-heading></s-link> : <s-heading>{value.toLocaleString()}</s-heading>}
    </s-stack>
  </s-box>
);

export default function Dashboard() {
  const { stats, unsynced, onboarding } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  return (
    <s-page heading="Proofly">
      {result && (
        <s-banner tone="info">
          <s-paragraph>{result.message}</s-paragraph>
        </s-banner>
      )}
      {!onboarding.done && (
        <s-section heading="Set up Proofly">
          <s-stack gap="base">
            <s-paragraph>Your Proofly account is ready and empty. Three steps to start collecting reviews:</s-paragraph>
            <s-ordered-list>
              <s-list-item>
                Add the <strong>Review widget</strong> block to your product page (and, optionally, the{" "}
                <strong>Rating summary</strong> block near the product title).{" "}
                <s-link href={onboarding.reviewsBlockUrl} target="_blank">Add review widget</s-link>{" · "}
                <s-link href={onboarding.summaryBlockUrl} target="_blank">Add rating summary</s-link>
              </s-list-item>
              <s-list-item>
                Product cards: if your theme has a “Show product rating” setting, turn it on — it uses Proofly ratings
                directly. Otherwise turn on the <strong>Product card stars</strong> app embed.{" "}
                <s-link href={onboarding.ratingsEmbedUrl} target="_blank">Open app embeds</s-link>
              </s-list-item>
              <s-list-item>
                New reviews arrive as <strong>pending</strong>. Approve them under <s-link href="/app/reviews">Reviews</s-link>.
              </s-list-item>
            </s-ordered-list>
            <Form method="post">
              <input type="hidden" name="intent" value="complete_onboarding" />
              <s-button type="submit" variant="primary" loading={busy || undefined}>Finish setup</s-button>
            </Form>
          </s-stack>
        </s-section>
      )}
      <s-section heading="Overview">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="base">
          <Stat label="Total reviews" value={stats.total} href="/app/reviews" />
          <Stat label="Published" value={stats.published} href="/app/reviews?status=published" />
          <Stat label="Pending" value={stats.pending} href="/app/reviews?status=pending" />
          <Stat label="Rejected" value={stats.rejected} href="/app/reviews?status=rejected" />
          <Stat label="Hidden" value={stats.hidden} href="/app/reviews?status=hidden" />
          <Stat label="With photos" value={stats.withPhotos} href="/app/reviews?photos=yes" />
          <Stat label="Verified purchases" value={stats.verified} href="/app/reviews?verified=yes" />
          <Stat label="Flagged for review" value={stats.flagged} href="/app/reviews?flagged=yes" />
          <Stat label="Products with reviews" value={stats.products} />
        </s-grid>
      </s-section>

      <s-section heading="Storefront ratings">
        <s-stack gap="base">
          <s-paragraph>
            Product ratings are calculated from published reviews in this app and copied to Shopify
            (<code>reviews.rating</code>, <code>reviews.rating_count</code>) for the product page and search engines.
            {unsynced > 0 ? ` ${unsynced} product${unsynced === 1 ? " needs" : "s need"} syncing.` : " Everything is in sync."}
          </s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="sync" />
            <s-button type="submit" variant="primary" loading={busy || undefined}>Sync ratings to Shopify</s-button>
          </Form>
        </s-stack>
      </s-section>

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
