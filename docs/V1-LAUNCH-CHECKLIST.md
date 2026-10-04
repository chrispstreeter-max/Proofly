# Proofly — V1 launch checklist (2026-10-04)

Planning document. Validated code: `78df03e`; launch handoff: `3404927` ([LAUNCH.md](LAUNCH.md) §5). Nothing is pushed
or deployed. Sources: [REAL-SHOPIFY-VALIDATION.md](REAL-SHOPIFY-VALIDATION.md), [APP-STORE.md](APP-STORE.md),
[LAUNCH.md](LAUNCH.md). Requirements come from those documents; anything they don't settle is marked **UNKNOWN**.

**Who:** *Me* = the owner · *Claude* = this assistant (local checks, documentation, verification after your action) ·
*Shopify* = Shopify's platform or review team. **Test** = can be done safely on Proofly Test (development store).
**Prod** = needs production. **Blocks** = blocks App Store submission according to the APP-STORE.md pre-submission
checklist (which includes "all LAUNCH.md §4 items passed").

## Status (master tracker — updated 2026-10-04, launch execution)

| Area | Status | Evidence / waiting on |
|---|---|---|
| Code | PASS | Offline gate green; no open defects |
| Real-Shopify validation | 67 PASS / 0 FAIL; rest open | Waiting on: the storefront password typed into the `shopify app dev` terminal (dev server + tunnel restart), then uninstall/reinstall, customer webhooks, admin pass, theme embed, proxy path, language, billing on Proofly Test |
| Infrastructure | BLOCKED | Provider chosen and prepared: Render (web + hourly cron, `render.yaml`) + Neon PostgreSQL ([LAUNCH.md §6](LAUNCH.md)). Waiting on: accounts with a payment method; a private Git repository and permission to push |
| Production Shopify app | BLOCKED | Waiting on: the Partner organisation that owns the listing; production URL from Render |
| App Store package | Partly done | Listing text within limits, icon, executable reviewer walk-through, sample CSV, demo catalogue ([APP-STORE.md](APP-STORE.md)). Waiting on: REQUIRED FROM CHRIS list; screenshots and screencast need the demo store |
| Documentation | PASS | Stale statements fixed (roadmap status and §8, D5, architecture status, brand assets) |

## A. Code complete

All V1 scope is implemented and gated: 247/247 offline tests, typecheck, lint, build, Theme Check, 16 fixture checks,
GraphQL 23/23 + 2 inputs, merchant-data and secret scans, network guard. No open defects.

| Item | Action | Who | Blocks |
|---|---|---|---|
| Fixes surfaced by the remaining validation | Fix only what a real test proves wrong (regression test + full gate, as before) | Claude | Only if a defect is found |
| CI workflow | Exercised on the first push (step order fixed in `6cd97d0`, not yet run) | Me (push) | No |

## B. Real-Shopify validation (development store)

| Item | Exact action | Who | Prerequisite | Test | Prod | PASS evidence | Blocks |
|---|---|---|---|---|---|---|---|
| Uninstall / reinstall | Uninstall Proofly Dev on Proofly Test; reinstall from the app's install link | Me, then Claude verifies | Your authorisation; dev server + tunnel running | Yes | No | Tenant reactivated (same id); proxy path and storefront settings republished; projections back after one maintenance run | Yes (LAUNCH §4.1) |
| Storefront dark → reappears | Open a product page after uninstall and after reinstall | Claude | Above | Yes | No | Widget absent while uninstalled; renders again after reinstall | Yes |
| `app/uninstalled` webhook | Delivered by the uninstall above | Shopify → Claude checks | Above | Yes | No | Sessions deleted, `uninstalled_at` set, `shop.uninstalled` audit row | Yes (§4.8) |
| Customer data request / erase | Create a synthetic customer; "Request customer data" then "Erase personal data" in Shopify admin | Me, then Claude checks | None | Yes | No | `customer.data_request` and `customer.redact` audit rows for Proofly Test | Yes (§4.8) |
| `shop/redact` timing | Not run by design (deletes the tenant 48 h after uninstall) | — | — | No | — | Offline-tested | **UNKNOWN** whether Shopify review expects a live run |
| Visible admin pass | Keep the browser pane visible while Claude walks every page | Me (show pane), Claude | Dev server + tunnel | Yes | No | Screenshots of every page; no app-frame console errors | Yes (§4.3) |
| Downloads | Review export and problem report through App Bridge | Claude | Visible pane | Yes | No | Both files download; contents match the offline tests | Yes (§4.3) |
| Loading / error states | Unknown review and import ids; slow pages | Claude | Visible pane | Yes | No | Error page with a way back; no crash | Yes (§4.3) |
| Card-stars app embed | Turn on "Product card stars" in the Theme Editor; open a collection page | Me (theme change), Claude checks | Your authorisation for a theme change | Yes | No | Stars on cards of products with public reviews; none elsewhere | Yes (§4.5–4.6) |
| Changed proxy path | Change the app proxy path in the store; set the same path in Proofly Settings | Me, Claude checks | Location of the setting in admin: **UNKNOWN** | Yes | No | Widget works on the new path; old path 404 | Yes (§4.7) — see "Unnecessarily blocking" |
| Locale-prefixed path | Publish a second language; open a product page under its locale prefix | Me, Claude checks | Store configuration change | Yes | No | Widget loads through `/<locale>/apps/proofly` | Yes (§4.7) — see "Unnecessarily blocking" |
| Second-store isolation | Create a second development store in the same organisation; install Proofly Dev | Me, Claude checks | None | Yes (new dev store) | No | Neither store sees the other's projection, settings or reviews | No (not in §4; recorded as BLOCKED D4) |
| App Pricing | Configure the five plans on the dev app; upgrade, downgrade, cancel with test charges | Me, Claude checks | Plans configured in the Partner Dashboard; access to it: **UNKNOWN** (earlier you reported no access to dev.shopify.com) | Yes (test charges only) | No | Plan page reflects Shopify; held reviews publish only on "Publish eligible reviews"; cancel → Free | Yes (§4.2) |
| Webhook edge cases (stale, duplicate) | None: Shopify can't produce them on demand | — | — | — | — | Offline-tested | No |
| Other themes (Dawn + 3) | Install themes and add the blocks | Me | Theme changes | Yes | No | Widget, summary and stars render without console errors | Yes (§4.6) — see "Unnecessarily blocking" |

## C. Infrastructure

| Item | Exact action | Who | Prerequisite | Test | Prod | PASS evidence | Blocks |
|---|---|---|---|---|---|---|---|
| Hosting provider + region | Decide (managed Node + managed PostgreSQL; Canada or US) | Me | — | — | Yes | Recorded in ROADMAP D3 | Yes |
| Managed PostgreSQL | Create the database, schema owner, and `proofly_app` (`NOSUPERUSER NOBYPASSRLS`) | Me | Provider | No | Yes | Migrations apply as owner; RLS forced on 9 tables; app role cannot bypass | Yes |
| Docker build | Build the `Dockerfile` image (on the host's builder or anywhere Docker exists; Docker is not installed locally) | Me / host | Hosting | No | Yes | Image builds; contents per LAUNCH §1; runs as `node` | Yes |
| Production secrets | Set the eight variables the startup check requires (LAUNCH §1) plus `DIRECT_DATABASE_URL` for migrations, in the platform's secret store (never in chat) | Me | Production Shopify app (key, secret, URL) | No | Yes | Startup check passes; with any one missing the process exits 1 listing it | Yes |
| Production Node hosting | Run `npm run docker-start` | Me | Image, secrets, database | No | Yes | Migrations applied; app serves | Yes |
| `/healthz` monitoring | Point the platform's health check / uptime monitor at `/healthz` | Me | Hosting | No | Yes | `200 ok`; `503` when the database is down | Yes |
| Hourly maintenance | Schedule `npm run maintenance` from the same image | Me | Hosting | No | Yes | Hourly JSON report in logs | Yes |
| Alerting | Alert when maintenance exits 1 and when `/healthz` fails | Me | Hosting | No | Yes | A test alert fires | **UNKNOWN** (not in the APP-STORE checklist; LAUNCH §2 recommends it) |
| Lighthouse | Chrome DevTools Lighthouse on an unlocked product page with and without the widget (no install needed) | Me | Any storefront you can unlock (development stores stay password-protected) | Yes | No | Report saved; scores recorded | Yes (APP-STORE checklist) |

## Production Shopify app

| Item | Exact action | Who | Prerequisite | Test | Prod | PASS evidence | Blocks |
|---|---|---|---|---|---|---|---|
| Separate production app | Create it in your Partner organisation (which organisation: **[decide]**) | Me | Partner access | No | Yes | App exists; its own `shopify.app.<env>.toml` | Yes |
| Production app URL | `application_url` = the production https host | Me, Claude prepares the config file (no secrets) | Hosting | No | Yes | Config linked to the production app | Yes |
| App Pricing configuration | The five plans with handles `free`, `starter`, `growth`, `pro`, `scale` at the `app/lib/plans.ts` prices | Me | Production app | No | Yes | `currentAppInstallation` handles map to plans on the demo store | Yes |
| Production install / OAuth | Install on the demo development store (Shopify-managed install, token exchange) | Me, Claude checks | Deployed app + config | Demo store | Yes | Tenant created from the Admin API identity | Yes |
| Production webhooks, proxy, extension | `shopify app deploy` with the production config | Me | Production app + URL | No | Yes | Webhook deliveries processed; `/apps/proofly` signed requests 200; blocks available in the Theme Editor | Yes |

## D. App Store submission

| Item | Exact action | Who | Prerequisite | PASS evidence | Blocks |
|---|---|---|---|---|---|
| Legal entity, address, governing law | Decide and add to the privacy policy | Me | — | Filled in APP-STORE.md §2 | Yes |
| Contact email | Decide | Me | — | Filled in | Yes |
| Privacy policy URL | Publish the reviewed policy at a public URL | Me | Legal details | URL live | Yes |
| Support | Support email, page URL, response time | Me | — | Filled in | Yes |
| Hosting / sub-processor disclosure | Name the hosting and managed Postgres providers | Me | Hosting decision | Filled in APP-STORE.md §2 | Yes |
| Listing copy | Approve or edit the draft in APP-STORE.md §1 | Me | — | Final copy | Yes |
| App icon and brand assets | SVG master; mark-only 1200 × 1200 icon (BRAND.md) | Me (brand owner) | — | Files supplied | Yes (listing needs an icon) |
| Screenshots | Dashboard, import with matching, moderation, product-page widget, card stars — on the demo store | Me or Claude (visible pane) | Demo store with synthetic data | Images saved | Yes |
| Demo store | A development store with synthetic data only | Me creates, Claude fills | Production app installed | Store ready | Yes |
| Reviewer test data and access | Synthetic reviews and products on the demo store; reviewer access method: **UNKNOWN** (not specified in the repo) | Me, Claude | Demo store | Reviewer can run APP-STORE.md §3 | Yes |
| Sample CSV for reviewers | A few synthetic rows for the demo store's products, one needing a manual match | Claude | Demo store products | File attached to the submission | Yes |
| Protected customer data declaration | V1 requests no customer or order scopes; whether a Partner Dashboard declaration is still required: **UNKNOWN** | Me | — | — | **UNKNOWN** |

## E. Post-launch / V1.1 (not blocking)

- V1.1 per PRODUCT-SPEC-V1 §19–20: verified purchase, review requests (they need order and customer scopes and
  protected-customer-data approval), analytics, API access.
- Known risks to retire: `deepmerge-ts` once Prisma ships a fix; a background job runner (imports currently run in the
  web process); move the repository out of iCloud; optional re-signing for the rare bulk-release race.
- Quarterly Shopify API version upgrades (ROADMAP R4).

## Definition of Done

| Gate | Must be true |
|---|---|
| **Development validation complete** | Offline gate green (done). Every B row PASS on Proofly Test or on a second development store, except stale/duplicate webhooks and `shop/redact` (offline-tested by design). Today: 67 PASS of 93; the open rows are B. |
| **Production infrastructure ready** | Hosting and region decided; image built and running as `node`; managed Postgres with the two roles and all migrations; secrets set; `/healthz` monitored; hourly maintenance scheduled and alerting on exit 1. Today: none provisioned. |
| **App Store submission ready** | Both gates above; production app created, configured (URL, App Pricing, webhooks, proxy, extension) and installed on the demo store; test charges pass there; Lighthouse report; all D rows done; APP-STORE.md §3 walk-through passes on the demo store. |
| **Public launch ready** | Shopify approval; the production app listed; monitoring and alerts live; the first merchant installs from the App Store like any other (ROADMAP §10, no bypass). |

## Documentation inconsistencies found (resolved 2026-10-04 except where noted)

- **Stale status headers:** PUBLIC-APP-ROADMAP says "Nothing in this document has been implemented… No Shopify
  connection"; ARCHITECTURE says "checkpoints 1–4, local only". Both predate Phases 1–4 and the development-store
  validation (the "current state" block added above them is correct).
- **ROADMAP §8 (App Store compliance) is stale:** billing ❌ (built), scopes "`read_products`, `write_products` only"
  (now six, including metaobjects), "shop/redact deletes DB + storage" (no storage since Phase 4), "admin never run in
  Shopify" (run on Proofly Test).
- **ROADMAP D5** calls P1–P7 "open details"; ARCHITECTURE §9 records them resolved on 2026-10-03, and P1 (media
  storage) no longer applies (no photos).
- **Duplicated lists:** LAUNCH §4 (required real-Shopify items), LAUNCH §5 (handoff) and REAL-SHOPIFY-VALIDATION
  overlap; §4 still reads as if nothing were done. REAL-SHOPIFY-VALIDATION is the authoritative status.
- **Possibly unnecessarily blocking (open):** the APP-STORE checklist requires *every* LAUNCH §4 item, including a changed
  proxy path, locale paths and "Dawn plus three other themes". Those paths are offline-tested and whether Shopify's
  review requires them is **UNKNOWN**; consider moving them to post-launch (your decision).
- **iCloud (open):** LAUNCH §2 recommends moving the repository before production work; it is still in `~/Documents`.

## Completion

Weighted by V1 scope and launch risk, not by task count:

- **Engineering implementation: ~98%.** Every V1 feature is built and gated; the remainder is a reserve for fixes the
  last validations may surface (this phase found four).
- **Validation: ~67%.** Core data paths (reviews in Shopify, storefront, imports, product sync, ratings, proxy,
  security) are verified on real Shopify; open are the uninstall lifecycle, customer webhooks, App Pricing charges,
  a visible admin pass, and everything that needs production.
- **Launch readiness: ~20%.** No infrastructure, no production app and no App Store decisions or assets yet; the
  listing, privacy policy and reviewer plan exist as drafts.
- **Overall V1: ~65%.** Engineering 50% weight × 98%, validation 25% × 67%, launch readiness 25% × ~20%.

**Code complete ≠ launch ready.** Code complete means every V1 feature exists and passes its tests. Launch ready also
needs the paths only Shopify and production can prove (uninstall, charges, webhooks from real events), a running
production stack, a configured production app, and the business, legal and listing material the App Store requires.
Most of the remaining work is not code.

## Shortest critical path to App Store submission

1. Finish development validation on Proofly Test (uninstall/reinstall, customer webhooks, visible admin pass).
2. Decide hosting, legal entity and contact details (can run in parallel with step 1).
3. Provision managed Postgres and hosting; deploy the image with production secrets; verify `/healthz`, migrations
   and the hourly maintenance.
4. Create the production app; configure URL and App Pricing; deploy its config and extension.
5. Create the demo store; install; synthetic data; test charges; Lighthouse.
6. Privacy policy URL, icon, screenshots, listing; submit.

## NEXT 10 ACTIONS

1. **Me:** authorise and perform the uninstall and reinstall of Proofly Dev on Proofly Test; **Claude** verifies the
   dark storefront, the `app/uninstalled` webhook and the republishing.
2. **Me:** create a synthetic customer on Proofly Test and run "Request customer data" and "Erase personal data";
   **Claude** checks both audit rows.
3. **Me:** keep the browser pane visible; **Claude** does the admin pass (every page, downloads, error and loading
   states, console).
4. **Me:** decide the hosting provider and region.
5. **Me:** decide the legal entity, address, governing law, contact and support details.
6. **Me:** create the production Shopify app (and confirm Partner Dashboard access) and configure the five App Pricing
   plans; **Claude** prepares the production config file without secrets.
7. **Me:** provision managed PostgreSQL (schema owner + `proofly_app`) and hosting; set the secrets in the platform.
8. **Me:** build and deploy the image; schedule hourly maintenance with an alert on exit 1; monitor `/healthz`;
   **Claude** verifies migrations, health and the first maintenance report.
9. **Me:** create the demo development store and install the production app; **Claude** loads synthetic data and the
   reviewer sample CSV; **Me:** run test charges and Chrome DevTools Lighthouse.
10. **Me:** publish the privacy policy, supply the icon, take screenshots (or let Claude take them with the pane
    visible), finalise the listing, and submit.
