import { Prisma } from "@prisma/client";
import { PLAN_ORDER, PLANS, planForHandle, type PlanKey } from "./plans";
import { withTenant } from "./tenant.server";

/**
 * Shopify App Pricing is the billing authority (docs/BILLING.md). Merchants choose, change and cancel plans on Shopify's
 * hosted plan page; Proofly never creates charges, never sees payment data and never trusts a plan from the client.
 *
 * Reconciliation reads the shop's own Admin API (currentAppInstallation — verified against the 2026-10 schema):
 *   an ACTIVE subscription whose line item's AppRecurringPricing.planHandle maps to a Proofly plan → that plan (confirmed)
 *   no ACTIVE subscription → Free (confirmed); the latest subscription's status explains why (pending, declined, …)
 *   FROZEN (non-payment) → Free limits (confirmed); grandfathering keeps everything already public
 *   ACTIVE but unknown/null planHandle, or any API/network failure → UNVERIFIED: the last plan is kept as is.
 *   A failure never downgrades; nothing but a confirmed Shopify subscription ever upgrades.
 * App Pricing sends no subscription webhooks (since 2026-04-28), so reconciliation runs on install/token refresh, on
 * return from Shopify's plan page, when the admin finds the state stale, and on demand.
 */

type Graphql = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;

export const SUBSCRIPTION_STATE_QUERY = `#graphql
  query ProoflySubscriptionState {
    currentAppInstallation {
      activeSubscriptions { ...ProoflySubscription }
      allSubscriptions(first: 5, sortKey: CREATED_AT, reverse: true) { nodes { ...ProoflySubscription } }
    }
  }
  fragment ProoflySubscription on AppSubscription {
    id name status test trialDays createdAt currentPeriodEnd
    lineItems { plan { pricingDetails { __typename ... on AppRecurringPricing { planHandle interval price { amount currencyCode } } } } }
  }`;

interface ShopifySubscription {
  id: string; name: string; status: string; test: boolean; trialDays: number; createdAt: string; currentPeriodEnd: string | null;
  lineItems: { plan: { pricingDetails: { __typename: string; planHandle?: string | null; interval?: string; price?: { amount: string; currencyCode: string } } } }[];
}

const recurring = (s: ShopifySubscription) => s.lineItems.map((li) => li.plan.pricingDetails).find((p) => p.__typename === "AppRecurringPricing");
const intervalOf = (s: ShopifySubscription) => ({ ANNUAL: "annual", EVERY_30_DAYS: "monthly" })[recurring(s)?.interval ?? ""] ?? null;

export type BillingOutcome = "confirmed" | "unverified";
export interface ReconcileResult { outcome: BillingOutcome; plan: PlanKey; previousPlan: PlanKey; changed: boolean; shopifyStatus: string; error?: string }

/** Pure decision: Shopify's subscription data → Proofly entitlement. Exported for tests. */
export function decide(active: ShopifySubscription[], recent: ShopifySubscription[]) {
  const newest = (xs: ShopifySubscription[]) => [...xs].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
  const live = newest(active.filter((s) => s.status === "ACTIVE"));
  if (live) {
    const handle = recurring(live)?.planHandle ?? null;
    const plan = planForHandle(handle);
    if (!plan) return { kind: "unverified" as const, error: `Active Shopify subscription has an unknown plan handle (${handle ?? "null"})`, sub: live };
    return { kind: "confirmed" as const, plan, shopifyStatus: "active", sub: live };
  }
  const frozen = newest(active.filter((s) => s.status === "FROZEN"));
  if (frozen) return { kind: "confirmed" as const, plan: "FREE" as PlanKey, shopifyStatus: "frozen", sub: frozen };
  const latest = newest(recent);
  return { kind: "confirmed" as const, plan: "FREE" as PlanKey, shopifyStatus: latest ? latest.status.toLowerCase() : "none", sub: null };
}

/**
 * Reads Shopify, applies the result to this shop's billing state, caches the subscriptions, and audits real changes
 * only (no rows for routine checks). Never publishes or hides reviews: upgrades make room, the merchant then chooses
 * "Publish eligible reviews"; downgrades are grandfathered.
 */
export async function reconcileBilling(shopId: string, graphql: Graphql, opts: { actor?: string } = {}): Promise<ReconcileResult> {
  const actor = opts.actor ?? "shopify";
  let active: ShopifySubscription[] = [];
  let recent: ShopifySubscription[] = [];
  let failure: string | null = null;
  try {
    const body = (await (await graphql(SUBSCRIPTION_STATE_QUERY)).json()) as { data?: { currentAppInstallation?: { activeSubscriptions: ShopifySubscription[]; allSubscriptions: { nodes: ShopifySubscription[] } } }; errors?: unknown };
    const inst = body.data?.currentAppInstallation;
    if (body.errors || !inst) failure = `Shopify billing state unavailable: ${JSON.stringify(body.errors ?? "no data").slice(0, 200)}`;
    else { active = inst.activeSubscriptions ?? []; recent = inst.allSubscriptions?.nodes ?? []; }
  } catch (e) {
    failure = `Shopify billing API unreachable: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`;
  }

  return withTenant(shopId, async ({ db }) => {
    const before = (await db.billingState.findUnique({ where: { shopId } })) ?? (await db.billingState.create({ data: { shopId } }));
    const audit = (action: string, details: Prisma.InputJsonValue) => db.auditLog.create({ data: { shopId, actor, action, entity: "billing", entityId: shopId, details } });
    const d = failure ? { kind: "unverified" as const, error: failure, sub: null } : decide(active, recent);

    // Cache what Shopify reported (idempotent upsert per subscription id).
    for (const s of failure ? [] : [...active, ...recent]) {
      const r = recurring(s);
      const data = {
        plan: planForHandle(r?.planHandle), planHandle: r?.planHandle ?? null, name: s.name, status: s.status.toLowerCase(), interval: intervalOf(s),
        priceAmount: r?.price ? new Prisma.Decimal(r.price.amount) : null, currencyCode: r?.price?.currencyCode ?? null, test: s.test,
        trialDays: s.trialDays, currentPeriodEnd: s.currentPeriodEnd ? new Date(s.currentPeriodEnd) : null, shopifyCreatedAt: new Date(s.createdAt),
      };
      await db.subscription.upsert({ where: { shopId_shopifySubscriptionId: { shopId, shopifySubscriptionId: s.id } }, create: { shopId, shopifySubscriptionId: s.id, ...data }, update: data });
    }

    if (d.kind === "unverified") {
      // Keep the last plan exactly as it was. Audit only the transition into "unverified", not every failed check.
      await db.billingState.update({ where: { shopId }, data: { verification: "unverified", checkError: d.error } });
      if (before.verification !== "unverified") await audit("billing.verification_failed", { plan: before.plan, error: d.error });
      return { outcome: "unverified", plan: before.plan, previousPlan: before.plan, changed: false, shopifyStatus: before.shopifyStatus, error: d.error };
    }

    const sub = d.sub;
    const changedPlan = d.plan !== before.plan;
    await db.billingState.update({
      where: { shopId },
      data: {
        plan: d.plan, verification: "confirmed", shopifyStatus: d.shopifyStatus, checkError: null, verifiedAt: new Date(),
        shopifySubscriptionId: sub?.id ?? null, planHandle: sub ? recurring(sub)?.planHandle ?? null : null, interval: sub && d.shopifyStatus === "active" ? intervalOf(sub) : null,
        test: sub?.test ?? false, trialDays: sub?.trialDays ?? 0, currentPeriodEnd: sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null,
        ...(changedPlan ? { planChangedAt: new Date() } : {}),
      },
    });
    if (changedPlan) {
      const direction = PLAN_ORDER.indexOf(d.plan) > PLAN_ORDER.indexOf(before.plan) ? "upgrade" : "downgrade";
      await audit(`billing.plan_${direction}d`, { from: before.plan, to: d.plan, allowance: PLANS[d.plan].publishedReviewAllowance, shopifySubscriptionId: sub?.id ?? null });
    }
    if (d.shopifyStatus !== before.shopifyStatus) {
      await audit(`billing.subscription_${d.shopifyStatus}`, { from: before.shopifyStatus, to: d.shopifyStatus, shopifySubscriptionId: sub?.id ?? null });
    }
    return { outcome: "confirmed", plan: d.plan, previousPlan: before.plan, changed: changedPlan, shopifyStatus: d.shopifyStatus };
  });
}

const STALE_MS = 10 * 60_000;

/** Admin loaders: re-check Shopify when the cached state is older than 10 minutes (or never verified). Best effort. */
export async function reconcileIfStale(shopId: string, graphql: Graphql) {
  const s = await withTenant(shopId, ({ db }) => db.billingState.findUnique({ where: { shopId } }));
  if (s?.verifiedAt && Date.now() - +s.verifiedAt < STALE_MS) return null;
  return reconcileBilling(shopId, graphql).catch((e) => { console.warn("billing reconcile failed", shopId, e); return null; });
}

/** Shopify's hosted plan selection page for this shop (upgrades, downgrades, monthly/annual, cancellation). */
export function planSelectionUrl(shopDomain: string) {
  const app = process.env.SHOPIFY_APP_HANDLE;
  if (!app) return null;
  return `https://admin.shopify.com/store/${shopDomain.replace(/\.myshopify\.com$/, "")}/charges/${encodeURIComponent(app)}/pricing_plans`;
}
