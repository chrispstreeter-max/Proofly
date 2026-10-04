# Proofly — Billing, plans and entitlements (Checkpoint 5)

Shopify bills and Proofly never charges. Proofly stores only the entitlement state it needs to behave correctly. It
has no payment page, no Stripe and no card data. Code lives in `app/lib/plans.ts` (configuration),
`app/lib/billing.server.ts` (Shopify state) and `app/lib/entitlements.server.ts` (what the plan allows).

## 1. Verified Shopify facts (2026-10-05)

Sources: shopify.dev ("Shopify App Pricing", "Partner API activeSubscription", "ActiveSubscription"), the published
Admin GraphQL schema for **2026-10** (introspected; every operation validated by `npm run check:graphql`), and the
Shopify developer community for the `planHandle` usage note. The Shopify docs tool server could not connect, so these
pages were read directly.

| Topic | Verified fact | Consequence for Proofly |
|---|---|---|
| Mechanism | **Shopify App Pricing**: plans are defined in the Partner Dashboard (app submission); merchants choose on Shopify's hosted page `https://admin.shopify.com/store/:store_handle/charges/:app_handle/pricing_plans` | Proofly only links there ("Change plan in Shopify"); no Proofly-side plan purchase |
| Billing API | "Once you opt in to Shopify App Pricing, you can't create new recurring application charges using the Billing API." | No `appSubscriptionCreate` / `appSubscriptionCancel` in Proofly (test-enforced) |
| Plans | Up to **8 public plans**; free plans supported; trials configurable per plan; "merchants can always toggle between monthly and yearly prices" | 5 public plans, one plan handle each with monthly + yearly prices; no trials configured by Proofly |
| Return | After approval Shopify redirects with `plan_handle` and `shop` (the `charge_id` parameter is deprecated after 2026-04-28) | `/app/plan?plan_handle=…` triggers a re-check; the parameter itself is never trusted |
| Webhooks | "Shopify App Pricing doesn't use webhooks to notify your app of subscription changes"; `APP_SUBSCRIPTIONS_UPDATE` stopped for App Pricing after 2026-04-28 | **No billing webhook is subscribed.** Reconciliation is pull-based (§4) |
| Live state (Partner API) | `activeSubscription(appId, shopId)` → `ActiveSubscription { billingPeriod: AppPricingInterval!, cancelAtEndOfCycle, currentBillingCycle, items, trialEndsAt, pendingUpdate, legacySubscriptionId }`; documented as the "live contract state" | Not used in V1: needs an organisation-level Partner API credential (a production credential) and `SubscriptionItem`'s fields are not documented on the pages read. Optional second source later (§9) |
| Live state (Admin API, used) | `currentAppInstallation { activeSubscriptions, allSubscriptions(first, sortKey: CREATED_AT, reverse) }` → `AppSubscription { id name status test trialDays createdAt currentPeriodEnd lineItems { plan { pricingDetails } } }`; `AppRecurringPricing { planHandle interval price }` where `planHandle` = "The app store pricing plan handle" | Proofly reads the shop's own subscription with the shop's offline token (no extra scope). `planHandle` maps to a Proofly plan. Community reports it can be `null` (e.g. plan deleted), so that case is treated as unverified, never as a plan |
| Statuses | `AppSubscriptionStatus`: PENDING, ACCEPTED, ACTIVE, DECLINED (terminal), EXPIRED (not approved within 2 days, terminal), FROZEN (non-payment; re-activates when payments resume), CANCELLED (terminal) | Mapping in §4 |
| Intervals | `AppPricingInterval`: `EVERY_30_DAYS`, `ANNUAL` | monthly / annual |
| Test billing | Testable plans depend on the Partner organisation and the store; a **$0 private test plan** is available; subscriptions carry `test: Boolean!` | Test subscriptions are recorded (`billing_state.test`) and shown as "test subscription (no charge)". Real testing needs a development store (§9) |

## 2. Plans (canonical: `app/lib/plans.ts`)

| Plan (id) | Monthly | Annual | Published reviews | Public media | Shopify plan handle |
|---|---:|---:|---:|---:|---|
| Free (`FREE`) | $0 | $0 | 100 | 500 MB | `free` |
| Starter (`STARTER`) | $9 | $90 | 1,000 | 2 GB | `starter` |
| Growth (`GROWTH`), Most popular | $19 | $190 | 5,000 | 10 GB | `growth` |
| Pro (`PRO`) | $39 | $390 | 25,000 | 50 GB | `pro` |
| Scale (`SCALE`) | $79 | $790 | 100,000 | 250 GB | `scale` |

- **Annual saving:** about 17% (derived: 1 − annual / (12 × monthly)). There is no discount engine; the Shopify
  subscription's price is authoritative.
- **Identifiers and handles:** ids are stable enum values (`PlanKey`), never prices and never Shopify subscription ids.
  The handles must be configured identically in the Partner Dashboard.
- **Features:** each feature has a `released` flag. Unreleased features (review import UI, CSV export, unlimited
  migration, advanced customisation, advanced analytics, API access, review requests, verified purchases) are never
  enabled or shown, whatever the plan.
- **Shown today:** review display (widget, summary, card stars), photo reviews and moderation on all plans; public
  replies from Starter; priority support from Growth.
- **Configuration is locked:** frozen at runtime. A test fails if a price, allowance or plan name appears anywhere else
  in `app/` or `extensions/`.

## 3. Entitlement model (`app/lib/entitlements.server.ts`)

- **Published-review usage:** reviews currently public (`status = published AND hold_reason IS NULL`), from every
  source.
- **Public-media usage:** bytes of the two optimised WebP derivatives (`public_bytes`) of photos with
  `media_status = published`. Private originals, backups and recovery copies never count.
- **Review room** = allowance − usage. **Media room** = allowance − usage. Usage can exceed the allowance after a
  downgrade (grandfathering).
- **Admission:** anything about to become public is first held (`plan_limit` for reviews, `storage_limited` for
  photos), then released oldest first while there is room. This applies to:
  - approval (`moderate` approve);
  - auto-published storefront submissions (when moderation is turned off);
  - storefront photo uploads;
  - imports (`importReviews`);
  - the merchant actions "Publish eligible reviews" and "Publish eligible photos".
- **Not admitted:** reviews that don't fit stay approved and held. They are never rejected, deleted or reported as
  failed. The admin says "Approved, but currently held by your plan limit."
- **Fairness:** date order only. Reviews use `reviewDate, createdAt, id`; photos use
  `review.reviewDate, createdAt, position, id`. Photos are released in strict order: the first photo that doesn't fit
  stops the release, so a later, smaller photo never jumps the queue. Regression tests fail if any other ordering is
  introduced or if a high rating could jump the queue.
- **Storage limits apply to photos, never reviews:**
  - A review with storage-limited photos still publishes.
  - Storage-limited photos are kept privately (original and derivatives) and are never served.
  - Nothing is deleted because of a limit.
  - **Known trade-off:** optimised derivatives are generated at upload even for storage-limited photos, so their size
    is known. They cost storage but are not served.
- **Concurrency:** decisions are serialised per shop (`pg_advisory_xact_lock`), so two approvals can't both take the
  last slot.

## 4. Billing state and reconciliation (`app/lib/billing.server.ts`)

`billing_state` (one row per shop, row-level security) holds plan, interval, verification (`confirmed` | `unverified`),
Shopify status, subscription id, plan handle, test flag and verification time. `subscriptions` (also row-level security)
caches each Shopify subscription last read. **Shopify wins.**

| Shopify says | Proofly plan | `shopify_status` | `verification` |
|---|---|---|---|
| ACTIVE, `planHandle` maps to a plan | that plan (monthly or annual) | active | confirmed |
| ACTIVE, `planHandle` unknown or null | **unchanged** | unchanged | unverified (error recorded) |
| FROZEN | Free limits (everything already public stays public) | frozen | confirmed |
| No active subscription; latest is PENDING / DECLINED / EXPIRED / CANCELLED, or none | Free | pending / declined / expired / cancelled / none | confirmed |
| API or network failure, or GraphQL errors | **unchanged** | unchanged | unverified |

**When it runs:** after every token exchange (install, reinstall, refresh), on return from Shopify's plan page
(`?plan_handle=`), when an admin page finds the state older than 10 minutes, and when the merchant clicks "Check plan
with Shopify". It never runs from the storefront.

**What it never does:** a failure never downgrades, and nothing but a confirmed ACTIVE subscription with a known
handle ever upgrades. A client-sent plan, price, interval, shop id or subscription id is ignored (test-enforced).

**Audit** records real changes only:
- `billing.plan_upgraded` / `billing.plan_downgraded`;
- `billing.subscription_<status>` when the Shopify status changes;
- `billing.verification_failed` on the transition into `unverified` (not on every failed check);
- `plan.reviews_released` / `plan.media_released` for merchant actions.

## 5. Upgrade

When Shopify confirms the higher plan, the allowance grows. **Nothing publishes automatically.** The Plan page says
"You have N eligible reviews ready to publish." Then:
- **Publish eligible reviews** releases held reviews oldest first, up to the new allowance.
- **Publish eligible photos** releases storage-limited photos oldest first, up to the new media allowance.

## 6. Downgrade (locked rule: grandfathering)

Published reviews and public photos stay published and visible; nothing is hidden or deleted. The lower allowance
applies only to what becomes public next: new approvals, imports and photos are held. While over the allowance, the
dashboard and Plan page say so, for example "You're using 1,240 published reviews on a plan that includes 1,000.
Your existing reviews remain visible. New reviews will be held until you upgrade."

## 7. Imports

`importReviews` is provider-neutral. Every valid row is stored, and imports are never truncated. Published rows go
through admission, and duplicates (same source and source review id) are skipped idempotently. Example: Free, 1,000
rows → 1,000 stored, 100 published (the oldest), 900 plan-limited, 0 rejected. CSV parsing, mapping, images and the
import UI are checkpoint 8.

## 8. Security and isolation

- **Isolation:** `billing_state` and `subscriptions` are tenant tables (row-level security, cascade on shop). Merchant A
  cannot read or change B's billing (tests), and reconciling A never touches B.
- **Routes:** the Plan page accepts only intents (`refresh`, `publish_eligible`, `process_media`) and decides
  everything server-side.
- **Storefront:** it never imports billing code, never calls a billing API, and the theme extension contains no
  billing code (tests).
- **Tests:** they run with a network guard (`tests/no-network.ts`) and an in-memory Shopify; no real billing occurs.

## 9. Not verified without a real development store / remaining V1.1

- **Partner Dashboard setup:** creating the five App Pricing plans with handles `free`, `starter`, `growth`, `pro`,
  `scale`, the monthly and yearly prices, and the welcome link `/app/plan`.
- **Real subscription data:** that App Pricing subscriptions appear in `currentAppInstallation.activeSubscriptions`
  with a populated `planHandle`, how FROZEN appears there, and the redirect parameters.
- **Test charges:** test charges on a development store.
- **Plan changes:** upgrade, downgrade and cancellation timing and proration, which Shopify handles. Scheduled
  changes (`pendingUpdate`, `cancelAtEndOfCycle`) are visible only through the Partner API and are not used yet.
- **Background checks:** a scheduled re-check needs the job runner. Until then, checks happen on the events in §4.
- **V1.1, inert until built:** review requests (Scale: 25,000 per month), verified purchases, API access, advanced
  analytics.

## 10. Reply visibility (checkpoint 6 decision)

Imported replies are retained regardless of plan. Public reply visibility is feature-gated. Plans without Replies store imported replies privately and suppress them from storefront responses. Upgrading restores eligibility without requiring re-import.

- Free does not delete imported replies, and downgrading does not delete replies: they stay stored with their review.
- Replies become visible again as soon as the merchant's plan includes Replies (no re-import, no duplicate rows).
- Visibility is decided server-side from the shop's own entitlement (`can(t, "replies")`); no client-supplied plan,
  parameter or header can change it. Without the entitlement the storefront response is exactly as if the review had
  no reply (`reply: null`) — no placeholder, no hidden-reply metadata.
- Reviews keep their own rules: the reply entitlement never makes a held, hidden, rejected or pending review public.
