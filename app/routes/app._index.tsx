import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminTenant } from "../lib/admin.server";
import { recomputeAll } from "../lib/aggregates.server";
import { reconcileIfStale } from "../lib/billing.server";
import { getPlanStatus } from "../lib/entitlements.server";
import { syncCatalog } from "../lib/products.server";
import { ensureRatingDefinitions, reconcileRatingCache, syncRatingCache } from "../lib/rating-cache.server";
import { withTenant } from "../lib/tenant.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, admin } = await requireAdminTenant(request);
  await reconcileIfStale(shop.id, admin.graphql); // plan follows Shopify; failures keep the current plan
  return withTenant(shop.id, async (t) => {
    const { db, shopId } = t;
    const planStatus = await getPlanStatus(t);
    const lastImport = await db.importJob.findFirst({ where: { shopId }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, counts: true, analysis: true } });
    const [settings, byStatus, total, flagged, products, unsynced] = await Promise.all([
      db.shopSettings.findUnique({ where: { shopId } }),
      db.review.groupBy({ by: ["status"], where: { shopId }, _count: { _all: true } }),
      db.review.count({ where: { shopId } }),
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
      stats: { total, published: status.published ?? 0, pending: status.pending ?? 0, rejected: status.rejected ?? 0, hidden: status.hidden ?? 0, flagged, products },
      unsynced: Number(unsynced[0]?.n ?? 0),
      lastImport: lastImport && {
        id: lastImport.id,
        status: lastImport.status.replaceAll("_", " "),
        imported: (lastImport.counts as Record<string, number>).imported ?? 0, published: (lastImport.counts as Record<string, number>).published ?? 0,
        planLimited: (lastImport.counts as Record<string, number>).planLimited ?? 0,
        unmatched: (lastImport.analysis as Record<string, number>).unmatchedRows ?? 0, ambiguous: (lastImport.analysis as Record<string, number>).ambiguousRows ?? 0,
      },
      plan: {
        name: planStatus.plan.name, allowance: planStatus.plan.publishedReviewAllowance,
        published: planStatus.usage.publishedReviews, planLimited: planStatus.usage.planLimitedReviews, awaiting: planStatus.usage.awaitingModeration,
        over: planStatus.overReviewAllowance, room: planStatus.reviewRoom, unverified: planStatus.state.verification === "unverified",
      },
      ratings: { managed: Number(unsynced[0]?.managed ?? 0), errors: Number(unsynced[0]?.errors ?? 0) },
      catalog: {
        status: settings?.catalogSyncStatus ?? "never", count: settings?.catalogSyncCount ?? 0,
        finishedAt: settings?.catalogSyncFinishedAt?.toISOString().slice(0, 16).replace("T", " ") ?? null, error: settings?.catalogSyncError ?? null,
      },
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
  const { stats, unsynced, onboarding, ratings, catalog, plan, lastImport } = useLoaderData<typeof loader>();
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
            <s-paragraph>Coming from another review app? <s-link href="/app/imports">Bring your existing reviews with you</s-link> — nothing is published until you start the import.</s-paragraph>
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
      <s-section heading={`Reviews on the ${plan.name} plan`}>
        <s-stack gap="base">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="base">
            <Stat label="Published" value={plan.published} href="/app/plan" />
            <Stat label="Plan allowance" value={plan.allowance} href="/app/plan" />
            <Stat label="Plan-limited" value={plan.planLimited} href="/app/plan" />
            <Stat label="Awaiting moderation" value={plan.awaiting} href="/app/reviews?status=pending" />
          </s-grid>
          {plan.over && (
            <s-banner tone="warning"><s-paragraph>
              You&apos;re using {plan.published.toLocaleString("en-US")} published reviews on a plan that includes {plan.allowance.toLocaleString("en-US")}.
              Your existing reviews remain visible. New reviews will be held until you upgrade.
            </s-paragraph></s-banner>
          )}
          {plan.planLimited > 0 && plan.room > 0 && <s-paragraph>You have reviews ready to publish. <s-link href="/app/plan">Publish eligible reviews</s-link></s-paragraph>}
          {lastImport && (
            <s-paragraph>
              Latest import: {lastImport.status} — {lastImport.imported} imported, {lastImport.published} published, {lastImport.planLimited} plan-limited,
              {" "}{lastImport.unmatched} unmatched, {lastImport.ambiguous} ambiguous. <s-link href={`/app/imports/${lastImport.id}`}>{lastImport.unmatched + lastImport.ambiguous ? "Resolve products" : "View import"}</s-link>
            </s-paragraph>
          )}
          {plan.unverified && <s-paragraph>Plan not yet confirmed with Shopify.</s-paragraph>}
        </s-stack>
      </s-section>

      <s-section heading="Overview">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="base">
          <Stat label="Total reviews" value={stats.total} href="/app/reviews" />
          <Stat label="Published" value={stats.published} href="/app/reviews?status=published" />
          <Stat label="Pending" value={stats.pending} href="/app/reviews?status=pending" />
          <Stat label="Rejected" value={stats.rejected} href="/app/reviews?status=rejected" />
          <Stat label="Hidden" value={stats.hidden} href="/app/reviews?status=hidden" />
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
            {ratings.errors > 0 ? ` ${ratings.errors} product${ratings.errors === 1 ? "" : "s"} could not be updated last time; syncing again retries ${ratings.errors === 1 ? "it" : "them"}.` : ""}
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

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
