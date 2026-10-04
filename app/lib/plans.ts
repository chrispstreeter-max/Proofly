/**
 * THE Proofly plan configuration — the only place plan names, prices, allowances and features are defined.
 * Prices are display values: the authoritative amount is whatever the merchant's Shopify App Pricing subscription
 * says (Shopify bills; Proofly never charges). `shopifyPlanHandle` must equal the plan handle configured for that
 * plan in the Partner Dashboard (Shopify App Pricing); it is how a Shopify subscription maps to a Proofly plan.
 */
export type PlanKey = "FREE" | "STARTER" | "GROWTH" | "PRO" | "SCALE";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/**
 * Features. `released: false` = exists in the commercial model but is not built: never enabled, never shown.
 * Turning a feature on is a code change here once it ships — never a per-plan flag alone.
 */
export const FEATURES = {
  reviewDisplay: { label: "Review widget, rating summary and product-card stars", released: true },
  photoReviews: { label: "Photo reviews", released: true },
  moderation: { label: "Review moderation", released: true },
  replies: { label: "Public replies to reviews", released: true },
  prioritySupport: { label: "Priority support", released: true },
  reviewImport: { label: "Review import", released: false }, // importer UI: checkpoint 8
  csvExport: { label: "CSV export", released: false },
  unlimitedMigration: { label: "Unlimited review migration", released: false },
  advancedCustomisation: { label: "Advanced widget customisation", released: false },
  advancedAnalytics: { label: "Advanced analytics", released: false },
  apiAccess: { label: "API access", released: false }, // no public API exists
  reviewRequests: { label: "Automated review requests", released: false }, // V1.1
  verifiedPurchase: { label: "Verified purchases", released: false }, // V1.1
} as const;
export type Feature = keyof typeof FEATURES;

export interface Plan {
  key: PlanKey;
  name: string;
  shopifyPlanHandle: string;
  monthlyPriceUsd: number;
  annualPriceUsd: number;
  publishedReviewAllowance: number;
  publicMediaBytes: number;
  isFree: boolean;
  mostPopular: boolean;
  features: readonly Feature[];
  /** Future entitlements, inert until the feature is released (FEATURES). */
  reviewRequestsPerMonth: number;
}

const BASE: Feature[] = ["reviewDisplay", "photoReviews", "moderation", "reviewImport", "csvExport"];
const STARTER: Feature[] = [...BASE, "replies", "advancedCustomisation"];
const GROWTH: Feature[] = [...STARTER, "unlimitedMigration", "advancedAnalytics", "prioritySupport", "reviewRequests", "verifiedPurchase"];
const PRO: Feature[] = [...GROWTH, "apiAccess"];

export const PLANS: Readonly<Record<PlanKey, Plan>> = Object.freeze({
  FREE: { key: "FREE", name: "Free", shopifyPlanHandle: "free", monthlyPriceUsd: 0, annualPriceUsd: 0, publishedReviewAllowance: 100, publicMediaBytes: 500 * MB, isFree: true, mostPopular: false, features: BASE, reviewRequestsPerMonth: 0 },
  STARTER: { key: "STARTER", name: "Starter", shopifyPlanHandle: "starter", monthlyPriceUsd: 9, annualPriceUsd: 90, publishedReviewAllowance: 1_000, publicMediaBytes: 2 * GB, isFree: false, mostPopular: false, features: STARTER, reviewRequestsPerMonth: 0 },
  GROWTH: { key: "GROWTH", name: "Growth", shopifyPlanHandle: "growth", monthlyPriceUsd: 19, annualPriceUsd: 190, publishedReviewAllowance: 5_000, publicMediaBytes: 10 * GB, isFree: false, mostPopular: true, features: GROWTH, reviewRequestsPerMonth: 0 },
  PRO: { key: "PRO", name: "Pro", shopifyPlanHandle: "pro", monthlyPriceUsd: 39, annualPriceUsd: 390, publishedReviewAllowance: 25_000, publicMediaBytes: 50 * GB, isFree: false, mostPopular: false, features: PRO, reviewRequestsPerMonth: 0 },
  SCALE: { key: "SCALE", name: "Scale", shopifyPlanHandle: "scale", monthlyPriceUsd: 79, annualPriceUsd: 790, publishedReviewAllowance: 100_000, publicMediaBytes: 250 * GB, isFree: false, mostPopular: false, features: PRO, reviewRequestsPerMonth: 25_000 },
} satisfies Record<PlanKey, Plan>);
for (const p of Object.values(PLANS)) Object.freeze(p);

export const PLAN_ORDER: readonly PlanKey[] = Object.freeze(["FREE", "STARTER", "GROWTH", "PRO", "SCALE"]);
export const DEFAULT_PLAN: PlanKey = "FREE";

/** Shopify plan handle → Proofly plan (null when Shopify reports a handle Proofly does not know). */
export const planForHandle = (handle: string | null | undefined): PlanKey | null =>
  PLAN_ORDER.find((k) => PLANS[k].shopifyPlanHandle === handle?.trim().toLowerCase()) ?? null;

/** A feature is available only when it has shipped AND the plan includes it. */
export const planHasFeature = (plan: PlanKey, feature: Feature) => FEATURES[feature].released && PLANS[plan].features.includes(feature);

/** Rounded yearly saving vs 12 × monthly, for display ("Save 17%"). Derived, never configured separately. */
export const annualSavingPercent = (plan: PlanKey) => {
  const p = PLANS[plan];
  return p.isFree ? 0 : Math.round((1 - p.annualPriceUsd / (12 * p.monthlyPriceUsd)) * 100);
};

export const formatBytes = (n: number) => (n >= GB ? `${+(n / GB).toFixed(1)} GB` : `${Math.round(n / MB)} MB`);
