# Proofly — App Store submission drafts (Checkpoint 10)

Drafts for the owner to review. Items marked **[decide]** are owner decisions: contact details, legal entity and
listing copy are not invented here.

## 1. Listing

Limits and image specifications from Shopify's [app requirements checklist](https://shopify.dev/docs/apps/launch/app-requirements-checklist)
(read 2026-10-04): name ≤ 30 characters, introduction ≤ 100, details ≤ 500; icon 1200 × 1200 PNG/JPEG, square with
padding, no text; 3–6 desktop screenshots at 1600 × 900 with browser chrome and sensitive information cropped out.

- **App name (7):** Proofly
- **Introduction (94):** Import your existing reviews, moderate them in one place and show them with fast theme blocks.
- **Details (463):** Proofly moves your product reviews into Shopify from a CSV and keeps them in your own store as
  Shopify data. Products are matched by ID, handle or SKU; anything uncertain waits for your confirmation. Moderate,
  reply and export from one dashboard. Theme app blocks show a review widget, a rating summary and product-card stars
  using Shopify's standard rating fields, with no theme code edits. Plan limits never delete reviews: extras wait and
  publish oldest first.
- **Feature list:**
  - CSV import with ID, handle and SKU matching
  - Reviews stored in your own Shopify store
  - Moderation with bulk approve, hide and reject
  - Public replies to reviews (Starter and above)
  - Review widget, rating summary and card stars
  - Shopify standard rating metafields for themes
  - CSV export of all reviews
- Do not list unreleased features: verified purchases, review requests, advanced analytics, API access, photos.
- **Pricing:** recurring charges through Shopify App Pricing — the five plans in `app/lib/plans.ts` /
  [BILLING.md](BILLING.md) (Free, Starter, Growth, Pro, Scale; monthly or annual). Free trial: **[REQUIRED FROM
  CHRIS]** (Shopify recommends 14 days; none is configured today).
- **Icon:** [`brand/proofly-app-icon-1200.png`](../brand/proofly-app-icon-1200.png) — the supplied mark, unaltered,
  centred on white with padding, no text (scaled up ≈2.1× from the raster logo; a vector master from the brand owner
  would make it sharper, optional).
- **Screenshots (1600 × 900, 3–6):** dashboard; import with product matching; reviews moderation; review detail with
  reply; product-page widget; product-card stars — taken on the demo store (synthetic data, no PII, no prices).
  Shopify's checklist also says to avoid "reviews" in screenshots; whether that covers a review app's own widget
  showing synthetic reviews is **UNKNOWN** — keep the widget screenshot to one image.
- **Demo store:** a development store with the synthetic catalogue in
  [`app-store/demo-catalogue.json`](app-store/demo-catalogue.json) and the reviewer sample CSV in §6 (8 rows:
  handle/SKU matches, one pending, one reply, one title-only row that needs a manual match, one unmatched product).
- **Support:** support email, support page URL, response time **[REQUIRED FROM CHRIS]**; emergency developer contact
  in the Partner Dashboard **[REQUIRED FROM CHRIS]**.

## 2. Privacy policy draft (merchant-facing)

> **[decide]** Legal entity, address, contact email and governing law must be added and the text reviewed by the owner.

Proofly ("we") provides product reviews for Shopify stores. This policy explains what we process when a merchant
installs Proofly and when shoppers submit reviews.

**Information we collect**

From the merchant's store, through Shopify:
- the shop's identity;
- the products (ID, handle, title, status);
- an access token, which is stored encrypted.

From shoppers who submit a review:
- a star rating;
- an optional title;
- the review text;
- the display name they choose.

Proofly does not accept or store photos.

Reviews are stored in the merchant's own Shopify store (as Shopify custom data), not on our servers. We do not ask
shoppers for an email address, and we do not store their IP address, customer account or order. Abuse limits use
short-lived, one-way hashed counters that are deleted within a day. We do not access orders or customer records.

From imports, we store the review files the merchant uploads, privately in our database, for up to 30 days after the
import finishes. Files are kept longer only while some of their products still need the merchant's decision.

**How we use it.** We use this information only to display, moderate and manage the merchant's reviews and to sync
product ratings to the merchant's store. We do not sell data and do not use it for advertising.

**Retention and deletion**

- Merchants can hide or reject any review at any time and export all reviews as CSV.
- On uninstall, Proofly stops displaying reviews immediately. The reviews stay in the merchant's own Shopify store.
- When Shopify sends the shop-deletion request (48 hours after uninstall), we permanently delete everything we hold
  for the store (settings, import files, logs, access tokens). We keep only a non-identifying record that the
  deletion happened.
- We honour Shopify's customer data-request and customer-redaction requests.

**Sub-processors [decide]:** application hosting and managed Postgres (settings, logs, and import files while an
import needs them). Proofly uses no separate file storage. Reviews are stored in the merchant's own Shopify store.

**Contact [decide].**

## 3. Reviewer test plan (for Shopify's app review)

Run on the demo development store (synthetic catalogue: Stoneware Mug, Linen Tote Bag, Walnut Serving Board, Beeswax
Candle, Wool Throw Blanket, Ceramic Pour-Over Set). Proofly is installed from the App Store listing; no login screen,
no test credentials (Proofly has no third-party account).

1. **Open Proofly** from the store admin. The dashboard shows the account with three setup steps.
2. **Set up the storefront:** use **Add review widget** and **Add rating summary** — the Theme Editor opens with the
   block preselected — save; then **Open app embeds**, turn on **Product card stars**, save; then **Finish setup**.
3. **Storefront review:** open *Stoneware Mug*, choose **Write a review**, submit a rating, text and a name. It is
   pending and not visible yet.
4. **Moderate:** Proofly → **Reviews** → open the review → **Approve**. Reload the product page: the review appears
   and the rating summary and card stars update.
5. **Reply:** on the review, write a reply and save. On Free the reply is stored but not shown publicly (Plan page
   explains); on Starter and above it appears under the review.
6. **Import:** Proofly → **Import reviews** → upload `reviewer-sample.csv` (§6, supplied with the submission). The
   analysis shows 6 matched rows, 1 that needs confirmation (*Ceramic Pour-Over Set*, title only) and 1 unmatched
   product. **Confirm match** for the pour-over set, then **Start import**. Afterwards **Download problem report**
   (it lists the unmatched row).
7. **Plan:** Proofly → **Plan** opens Shopify's hosted plan page. Choose Starter (test charge on a development store);
   back in Proofly the plan shows Starter. Reviews held by the Free limit publish only with **Publish eligible
   reviews**.
8. **Export:** Reviews → **Export all reviews (CSV)** downloads every review.
9. **Uninstall:** the storefront blocks stop showing reviews immediately; the reviews stay in the store's Shopify data.

## 4. Pre-submission checklist

Master tracker: [V1-LAUNCH-CHECKLIST.md](V1-LAUNCH-CHECKLIST.md).

- [ ] Real-Shopify validation complete ([REAL-SHOPIFY-VALIDATION.md](REAL-SHOPIFY-VALIDATION.md))
- [ ] Production stack running; `/healthz` monitored; maintenance hourly with an alert on exit 1
- [ ] Production app configured (URL, App Pricing plans `free`, `starter`, `growth`, `pro`, `scale`, webhooks, proxy, extension)
- [ ] Demo store with the synthetic catalogue, the production app installed, the walk-through above passing
- [ ] Lighthouse: the app lowers the storefront performance score by no more than 10 points (Shopify's weighting:
      home 17 %, product 40 %, collection 43 %)
- [x] Listing text within Shopify's limits; icon 1200 × 1200 (§1)
- [ ] Screenshots, 3–6 at 1600 × 900
- [ ] Screencast in English covering the walk-through (Shopify asks for one with the test instructions)
- [ ] Privacy policy published at a public URL; support and emergency contacts **[REQUIRED FROM CHRIS]**

## 5. REQUIRED FROM CHRIS

Only information or actions that cannot be produced here:

- Legal entity name, registered address, governing law (privacy policy §2).
- Contact email for privacy requests; support email, support page URL and response time.
- Emergency developer contact (Partner Dashboard).
- A public URL to host the privacy policy.
- Hosting provider account and region (sub-processor names in §2 follow from it).
- Free trial: yes/no and length.
- Optional: an SVG master and reversed logo from the brand owner (BRAND.md).

## 6. Reviewer sample CSV

Save as `reviewer-sample.csv` and attach it to the submission (kept here as text: the repository tracks no CSV files —
merchant-data scan rule R1). Synthetic rows for the demo catalogue; verified to parse with Proofly's import engine.

```csv
review_id,product_handle,sku,product_title,rating,title,body,reviewer_name,review_date,status,reply
sample-001,demo-stoneware-mug,,,5,Holds heat well,Keeps coffee warm for ages and feels solid in the hand.,Alex R.,2025-03-02,published,Thank you for the kind words!
sample-002,demo-stoneware-mug,,,4,Lovely glaze,The glaze is even more beautiful in person. Slightly smaller than expected.,Jordan P.,2025-03-14,published,
sample-003,,DEMO-TOTE-01,,5,Everyday bag,Sturdy straps and it fits a laptop easily.,Sam K.,2025-04-01,published,
sample-004,demo-walnut-board,,,4,Great for cheese,Nice weight and the wood grain is beautiful. Needs oiling now and then.,Riley M.,2025-04-20,published,
sample-005,demo-beeswax-candle,,,5,Clean burn,Burns evenly with a gentle honey scent.,Casey L.,2025-05-05,pending,
sample-006,demo-wool-throw,,,3,Warm but itchy,Very warm but a little scratchy against bare skin.,Morgan T.,2025-05-18,published,
sample-007,,,Ceramic Pour-Over Set,5,Morning ritual,Brews a smooth cup. This row has only a product title so it needs a manual match.,Taylor B.,2025-06-02,published,
sample-008,demo-not-in-store,,,4,Unknown product,This row refers to a product that is not in the demo store and stays unmatched.,Jamie D.,2025-06-10,published,
```
