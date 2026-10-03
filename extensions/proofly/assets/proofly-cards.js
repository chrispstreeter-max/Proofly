/* Proofly — product-card stars (app embed). Ratings come from the JSON the embed's Liquid rendered from Shopify's
   standard rating metafields (no request); products Liquid could not see are looked up in ONE batched request.
   No polling: it re-runs only when the theme adds product links (AJAX filters, infinite scroll). Never edits theme
   files; writes only textContent/attributes. A failed lookup leaves the card without stars. */
(() => {
  const cfg = document.getElementById("pf-cards");
  if (!cfg || cfg.dataset.ready) return;
  cfg.dataset.ready = "1";
  let known = {};
  try { known = JSON.parse(cfg.textContent) || {}; } catch { /* fall back to the batched request */ }
  const LINK = "a[href*='/products/']";
  const sel = cfg.dataset.selector || LINK;
  const asked = new Set();

  const handleOf = (a) => {
    const m = /\/products\/([^/?#]+)/.exec(a.pathname || "");
    try { return m && decodeURIComponent(m[1]).toLowerCase(); } catch { return null; }
  };
  // A product card: a text link to a product with an image a few levels up (skips menus, breadcrumbs, plain text links).
  const cardOf = (el) => {
    for (let n = el.parentElement, i = 0; n && i < 6; n = n.parentElement, i++) if (n.querySelector("img,picture,svg")) return n;
    return null;
  };

  function targets() {
    const out = [];
    const cards = new Set();
    for (const el of document.querySelectorAll(sel)) {
      if (el.dataset.pf || el.closest("header,footer,nav,dialog,form,.pf,[aria-hidden='true']")) continue;
      el.dataset.pf = "1";
      const a = el.matches("a") ? el : el.querySelector("a[href]") || el.closest("a");
      const h = a && handleOf(a);
      const card = h && h !== cfg.dataset.current && el.textContent.trim() && cardOf(el);
      // Skip cards that already show a rating (the theme's native one, or ours from another link in the card).
      if (!card || cards.has(card) || card.querySelector(".pf-badge,.pf-summary,[class*='rating']:not([class*='pf-'])")) continue;
      cards.add(card);
      out.push([el, h]);
    }
    return out;
  }

  function paint(el, r) {
    if (!r || !(r[1] > 0)) return;
    const avg = Number(r[0]);
    const count = Number(r[1]);
    const b = document.createElement("div");
    b.className = "pf-badge";
    b.setAttribute("role", "img");
    b.setAttribute("aria-label", `Rated ${avg.toFixed(1)} out of 5 from ${count} review${count === 1 ? "" : "s"}`);
    const s = document.createElement("span");
    s.className = "pf-stars";
    s.style.setProperty("--p", `${Math.min(100, avg * 20)}%`);
    b.append(s);
    if (cfg.dataset.count !== "0") {
      const c = document.createElement("span");
      c.className = "pf-badge-count";
      c.textContent = `(${count})`;
      b.append(c);
    }
    (el.closest("h1,h2,h3,h4,h5,h6") || el).after(b);
  }

  let queued = false;
  async function run() {
    queued = false;
    const found = targets();
    const missing = cfg.dataset.api ? [...new Set(found.map((f) => f[1]))].filter((h) => !(h in known) && !asked.has(h)) : [];
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100);
      batch.forEach((h) => asked.add(h));
      try {
        const res = await fetch(`${cfg.dataset.api}/ratings?handles=${batch.map(encodeURIComponent).join(",")}`, { headers: { Accept: "application/json" } });
        if (!res.ok) continue;
        const { ratings } = await res.json();
        batch.forEach((h) => (known[h] = ratings[h] || null));
      } catch { /* network error: those cards simply get no stars */ }
    }
    found.forEach(([el, h]) => paint(el, known[h]));
  }
  const schedule = () => { if (!queued) { queued = true; (window.requestIdleCallback || setTimeout)(run); } };

  schedule();
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches(LINK) || n.querySelector(LINK))) return schedule();
  }).observe(document.body, { childList: true, subtree: true });
})();
