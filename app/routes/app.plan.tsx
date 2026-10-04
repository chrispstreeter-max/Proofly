import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminTenant } from "../lib/admin.server";
import { planSelectionUrl, reconcileBilling, reconcileIfStale } from "../lib/billing.server";
import { getPlanStatus, releaseEligibleReviews } from "../lib/entitlements.server";
import { annualSavingPercent, FEATURES, PLAN_ORDER, PLANS, planHasFeature, type Feature } from "../lib/plans";
import { syncAfterRatingChange } from "../lib/rating-cache.server";
import { withTenant } from "../lib/tenant.server";

// Plan & usage. Plans are chosen, changed and cancelled on Shopify's hosted plan page (Shopify App Pricing); this page
// never accepts a plan, price or subscription from the browser. Returning from Shopify (?plan_handle=…) only triggers
// a re-check with Shopify — the parameter itself is never trusted.

const COMPARISON: { label: string; feature?: Feature }[] = [
  { label: "Review widget, rating summary and product-card stars", feature: "reviewDisplay" },
  { label: "Review moderation", feature: "moderation" },
  { label: "Review import (CSV)", feature: "reviewImport" },
  { label: "Review export (CSV)", feature: "csvExport" },
  { label: "Public replies to reviews", feature: "replies" },
  { label: "Priority support", feature: "prioritySupport" },
];

/** Only shipped features are ever shown (unreleased ones — API, analytics, V1.1 — stay internal). */
const ROWS = COMPARISON.filter((c) => !c.feature || FEATURES[c.feature].released);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, admin } = await requireAdminTenant(request);
  const returned = new URL(request.url).searchParams.has("plan_handle");
  const check = returned ? await reconcileBilling(shop.id, admin.graphql).catch(() => null) : await reconcileIfStale(shop.id, admin.graphql);
  const status = await withTenant(shop.id, (t) => getPlanStatus(t));
  return {
    returned, check: check?.outcome ?? null,
    plan: status.plan.key, state: {
      verification: status.state.verification, shopifyStatus: status.state.shopifyStatus, interval: status.state.interval, test: status.state.test,
      verifiedAt: status.state.verifiedAt?.toISOString().slice(0, 16).replace("T", " ") ?? null, checkError: status.state.checkError,
      currentPeriodEnd: status.state.currentPeriodEnd?.toISOString().slice(0, 10) ?? null,
    },
    usage: status.usage, reviewRoom: status.reviewRoom,
    overReviews: status.overReviewAllowance,
    changePlanUrl: planSelectionUrl(shop.shopDomain),
    plans: PLAN_ORDER.map((k) => ({
      key: k, name: PLANS[k].name, monthly: PLANS[k].monthlyPriceUsd, annual: PLANS[k].annualPriceUsd, saving: annualSavingPercent(k),
      reviews: PLANS[k].publishedReviewAllowance,
      mostPopular: PLANS[k].mostPopular, features: ROWS.map((c) => (c.feature ? planHasFeature(k, c.feature) : false)),
    })),
    comparison: ROWS.map((c) => c.label),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, actor } = await requireAdminTenant(request);
  const intent = (await request.formData()).get("intent");
  if (intent === "refresh") {
    const r = await reconcileBilling(shop.id, admin.graphql, { actor });
    return { message: r.outcome === "confirmed" ? `Plan confirmed with Shopify: ${PLANS[r.plan].name}.` : "Shopify couldn't be reached. Your current plan stays in place; try again shortly." };
  }
  if (intent === "publish_eligible") {
    const r = await withTenant(shop.id, (t) => releaseEligibleReviews(t, { actor }));
    await syncAfterRatingChange(shop.id, admin.graphql);
    return { message: r.released ? `Published ${r.released} review${r.released === 1 ? "" : "s"}${r.stillHeld ? `; ${r.stillHeld} still held by your plan limit` : ""}.` : "No room in your current plan to publish more reviews." };
  }
  return { message: "Unknown action." };
};

const n = (x: number) => x.toLocaleString("en-US");

export default function PlanPage() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const current = d.plans.find((p) => p.key === d.plan)!;
  return (
    <s-page heading="Plan">
      {result && <s-banner tone="info"><s-paragraph>{result.message}</s-paragraph></s-banner>}
      {d.state.verification === "unverified" && (
        <s-banner tone="warning"><s-paragraph>We couldn&apos;t confirm your plan with Shopify just now, so your current plan stays in place. {d.state.checkError ?? ""}</s-paragraph></s-banner>
      )}
      {d.returned && d.check === "confirmed" && <s-banner tone="success"><s-paragraph>Your plan is confirmed with Shopify: {current.name}.</s-paragraph></s-banner>}
      {["pending", "declined", "expired", "cancelled", "frozen"].includes(d.state.shopifyStatus) && (
        <s-banner tone="warning"><s-paragraph>
          {{ pending: "A plan change is waiting for approval in Shopify.", declined: "The last plan change was declined in Shopify.", expired: "The last plan change expired before it was approved.", cancelled: "Your paid subscription was cancelled; you're on Free.", frozen: "Your Shopify subscription is on hold for non-payment, so Free limits apply. Everything already public stays public." }[d.state.shopifyStatus]}
        </s-paragraph></s-banner>
      )}

      <s-section heading={`Current plan: ${current.name}`}>
        <s-stack gap="base">
          <s-paragraph>
            {current.monthly === 0 ? "Free" : d.state.interval === "annual" ? `$${current.annual}/year` : `$${current.monthly}/month`}
            {d.state.test ? " · test subscription (no charge)" : ""}
            {d.state.currentPeriodEnd ? ` · current period ends ${d.state.currentPeriodEnd}` : ""}
            {d.state.verifiedAt ? ` · confirmed with Shopify ${d.state.verifiedAt} UTC` : ""}
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            {d.changePlanUrl && <s-button variant="primary" href={d.changePlanUrl} target="_top">Change plan in Shopify</s-button>}
            <Form method="post"><input type="hidden" name="intent" value="refresh" /><s-button type="submit" loading={busy || undefined}>Check plan with Shopify</s-button></Form>
          </s-stack>
          <s-paragraph>Billing, invoices, plan changes and cancellation are handled by Shopify.</s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Usage">
        <s-stack gap="base">
          <s-paragraph>Published reviews: {n(d.usage.publishedReviews)} of {n(current.reviews)} · Plan-limited: {n(d.usage.planLimitedReviews)} · Awaiting moderation: {n(d.usage.awaitingModeration)}</s-paragraph>
          {d.overReviews && (
            <s-banner tone="warning"><s-paragraph>
              You&apos;re using {n(d.usage.publishedReviews)} published reviews on a plan that includes {n(current.reviews)}. Your existing reviews remain visible.
              New reviews will be held until you upgrade or reduce your published review count.
            </s-paragraph></s-banner>
          )}
          {d.usage.planLimitedReviews > 0 && (
            <Form method="post">
              <s-stack gap="small-200">
                <s-paragraph>{d.reviewRoom > 0 ? `You have ${n(Math.min(d.reviewRoom, d.usage.planLimitedReviews))} eligible review${Math.min(d.reviewRoom, d.usage.planLimitedReviews) === 1 ? "" : "s"} ready to publish (oldest first).` : `${n(d.usage.planLimitedReviews)} approved review${d.usage.planLimitedReviews === 1 ? " is" : "s are"} stored and held by your plan limit.`}</s-paragraph>
                <input type="hidden" name="intent" value="publish_eligible" />
                {d.reviewRoom > 0 && <s-button type="submit" loading={busy || undefined}>Publish eligible reviews</s-button>}
              </s-stack>
            </Form>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Plans">
        <s-table>
          <s-table-header-row>
            <s-table-header>Feature</s-table-header>
            {d.plans.map((p) => <s-table-header key={p.key}>{p.name}{p.mostPopular ? " · Most popular" : ""}{p.key === d.plan ? " (current)" : ""}</s-table-header>)}
          </s-table-header-row>
          <s-table-body>
            <s-table-row><s-table-cell>Monthly</s-table-cell>{d.plans.map((p) => <s-table-cell key={p.key}>{p.monthly === 0 ? "$0" : `$${p.monthly}`}</s-table-cell>)}</s-table-row>
            <s-table-row><s-table-cell>Yearly</s-table-cell>{d.plans.map((p) => <s-table-cell key={p.key}>{p.annual === 0 ? "$0" : `$${p.annual} (save ${p.saving}%)`}</s-table-cell>)}</s-table-row>
            <s-table-row><s-table-cell>Published review allowance</s-table-cell>{d.plans.map((p) => <s-table-cell key={p.key}>{n(p.reviews)}</s-table-cell>)}</s-table-row>
            {d.comparison.map((label, i) => (
              <s-table-row key={label}><s-table-cell>{label}</s-table-cell>{d.plans.map((p) => <s-table-cell key={p.key}>{p.features[i] ? "✓" : "—"}</s-table-cell>)}</s-table-row>
            ))}
          </s-table-body>
        </s-table>
        <s-paragraph>Prices in USD. Shopify shows the final price, including any applicable taxes, before you confirm a plan. Reviews are never deleted because of a plan limit.</s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
