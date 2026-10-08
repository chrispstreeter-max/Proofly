# Proofly Reviews — review screencast (≈ 2 minutes)

Shopify asks for a screencast with the submission (App testing information → **Screencast URL**). Same method as
Liftline: the owner records the raw screen; `scripts/voiceover.swift` adds the narration and English captions.

**Store:** Proofly Demo (development store, CHRISPSDesign) with the demo catalogue and the Review widget on the
product template. **Record** your own browser at 1280 × 800 or larger (macOS: ⇧⌘5 → *Record Selected Portion* around
the browser window), no narration needed, no personal data on screen (the storefront password page is fine to skip:
enter the password before you start recording). Go slowly: pause ~2 seconds on each result so it can be narrated.

| # | Show | Narration (added afterwards) |
|---|---|---|
| 1 | Shopify admin → **Apps → Proofly Reviews** (dashboard: plan usage, review counts) | "This is Proofly Reviews on a demo store. It brings your existing product reviews into Shopify and keeps them in your own store." |
| 2 | **Import** → choose `screencast-sample.csv` (below) → the analysis | "Upload a CSV from your old review app. Proofly matches each review to a product by ID, handle or SKU." |
| 3 | The **Ceramic Pour-Over Set** row (title only) → choose the product → **Confirm match** → **Start import** | "Anything uncertain waits for you. Titles are never matched automatically." |
| 4 | Import result (imported, published, awaiting moderation) | "Reviews are written to your store as Shopify data. Plan limits never delete a review." |
| 5 | **Reviews** → open the pending review → **Approve** | "Moderate in one place: approve, hide or reject, one at a time or in bulk." |
| 6 | On a published review: write a reply → **Save** | "Reply publicly to any review." |
| 7 | Storefront: open **Stoneware Mug** → scroll to the widget (summary, breakdown, filters, list) | "On the storefront, theme blocks show the review widget, a rating summary and product-card stars, with no theme code." |
| 8 | **Write a review** → rating, text, name → **Submit** → thank-you | "Shoppers can write a review. It waits for your approval before it appears." |
| 9 | Admin → **Reviews** → **Export all reviews (CSV)** | "Your reviews are always yours: export them all as a CSV at any time." |
| 10 | **Plan** → **Change plan in Shopify** (Shopify's plan page; don't approve) | "Billing runs through Shopify, with a free plan and paid plans that include a 7-day trial. That's Proofly Reviews." |

Then send the recording to Claude: it extracts frames, times the narration to what happens on screen, and produces
`proofly-screencast.mp4` + `.srt`. Upload as **Unlisted** on YouTube and paste the link into the listing.

## screencast-sample.csv

Fresh synthetic rows (the reviewer sample is already imported on the demo store). Save as `screencast-sample.csv`.

```csv
review_id,product_handle,sku,product_title,rating,title,body,reviewer_name,review_date,status,reply
cast-001,demo-stoneware-mug,,,5,Morning favourite,The glaze is lovely and it keeps tea hot for ages.,Ella J.,2025-09-02,published,
cast-002,demo-walnut-board,,,5,Beautiful grain,Solid and heavy. Looks great with cheese and fruit.,Marcus D.,2025-09-05,published,
cast-003,,DEMO-TOTE-01,,4,Handy everyday bag,Strong handles. I wish it had an inside pocket.,Ana P.,2025-09-08,published,
cast-004,demo-wool-throw,,,5,So cosy,Soft enough for the sofa and warm on cold nights.,Owen R.,2025-09-11,published,
cast-005,demo-beeswax-candle,,,4,Lovely scent,Gentle honey smell and a clean burn.,Isla F.,2025-09-14,pending,
cast-006,,,Ceramic Pour-Over Set,5,Great coffee,Brews a smooth cup every time.,Ravi N.,2025-09-17,published,
```
