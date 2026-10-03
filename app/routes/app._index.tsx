import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminTenant } from "../lib/admin.server";
import { recomputeAll } from "../lib/aggregates.server";
import { syncCatalog } from "../lib/products.server";
import { setProxyPath } from "../lib/proxy-path.server";
import { ensureRatingDefinitions, reconcileRatingCache, syncRatingCache } from "../lib/rating-cache.server";
import { publishShopProxyPath, withTenant } from "../lib/tenant.server";

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
      db.$queryRaw<{ n: bigint; managed: bigint; errors: bigint }[]>`select
          count(*) filter (where synced_count is distinct from review_count or synced_average is distinct from average_rating) as n,
          count(*) as managed, count(*) filter (where rating_sync_error is not null) as errors
        from products where shop_id = ${shopId}::uuid and rating_ownership = 'proofly_managed' and deleted_at is null`,
    ]);
    // Theme editor deep links: they only open the merchant's editor with the block/embed preselected; the merchant
    // decides whether to save. The app never edits theme files.
    const editor = `https://${shop.shopDomain}/admin/themes/current/editor`;
    const key = process.env.SHOPIFY_API_KEY;
    const status = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all]));
    return {
      stats: { total, published: status.published ?? 0, pending: status.pending ?? 0, rejected: status.rejected ?? 0, hidden: status.hidden ?? 0, withPhotos, verified, flagged, products },
      unsynced: Number(unsynced[0]?.n ?? 0),
      ratings: { managed: Number(unsynced[0]?.managed ?? 0), errors: Number(unsynced[0]?.errors ?? 0) },
      catalog: {
        status: settings?.catalogSyncStatus ?? "never", count: settings?.catalogSyncCount ?? 0,
        finishedAt: settings?.catalogSyncFinishedAt?.toISOString().slice(0, 16).replace("T", " ") ?? null, error: settings?.catalogSyncError ?? null,
      },
      proxy: { path: settings?.proxyPath ?? "", published: settings?.proxyPathPublished === settings?.proxyPath },
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
    await ensureRatingDefinitions(admin.graphql);
    const r = await syncRatingCache(shop.id, admin.graphql);
    await withTenant(shop.id, ({ db, shopId }) => db.auditLog.create({ data: { shopId, actor, action: "ratings.sync", entity: "products", details: r } }));
    return { message: r.failed ? `Ratings synced for ${r.written} products; ${r.failed} will be retried.` : `Ratings synced to Shopify for ${r.written} product${r.written === 1 ? "" : "s"}.` };
  }
  if (intent === "reconcile") {
    const r = await reconcileRatingCache(shop.id, admin.graphql);
    await withTenant(shop.id, ({ db, shopId }) => db.auditLog.create({ data: { shopId, actor, action: "ratings.reconcile", entity: "products", details: { ...r, mismatches: r.mismatches.length } } }));
    return { message: `Checked ${r.checked} Proofly-rated products: ${r.ok} correct, ${r.missing} missing, ${r.incorrect} incorrect, ${r.repaired} repaired${r.failed ? `, ${r.failed} to retry` : ""}.` };
  }
  if (intent === "sync_products") {
    // Runs in the background through this shop's own Admin API client; progress is shown on reload.
    void syncCatalog(shop.id, admin.graphql).catch((e) => console.error("catalogue sync", shop.id, e));
    return { message: "Product sync started." };
  }
  if (intent === "proxy_path") {
    const path = await withTenant(shop.id, (t) => setProxyPath(t, form.get("proxy_path"), actor));
    if (!path) return { message: "Enter the proxy path exactly as set in Shopify, e.g. /apps/reviews." };
    const ok = await publishShopProxyPath(shop.id, admin.graphql).then(() => true, () => false);
    return { message: ok ? `Storefront proxy path set to ${path}.` : `Saved ${path}; publishing it to your theme will be retried.` };
  }
  if (intent === "complete_onboarding") {
    await withTenant(shop.id, async ({ db, shopId }) => {
      await db.shopSettings.update({ where: { shopId }, data: { onboardingCompletedAt: new Date() } });
      await db.auditLog.create({ data: { shopId, actor, action: "onboarding.completed", entity: "shop", entityId: shopId } });
    });
    void syncCatalog(shop.id, admin.graphql).catch((e) => console.error("catalogue sync", shop.id, e)); // first catalogue import
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
  const { stats, unsynced, onboarding, ratings, catalog, proxy } = useLoaderData<typeof loader>();
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
            Ratings are calculated from your published reviews in Proofly and copied to Shopify&apos;s standard product
            rating fields (<code>reviews.rating</code>, <code>reviews.rating_count</code>). Proofly manages these fields
            only for the {ratings.managed} product{ratings.managed === 1 ? "" : "s"} that have Proofly reviews; ratings
            from any other app are left untouched.
            {unsynced > 0 ? ` ${unsynced} product${unsynced === 1 ? " needs" : "s need"} syncing.` : " Everything is in sync."}
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <Form method="post"><input type="hidden" name="intent" value="sync" /><s-button type="submit" variant="primary" loading={busy || undefined}>Sync ratings to Shopify</s-button></Form>
            <Form method="post"><input type="hidden" name="intent" value="reconcile" /><s-button type="submit" loading={busy || undefined}>Check Shopify ratings</s-button></Form>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Products">
        <s-stack gap="base">
          <s-paragraph>
            {catalog.status === "never" ? "Your products haven't been imported yet." : `Last sync: ${catalog.status}${catalog.finishedAt ? ` (${catalog.finishedAt} UTC)` : ""} — ${catalog.count} products.`}
            {catalog.error ? ` Last error: ${catalog.error}` : ""} New and changed products then stay in sync automatically.
          </s-paragraph>
          <Form method="post"><input type="hidden" name="intent" value="sync_products" /><s-button type="submit" loading={busy || undefined}>Sync products</s-button></Form>
        </s-stack>
      </s-section>

      <s-section heading="Storefront connection">
        <Form method="post">
          <s-stack gap="base">
            <input type="hidden" name="intent" value="proxy_path" />
            <s-text-field name="proxy_path" label="App proxy path" value={proxy.path} details="Only change this if you changed Proofly's app proxy URL in Shopify (Settings → Apps). It must match exactly." />
            {!proxy.published && <s-paragraph>Not yet published to your theme.</s-paragraph>}
            <s-button type="submit" loading={busy || undefined}>Save proxy path</s-button>
          </s-stack>
        </Form>
      </s-section>

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
