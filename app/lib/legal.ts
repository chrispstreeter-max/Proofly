/**
 * Public legal and support pages (/privacy, /terms, /support), served without login like Liftline's. Facts here must
 * match the code: reviews live in the merchant's Shopify store (metaobjects); Proofly's database holds settings, the
 * product cache, import files (≤ 30 days after an import) and logs; shop/redact deletes all of it (tenant.server.ts).
 */
// The support address comes from the environment (SUPPORT_EMAIL, like Liftline): the repository holds no real email
// addresses (merchant-data scan R3).
const MAKER = "CHRISPSDesign";
const UPDATED = "8 October 2026";
const contact = () => {
  const e = process.env.SUPPORT_EMAIL?.trim();
  return e ? `<a href="mailto:${e}">${e}</a>` : "us through our Shopify App Store listing";
};

export const PRIVACY = (mail = contact()) => `<h1>Proofly Reviews privacy policy</h1>
<p><i>Last updated: ${UPDATED}. Proofly Reviews ("Proofly") is made by ${MAKER}.</i></p>

<h2>What Proofly is</h2>
<p>Proofly is a Shopify app that imports a store's existing product reviews, lets the merchant moderate them, and shows them on the storefront. This policy explains what data Proofly processes, why, and how it is protected.</p>

<h2>Data we access from the store</h2>
<ul>
<li><b>Store identity</b>: the shop's name and Shopify domain;</li>
<li><b>Products</b>: ID, handle, title and status, to match and display reviews;</li>
<li>an <b>access token</b> issued by Shopify, stored encrypted.</li>
</ul>
<p>Proofly does not request access to orders, customer records or payment data.</p>

<h2>Data from shoppers who write a review</h2>
<p>A star rating, an optional title, the review text and the display name the shopper chooses. Proofly does not ask for an email address, accepts no photos, and does not store the shopper's IP address, customer account or order. To prevent abuse, submissions are counted with short-lived, one-way hashed values that are deleted within a day.</p>

<h2>Where reviews are stored</h2>
<p>Reviews are stored in the merchant's own Shopify store as Shopify data, not on our servers. They stay with the store if Proofly is uninstalled. Proofly's own database holds the store's settings, a cached copy of product details, activity logs and review files the merchant uploads for import.</p>

<h2>How we use it</h2>
<ul>
<li>To import, moderate, display and export the merchant's reviews and to keep product ratings up to date in the store.</li>
<li>Uploaded import files are kept privately for up to 30 days after the import finishes (longer only while some of their products still need the merchant's decision), then deleted.</li>
</ul>
<p>We never sell data, never use one store's data for another store, and do not use it for advertising.</p>

<h2>Storage and security</h2>
<ul>
<li>Our application runs on Render and our database on Neon, both in the United States. Data is encrypted in transit (HTTPS) and at rest by these providers.</li>
<li>Shopify access tokens are additionally encrypted by Proofly. Each store's records are isolated in the database, and access to production systems is limited to the developer.</li>
</ul>

<h2>Retention and deletion</h2>
<ul>
<li>Merchants can hide or reject any review at any time and export all reviews as CSV.</li>
<li>When a merchant uninstalls Proofly, its storefront blocks stop showing. When Shopify sends the shop deletion request (48 hours after uninstall), we permanently delete everything we hold for that store (settings, product cache, import files, logs and access tokens), keeping only a non-identifying record that the deletion happened. Our database provider's short-term recovery copies expire shortly afterwards.</li>
<li>Proofly stores no customer identity, so customer data and deletion requests from Shopify are answered and recorded without holding any customer data.</li>
</ul>

<h2>Your rights</h2>
<p>Shoppers should contact the store they reviewed to exercise their rights (access, correction, deletion); the merchant can edit or remove any review. Merchants can contact us at any time.</p>

<h2>Contact</h2>
<p>See also our <a href="/terms">terms of service and data processing terms</a>.</p>
<p>${MAKER}: ${mail}</p>`;

export const TERMS = (mail = contact()) => `<h1>Proofly Reviews terms of service and data processing terms</h1>
<p><i>Last updated: ${UPDATED}. Proofly Reviews ("Proofly") is made by ${MAKER} ("we"). These terms apply to every store ("you") that installs Proofly from the Shopify App Store.</i></p>

<h2>1. The service</h2>
<p>Proofly imports your product reviews from a CSV, stores them in your own Shopify store, lets you moderate, reply to and export them, and shows them on your storefront through theme app blocks. Proofly never edits your theme code, places orders or changes prices.</p>

<h2>2. Billing</h2>
<p>Proofly is billed by Shopify through your Shopify invoice. The plans, including a free plan and paid plans with a 7-day free trial, are shown on Shopify's plan page before you subscribe. You can change or cancel at any time; Shopify handles any proration or refunds under its own billing rules. Plan limits never delete reviews.</p>

<h2>3. Your responsibilities</h2>
<ul>
<li>You are responsible for having the right to import the reviews you upload and for the reviews you choose to publish.</li>
<li>Reviews remain your store's data. You can export them at any time and they stay in your store if you uninstall Proofly.</li>
</ul>

<h2>4. Data processing</h2>
<p>For the personal data in your reviews (reviewer display names), you are the controller and we are your processor. We:</p>
<ul>
<li>process it only to provide Proofly to you, as described in our <a href="/privacy">privacy policy</a>, and never sell it or use it for any other store;</li>
<li>keep the minimum needed. Reviews are stored in your Shopify store; we do not collect shoppers' emails, IP addresses, accounts or orders;</li>
<li>isolate each store's records, encrypt data in transit and at rest, and limit access to the developer;</li>
<li>permanently delete everything we hold for your store when Shopify sends the shop deletion request (48 hours after uninstall);</li>
<li>use Render (hosting, United States) and Neon (database, United States) as our only sub-processors, and tell you before adding another;</li>
<li>notify you without undue delay, and within 72 hours, if we become aware of a breach affecting your data, and help you meet your own obligations.</li>
</ul>

<h2>5. Availability and liability</h2>
<p>We aim to keep Proofly available and fix problems quickly, but it is provided "as is". To the extent the law allows, our total liability is limited to the fees you paid for Proofly in the 12 months before a claim, and we are not liable for indirect or lost-profit losses.</p>

<h2>6. Changes and contact</h2>
<p>We may update these terms; material changes will be announced in the app before they take effect. Questions: ${mail}.</p>`;

export const SUPPORT = (mail = contact()) => `<h1>Proofly Reviews support</h1>
<p>Email ${mail}. We reply within one business day.</p>
<p>Proofly runs inside your Shopify admin: go to <b>Apps → Proofly Reviews</b>. To show reviews on your store, open the theme editor and add the <b>Review widget</b> block to your product template.</p>
<p><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of service</a></p>`;

/** A plain, self-contained page (no admin chrome, no scripts). */
export const legalPage = (title: string, body: string) =>
  new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Proofly Reviews</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#111221;max-width:760px;margin:0 auto;padding:40px 20px 64px;line-height:1.6}
h1{font-size:28px;line-height:1.2}h2{font-size:19px;margin-top:32px}a{color:#2D2DCB}li{margin:6px 0}</style></head>
<body>${body}</body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
