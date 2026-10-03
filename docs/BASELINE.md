# Proofly — Commercial Repository Baseline

This repository is the **commercial Proofly codebase**, started with fresh history. It is derived from a validated
single-store prototype that is kept as a separate, private archive. No merchant or customer data from that prototype
is carried into this repository.

> Status: baseline only. The multi-tenant commercial refactor (see [PUBLIC-APP-ROADMAP.md](PUBLIC-APP-ROADMAP.md)) has
> not started. Nothing is deployed, installed or connected to any Shopify store. Not pushed to any remote.

---

## 1. Source carried forward (engineering starting point)

| Area | Files | Notes |
|---|---|---|
| Shopify app framework | `app/shopify.server.ts`, `app/db.server.ts`, `app/entry.server.tsx`, `app/root.tsx`, `app/routes.ts`, `app/globals.d.ts`, `app/routes/_index/*`, `app/routes/auth.*`, `app/routes/app.tsx`, `env.d.ts` | Shopify React Router template + App Bridge |
| Domain libraries | `app/lib/aggregates.server.ts`, `media.server.ts`, `reviews.server.ts`, `http.server.ts`, `submit.server.ts`, `moderation.server.ts`, `requests.server.ts`, `admin.server.ts`, `devsign.server.ts` | Validated logic: aggregates from published reviews, metafield cache sync, private-original + WebP media pipeline, allow-listed public serializer, submission validation, moderation, hashed single-use tokens (V1.1) |
| Storefront API routes | `app/routes/proxy.*` | App-proxy HMAC-verified endpoints |
| Admin routes | `app/routes/app._index.tsx`, `app.reviews._index.tsx`, `app.reviews.$id.tsx` | Strings generalised (§3) |
| Webhooks | `app/routes/webhooks.*` | Comment generalised |
| Dev tooling | `app/routes/dev.*`, `app/routes/apps.proofly.$.tsx`, `app/routes/media.$.tsx`, `scripts/db.sh` | Dev-only (404 in production); generalised (§3) |
| Theme app extension | `extensions/proofly/**` | Renamed and generalised (§3) |
| Schema | `prisma/schema.prisma`, `prisma/migrations/**` | DDL only — migrations contain no data |
| Config/tooling | `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `.eslintrc.cjs`, `.graphqlrc.ts`, `Dockerfile`, `shopify.app.toml`, `shopify.web.toml.liquid`, dotfiles, `.claude/launch.json`, `public/favicon.ico` | Names/comments generalised |
| Brand + product docs | `brand/proofly-logo.png`, `docs/BRAND.md`, `docs/PRODUCT-SPEC-V1.md`, `docs/ARCHITECTURE.md`, `docs/PUBLIC-APP-ROADMAP.md` | Merchant references replaced with neutral wording; prototype-specific audit sections condensed |
| CSV parser | `scripts/lib/csv.ts` | Generic RFC 4180 parser extracted from the prototype importer |

## 2. Excluded (contain merchant data or are merchant-specific)

| Excluded | Reason |
|---|---|
| Prototype product catalogue snapshots (`data/*.json`) | Real merchant catalogue: product IDs, handles, titles, image URLs |
| Migration report (`docs/migration-report.md`) | Real product handles and per-product counts |
| Screenshots (`docs/screenshots/*.png`) | Real reviewer names, review text and customer photos |
| Prototype QA script (`scripts/qa.ts`) | Hard-coded real product IDs; depends on the real dataset |
| Legacy-provider importer CLI + validator (`scripts/import-*.ts`, `scripts/validate-migration.ts`, `scripts/lib/source.ts`, `scripts/lib/validate.ts`) | Bound to one merchant's recovery package layout and backup path; the generic importer is rebuilt in checkpoint 8 (the provider format becomes a preset) |
| Prototype history docs (`docs/ARCHITECTURE.md`, `docs/INSTALL.md`, `docs/QA.md`) | Single-store install/QA records for one merchant |
| Recovery package copy, local database, media storage, `.env` | Never tracked; merchant data and local secrets |
| Git history | Fresh history; the prototype history stays in the private archive |

## 3. Generalised rather than copied

| Prototype behaviour | Baseline |
|---|---|
| Product/app name strings, admin heading | “Proofly” |
| “Response from {merchant}” hard-coded in widget and admin | Uses the shop's own name (`{{ shop.name }}` passed to the widget; neutral admin copy) |
| “Imported from {legacy provider}” badge/banner | “Imported from {source}” using the review's source key |
| Prototype-derived three-letter prefixes in CSS classes, data attributes, asset names and the proxy path | `pf` prefixes, `proofly-*` assets; proxy path `/apps/proofly` as the default, **configurable per merchant since CP4** |
| Card stars bound to a legacy theme's `.shopify-product-reviews-badge` markup | Baseline: documented hook `[data-pf-rating][data-product-id]`. **Superseded (CP3–4):** no theme hook at all — the product-card hierarchy in [ARCHITECTURE.md §11.8](ARCHITECTURE.md) |
| Dev proxy default shop = a real store | `DEV_SHOP_DOMAIN` env, default fictional `proofly-dev.myshopify.com` |
| Dev preview: real storefront origin, legacy card markup | Fictional origin; since CP3 renders the real extension blocks around a generic theme-like page |
| `shopify.app.toml` custom-app wording, real domains | Neutral Proofly config (public distribution and per-environment configs arrive in checkpoint 2) |
| Schema comment naming a legacy provider | Generic source-key comment |

Not yet generalised (scheduled in the roadmap, intentionally out of scope for the baseline): multi-tenancy, scopes,
V1.1 feature removal, entitlements, generic importer.

## 4. Synthetic fixture replaces the real dataset in CI

- `scripts/fixtures/generate.ts` deterministically (seeded) generates `fixtures/synthetic/` (git-ignored):
  a fictional product catalogue (~90 products), a review CSV in the Proofly import template (~1,150 reviews),
  ~160 generated images (incl. multi-image reviews, JPEG/PNG/WebP, one corrupt file, two missing references, and fictional EXIF metadata to test stripping), an image
  manifest with SHA-256, and `expectations.json`.
- It exercises: duplicate text on the same product, cross-product repeated text, missing titles, reply-like records,
  unmatched products, multiple states (published/pending/hidden/rejected), plan-limited reviews (expected count under the
  Free allowance) and storage-limited images (expected under a small test media allowance).
- All names, products and text are obviously fictional (e.g. “Jordan Example”, “Aurora Test Mug”); product IDs use a
  reserved fictional range (≥ 9,000,000,000,000).
- `scripts/fixtures/check.ts` asserts every property. CI runs generate → check (see `.github/workflows/ci.yml`; not
  pushed anywhere yet). The private real dataset never enters CI; it may be used only locally or on a development store
  when explicitly authorised, from storage outside this repository.

## 5. Merchant-data scan

`scripts/scan-merchant-data.ts` scans **all tracked files** and the **production build artefacts** (`build/`,
`extensions/`) and fails on:

1. Data files in build output (`.csv`, `.json` data dumps, `.sqlite`, archives) and any image in build output.
2. Email addresses and phone-number patterns (outside an allow-list of fictional/example domains).
3. `*.myshopify.com` domains other than fictional development domains.
4. 13–14 digit Shopify-style IDs outside the reserved fictional range.
5. Tokens matching a **hashed denylist** (SHA-256 of normalised tokens) — the committed list covers prototype brand and
   legacy-provider names without spelling them out; an optional **private denylist** (path in
   `PROOFLY_PRIVATE_DENYLIST`, generated locally from the private dataset with `scripts/scan/build-denylist.ts` and
   stored outside the repository) adds reviewer names, product handles, product IDs and review titles.

The baseline was scanned with both the committed and a locally generated private denylist.

## 6. Preserving the validated implementation

The prototype repository is kept unchanged as the private engineering reference (commit `bcb5274`), together with its
validated results (idempotent import of the recovery dataset with 0 mismatches, end-to-end QA, security probes) and the
offline disaster-recovery backup. It is never pushed, never merged into this repository, and its data is never
copied here. Behavioural parity is re-established in this repository through the synthetic fixture and, where
explicitly authorised, private local runs against the real dataset kept outside the repository.

## Since the baseline

This file records the clean starting point (commit `4d7a9e8`). What the code does now is described in
[ARCHITECTURE.md §11](ARCHITECTURE.md), [TENANCY.md](TENANCY.md) and [STOREFRONT.md](STOREFRONT.md):

- Checkpoints 1–2: multi-tenancy and row-level security, Shopify-managed install, V1 scopes only.
- Checkpoint 3: storefront extension.
- Checkpoint 4:
  - product sync and webhooks;
  - the canonical aggregate;
  - the rating cache with ownership, and reconciliation;
  - per-merchant proxy path;
  - opaque public media ids;
  - reviewer email removed from the schema.

