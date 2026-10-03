# Proofly — Brand

**Proofly** is a commercial Shopify App Store product for product reviews and review management.
Core proposition: **“Bring your existing reviews with you.”**

Proofly is the product. Merchants who use Proofly — including the first, launch-validation merchant — are customers,
not the brand. Legacy review providers that merchants migrate away from have no place in Proofly's brand.

---

## 1. Name

- Always **Proofly** — one word, capital P, lower-case “roofly”. Never “ProofLy”, “PROOFLY” in running text,
  “Proof.ly” or “Proofly App”.
- Feature names pair the brand with a plain noun: Proofly Reviews, Proofly Dashboard, Proofly Import,
  Proofly Moderation, Proofly Analytics, Proofly Settings, Proofly theme extension.
- Never customer-facing: prototype names, merchant names, legacy-provider names or internal code names.
  (`pf` is the internal CSS/JS prefix for storefront components.)

## 2. Logo

| Asset | File | Notes |
|---|---|---|
| Primary logo (mark + wordmark, horizontal) | [`brand/proofly-logo.png`](../brand/proofly-logo.png) | 1774 × 887 px, PNG, transparent background. SHA-256 `ccbd68a384772826cfcfe6714a3166b764578c4eb215f12bdfcc34fe95e53677` |

The supplied file is the **canonical** Proofly logo: a blue-to-violet gradient “P” review bubble containing a white
bubble with an indigo star, followed by the dark **Proofly** wordmark. It is used exactly as supplied.

Still needed from the brand owner (do not improvise): vector master (SVG), mark-only square icon for the Shopify App
Store listing (1200 × 1200) and favicon, and a reversed (light-on-dark) version.

### Clear space
Measured on the master file the mark is 438 px tall. Keep clear space on every side of the logo of at least
**one quarter of the mark height** (≈ the height of the star). Nothing (text, edges, other logos) enters that zone.

### Minimum size
- Full logo: **120 px** wide on screen (≈ 30 mm in print).
- Mark alone (once an official mark-only asset exists): **24 px**.

### Logo don'ts
Don't recolour, re-gradient or flatten the mark · don't stretch, rotate or skew · don't separate or re-space the mark
and wordmark · don't add shadows, outlines, glows or effects · don't place on busy photos or low-contrast backgrounds ·
don't recreate it in another font · don't combine it with merchant or legacy-provider brands into a lock-up ·
don't use prototype names or screenshots as brand material.

## 3. Colour

Brand colours are sampled from the logo master; UI neutrals are tints of the wordmark ink so nothing contradicts it.

| Token | Hex | Source / use |
|---|---|---|
| `proofly-blue` | `#4047FA` | Gradient start (top-left of mark). Primary accent, links, focus rings in Proofly-branded surfaces |
| `proofly-violet` | `#955BFC` | Gradient end (top-right of mark). Gradient partner only; never on its own for body text |
| `proofly-indigo` | `#4F45F9` | The star. Primary buttons and key highlights in the Proofly admin and marketing |
| `proofly-deep` | `#2D2DCB` | Shadow fold of the mark. Hover/pressed states, high-contrast accents |
| `proofly-ink` | `#111221` | Wordmark. Headings and primary text on light backgrounds |
| `white` | `#FFFFFF` | Inner bubble. Backgrounds, text on indigo |
| `ink-70` / `ink-50` / `ink-10` | tints of `#111221` | Secondary text, borders, subtle surfaces |

Gradient: `linear-gradient(135deg, #4047FA 0%, #955BFC 100%)` — reserved for the logo and, sparingly, a single hero
moment in marketing. No gradients in product UI chrome.

Contrast on white (measured): ink 18.6:1 · deep 8.9:1 · blue 6.0:1 · indigo 5.9:1 — all pass WCAG AA for normal
text (white on these colours has the same ratio). Violet is 4.1:1 — fails AA for small text; use it only in the
gradient or for large display type.

**Merchant storefront is not Proofly-coloured.** Storefront widgets default to neutral colours and the theme's own
fonts; merchants choose star and accent colours.

## 4. Typography direction

- **Admin (inside Shopify):** Polaris defaults — the Shopify admin font stack. Proofly does not override Shopify admin
  typography.
- **Storefront:** inherits the merchant's theme fonts by default; never ships webfonts.
- **Marketing / App Store listing / docs:** a clean geometric sans-serif with heavy weights for headlines that sits
  comfortably next to the bold wordmark (e.g. Inter, Manrope or a similar open-licence face), regular weight for body.
  The wordmark itself is artwork, not a font to type with.
- Scale: few sizes, strong hierarchy — large confident headlines, generous line height (1.5) for body, tabular
  numerals for metrics.

## 5. UI design direction (Proofly admin)

Premium, clean, modern, fast, data-focused, Shopify-native.

- Build with Shopify's Polaris web components and App Bridge so Proofly feels part of the admin.
- Data first: numbers, statuses and actions before decoration. One primary action per screen.
- Restrained colour: indigo only for primary actions and selected states; status uses Polaris tones.
- Density appropriate for daily moderation work: tables over card grids for lists; no huge cards.
- Moderate corner radii (Polaris defaults); avoid “everything is a pill”.
- Empty, loading and error states are designed, not afterthoughts: plain language, a next step, no cartoons.
- No ads, upsell banners or promotions inside the admin beyond the plan page and genuine limit notices.

## 6. Storefront design direction

Merchant-first and white-label.

- Looks native to the merchant's theme: inherits fonts, spacing rhythm and text colour; configurable star and accent
  colours; scoped CSS that never restyles the theme.
- Premium review layout: summary with average, stars and “Based on N reviews”, rating distribution, filters, sorting,
  clean review cards, photo gallery, merchant responses — the current reference build is the design baseline.
- Fast: tiny scripts, lazy-loaded lists and images, no iframes, no layout shift.
- **No “Powered by Proofly” by default.** If attribution is ever offered it is an explicit merchant opt-in and must
  follow Shopify's App Store storefront-branding rules.

## 7. App Store branding direction

- Listing name: **Proofly** with a descriptive subtitle in Shopify's allowed format (e.g. “Proofly: Product Reviews &
  Migration”, final wording to be checked against listing rules).
- Icon: official mark-only asset (to be supplied), no text in the icon.
- Screenshots: real UI on a neutral demo store — migration analysis, import report, storefront reviews on a popular
  theme, moderation. No merchant or legacy-provider branding, no real customer names without consent (use the demo store).
- Claims: factual and verifiable; never promise review volume or sales uplift; never imply fake or incentivised reviews.

## 8. Tone of voice

Calm, competent, plain-spoken. Proofly is the careful pair of hands for something merchants value: their
customers' words.

- Clear over clever: “1,084 reviews ready to import. 3 need a product match.”
- Transparent: always say what happened and what didn't, with numbers.
- Respectful of reviewers: neutral language when asking for reviews; never pressure or incentivise.
- Short sentences, active voice, verbs on buttons (“Import reviews”, “Match products”, “Publish”).
- No hype, no exclamation-mark stacks, no “AI-powered” buzzwords.

## 9. Do / don't

| Do | Don't |
|---|---|
| “Bring your existing reviews with you.” | “Supercharge your social proof with AI!” |
| “We couldn't match 3 reviews to a product. Choose the product or skip them.” | “Oops! Something went wrong 😬” |
| “Import reviews” | “Submit” / “OK” |
| Use the supplied logo file as-is | Redraw, recolour or “refresh” the logo |
| Neutral, theme-matched storefront widgets | Purple Proofly-branded widgets on merchant stores |
| Indigo for one primary action | Gradients on buttons, cards and backgrounds |
| Tables and clear statuses in the admin | Oversized cards, decorative illustrations, clutter |
| Proofly as the only product name | Prototype, merchant or legacy-provider names in product UI |
