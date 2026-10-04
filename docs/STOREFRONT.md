# Proofly — Storefront (Checkpoints 3–4)

Postgres is the canonical review store. Shopify holds only a derived cache: the standard product metafields
`reviews.rating` and `reviews.rating_count`, written only for products whose rating Proofly owns
([ARCHITECTURE.md §11.2](ARCHITECTURE.md)). The storefront is a theme app extension. No theme file is edited, and no
theme snippet, template or `theme.liquid` is required.

## Extension (`extensions/proofly/`)

| File | Kind | JS | What it does |
|---|---|---|---|
| `blocks/reviews.liquid` | App block (product) | `proofly-reviews.js` (deferred) | Review widget: average, stars, count, rating breakdown, review list, photos + lightbox, rating filter, photo filter, sort, load more, empty state, write-a-review, optional JSON-LD |
| `blocks/rating-summary.liquid` | App block (any section offering app blocks; product auto-filled) | none | Stars, average and review count; links to the widget. The controlled way to show ratings on product cards and featured products |
| `blocks/card-ratings.liquid` | App embed (body) | `proofly-cards.js` (deferred) | Automatic product-card stars where neither a theme rating nor the Rating summary block is present |
| `assets/proofly.css` | Widget stylesheet | — | |
| `assets/proofly-stars.css` | Summary + card stylesheet | — | |

There's no framework and no jQuery. Nothing polls: the widget loads when it nears the viewport, and the card embed
re-runs only when the theme adds product links. Neither script makes third-party requests. Review text is written with
`textContent` only.

## How ratings are surfaced

1. **Source of truth.** One aggregate (`computeAggregate`) over public reviews only: published and not held. Proofly
   mirrors it to `reviews.rating` / `reviews.rating_count` through the Admin API, for Proofly-managed products only,
   from the admin side (moderation, sync, reconciliation), never from a storefront request.
2. **Rating summary block and widget header.** Liquid reads those metafields, so Shopify renders them server-side in
   the page HTML. There is no JavaScript, no request and no layout shift.
3. **Product cards: a deterministic hierarchy.** Proofly does not rely on themes choosing to show ratings.
   1. **Shopify-native data.** Proofly keeps the standard metafields correct for the products it rates. Themes that
      read them show the same numbers.
   2. **Rating summary block (preferred).** The merchant adds it in the Theme Editor wherever a section offers app
      blocks (product info, featured product, product cards in themes whose cards accept app blocks). Shopify
      auto-fills the product. Pure Liquid, no request.
   3. **Card embed (fallback).** The embed's Liquid writes `{handle: [average, count]}` from the same metafields for
      every product Liquid can see (collection products, search results) into an inert `<script type="application/json">`.
      `proofly-cards.js` finds product cards generically: a text link to `/products/<handle>` with an image a few
      levels up, skipping header, nav and footer. A merchant-supplied CSS selector setting can override that. It skips
      cards that already show a rating (theme-native or the Rating summary block) and places stars under the title.
      Only cards Liquid could not see (for example "You may also like") are looked up, in one request per page:
      `GET {locale root}{proxy path}/ratings?handles=a,b,c`. It returns at most 100 handles, is cached for 5 minutes,
      and never resolves a deleted product's handle.
   4. **Never theme code.** Proofly does not edit `theme.liquid`, templates, sections or snippets.

## Proxy path

The store's app proxy path belongs to the merchant (default `/apps/proofly`; merchants can change it in Shopify).
- **Where it lives:** Proofly stores it per shop, sets it in the admin under "Storefront connection", and publishes it
  to the app-data metafield `proofly.proxy_path`.
- **How the blocks use it:** they read `app.metafields.proofly.proxy_path.value` and prefix the locale root. Without
  it they render no request target (fail closed).
- **How the server checks it:** a request is accepted only if Shopify signed it with that shop's own path. No path is
  hard-coded outside `app/lib/proxy-path.server.ts`.

## How full reviews are retrieved

`GET {locale root}{proxy path}/products/<productId>/reviews?page=&sort=recent|highest|lowest&rating=&photos=1&summary=1`
goes through the shop's own Shopify app proxy:

- **Tenant.** Shopify signs each request (HMAC). The tenant is the signed shop plus its stored session, and the signed
  `path_prefix` must be that shop's configured proxy path. An unknown or uninstalled shop, or a wrong path, gets a 404.
- **Data.** Postgres returns 10 public reviews per page, never for deleted products. Only public photos are included
  (published, not storage-limited). A review whose photos are all storage-limited is shown without photos.
- **Photos.** `<MEDIA_PUBLIC_URL>/<opaque-id>-320.webp` / `-1600.webp`. The URL carries only a random asset id, and the
  `/media` resolver serves it only while the photo is public ([ARCHITECTURE.md §11.7](ARCHITECTURE.md)).
- **Response fields.** The response is an allow-listed JSON shape: rating, title, body, name, date, verified, images
  (thumb, large, w, h) and reply (body, date). `reply` is included only when the shop's current plan includes Replies;
  otherwise it is `null`, exactly as for a review without a reply (the stored reply is kept, never deleted). It has no ids, email, customer or order ids, IP hashes, status or flags.
- **When it's requested.** The widget asks only if the product has reviews (according to the metafield count), only
  once the widget nears the viewport, and once per page or filter change. The Admin API is never called.

## Visibility rules

`PUBLIC_REVIEW` / `PUBLIC_MEDIA` in `app/lib/reviews.server.ts` is the single definition used by the list, summary,
aggregates, metafields and card ratings. The following never reach the storefront:

- pending, rejected and hidden reviews;
- plan-limited reviews (`hold_reason = plan_limit`, even if the status says published);
- storage-limited, processing or failed media. Storage limits apply to photos only: they never change review count,
  average or distribution, only the photo-review count.
- reviews of products deleted in Shopify (kept for the merchant, never shown).

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

The preview renders the real block Liquid with liquidjs and simulates the metafields (rating and the proxy-path
app metafield) from the database. Locally
signed app-proxy requests exercise the real HMAC verification.
