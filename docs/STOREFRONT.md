# Proofly — Storefront (Checkpoint 3)

Postgres is the canonical review store. Shopify holds only a lightweight cache: the standard product metafields
`reviews.rating` and `reviews.rating_count`. The storefront is a theme app extension. No theme file is edited, and no
theme snippet, template or `theme.liquid` is required.

## Extension (`extensions/proofly/`)

| File | Kind | JS | What it does |
|---|---|---|---|
| `blocks/reviews.liquid` | App block (product) | `proofly-reviews.js` (deferred) | Review widget: average, stars, count, rating breakdown, review list, photos + lightbox, rating filter, photo filter, sort, load more, empty state, write-a-review, optional JSON-LD |
| `blocks/rating-summary.liquid` | App block (product) | none | Stars, average and review count; links to the widget |
| `blocks/card-ratings.liquid` | App embed (body) | `proofly-cards.js` (deferred) | Product-card stars, for themes that don't already show Shopify's standard rating on cards |
| `assets/proofly.css` | Widget stylesheet | — | |
| `assets/proofly-stars.css` | Summary + card stylesheet | — | |

There's no framework and no jQuery. Nothing polls: the widget loads when it nears the viewport, and the card embed
re-runs only when the theme adds product links. Neither script makes third-party requests. Review text is written with
`textContent` only.

## How ratings are surfaced

1. **Source of truth.** Aggregates are computed in Postgres from public reviews only (`status = published AND
   hold_reason IS NULL`). They are mirrored to the product's `reviews.rating` and `reviews.rating_count` metafields
   through the Admin API, from the admin side (moderation and sync), never from a storefront request.
2. **Rating summary block and widget header.** Liquid reads those metafields, so Shopify renders them server-side in
   the page HTML. There is no JavaScript, no request and no layout shift.
3. **Product cards.**
   - **Theme-native (preferred).** Many Online Store 2.0 themes have a "Show product rating" card setting that renders
     the same standard metafields. It needs no app code.
   - **Card embed (fallback).** The embed's Liquid writes `{handle: [average, count]}` from the same metafields for
     every product Liquid can see (collection products, search results) into an inert `<script type="application/json">`.
     `proofly-cards.js` finds product cards generically: a text link to `/products/<handle>` with an image a few levels
     up, skipping header, nav and footer. A merchant-supplied CSS selector setting can override that. It skips cards
     that already show a rating and places stars under the title.
   - **Batched request.** Only cards Liquid could not see (for example "You may also like") are looked up, in one
     request per page: `GET {locale root}/apps/proofly/ratings?handles=a,b,c`. It returns at most 100 handles and is
     cached for 5 minutes.

## How full reviews are retrieved

`GET {locale root}/apps/proofly/products/<productId>/reviews?page=&sort=recent|highest|lowest&rating=&photos=1&summary=1`
goes through the shop's own Shopify app proxy:

- **Tenant.** Shopify signs each request (HMAC). The tenant is the signed shop plus its stored session, and an
  unknown or uninstalled shop gets a 404.
- **Data.** Postgres returns 10 public reviews per page. Only media with `media_status = published` is included.
- **Response fields.** The response is an allow-listed JSON shape: rating, title, body, name, date, verified, images
  (thumb, large, w, h) and reply (body, date). It has no ids, email, customer or order ids, IP hashes, status or flags.
- **When it's requested.** The widget asks only if the product has reviews (according to the metafield count), only
  once the widget nears the viewport, and once per page or filter change. The Admin API is never called.

## Visibility rules

`PUBLIC_REVIEW` / `PUBLIC_MEDIA` in `app/lib/reviews.server.ts` is the single definition used by the list, summary,
aggregates, metafields and card ratings. The following never reach the storefront:

- pending, rejected and hidden reviews;
- plan-limited reviews (`hold_reason = plan_limit`, even if the status says published);
- storage-limited, processing or failed media.

## Failure behaviour

- If Proofly can't be reached, the server-rendered summary still shows and the list shows "Reviews couldn't be loaded
  right now" with a Try again button.
- Card stars stay absent rather than showing wrong data.
- Products with no reviews show an empty state and make no request.

## Local preview

```bash
npm run dev:seed      # fictional dev shop (DEV_SHOP_DOMAIN) with every review state; local *_dev DB only
npx react-router dev  # then open /dev/preview[?handle=…]
```

The preview renders the real block Liquid with liquidjs and simulates the metafields from the database. Locally
signed app-proxy requests exercise the real HMAC verification.
