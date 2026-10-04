# Proofly — App Store submission drafts (Checkpoint 10)

Drafts for the owner to review. Items marked **[decide]** are owner decisions: contact details, legal entity and
listing copy are not invented here.

## 1. Listing draft

- **Name:** Proofly
- **Tagline:** Bring your reviews with you. Show them beautifully.
- **Introduction:** Move your existing product reviews into Shopify in minutes, moderate them in one place, and display
  them with fast, theme-native blocks.
- **Key benefits:**
  - **Migration first:** import a CSV and photos (a ZIP or `https` links). Proofly matches products by ID, handle or SKU.
    It never guesses, so anything uncertain waits for your decision.
  - **Native storefront:** a review widget, a rating summary and product-card stars built as theme app blocks. There are
    no theme code edits, and they use Shopify's standard rating fields.
  - **Fair plans:** nothing is ever deleted because of a plan limit. Reviews over the allowance are kept and published
    oldest first when you have room.
- **Features (V1):** photo reviews, moderation (approve, hide, reject, plus bulk actions), public replies (Starter and
  above), CSV review export, and product-rating sync to Shopify.
  - Do not list unreleased features: verified purchases, review requests, advanced analytics and API access.
- **Pricing:** the five plans in `app/lib/plans.ts` / [BILLING.md](BILLING.md), billed by Shopify.
- **Screenshots [decide, on a demo store]:** dashboard, import with product matching, reviews moderation, product page
  widget, product-card stars.
- **Support [decide]:** support email, support page URL, and response time (priority support from Growth).
- **Demo store [decide]:** a development store containing only synthetic data.

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
- the display name they choose;
- optional photos.

We do not ask shoppers for an email address. We store a salted one-way hash of the submitter's IP address to prevent
abuse. We do not access orders or customer records.

From imports, we store the review files the merchant uploads, in private storage, for up to 30 days after the import
finishes. Files are kept longer only while some of their products still need the merchant's decision.

**How we use it.** We use this information only to display, moderate and manage the merchant's reviews and to sync
product ratings to the merchant's store. We do not sell data and do not use it for advertising.

**Photos.** Originals are kept privately. Only resized copies with metadata removed are published, and only for
published reviews.

**Retention and deletion**

- Merchants can hide or reject any review at any time and export all reviews as CSV.
- On uninstall, Proofly stops displaying reviews immediately.
- When Shopify sends the shop-deletion request (48 hours after uninstall), we permanently delete all of the store's
  data and files. We keep only a non-identifying record that the deletion happened.
- We honour Shopify's customer data-request and customer-redaction requests.

**Sub-processors [decide]:** application hosting, managed Postgres, and object storage with a CDN.

**Contact [decide].**

## 3. Reviewer test plan (for Shopify's app review)

1. Install on the review store. The app opens in the admin without any login screen, and the dashboard shows an empty
   account with three setup steps.
2. **Set up Proofly:**
   - Use **Add review widget** and **Add rating summary**. The Theme Editor opens with the block preselected; save.
   - Use **Open app embeds** and turn on **Product card stars**.
   - Then use **Finish setup**. Products import in the background (**Products** page).
3. **Storefront:** open a product page and choose **Write a review**. Submit a rating, text, a name and a photo. The
   review is pending: it is not visible yet.
4. **Admin → Reviews:** approve it. It appears on the product page, and the product's rating updates on cards.
5. Reply to it (needs Starter or above; on Free the reply is stored but not shown).
6. **Import:**
   - Upload the sample CSV supplied with the submission (synthetic data).
   - Resolve one unmatched product with **Confirm match**, then start the import.
   - Download the problem report.
7. **Plan:** the plans open Shopify's hosted plan page. A test charge upgrades the plan, and held reviews are published
   only with **Publish eligible reviews**.
8. **Reviews → Export all reviews (CSV)** downloads all reviews.
9. Uninstall: the storefront blocks stop showing reviews immediately.

## 4. Pre-submission checklist

- [ ] All REAL-SHOPIFY VALIDATION items in [LAUNCH.md](LAUNCH.md) §4 passed on a development store
- [ ] Listing copy, screenshots, demo store, support contact **[decide]**
- [ ] Privacy policy published at a public URL **[decide]**
- [ ] App Pricing plans configured with the handles in `app/lib/plans.ts`
- [ ] Production environment passes the startup checks; `/healthz` monitored; maintenance scheduled hourly
- [ ] Lighthouse report for a product page with the widget
