/* Proofly — product-card ratings. Hydrates `<span data-pf-rating data-product-id="…">` hooks. One batched request per page; re-runs for cards added later
   (AJAX filtering, quick view, infinite scroll). Each product shows its own count. */
(() => {
  const SEL = "[data-pf-rating][data-product-id]";
  const cache = new Map(); // productId → {c, a} | null
  const idOf = (n) => n.dataset.productId;

  function paint(n) {
    const r = cache.get(idOf(n));
    n.dataset.pfDone = "1";
    if (!r) return;
    const wrap = document.createElement("span");
    wrap.className = "pf-badge";
    const s = document.createElement("span");
    s.className = "pf-stars";
    s.style.setProperty("--p", `${(r.a / 5) * 100}%`);
    s.setAttribute("aria-hidden", "true");
    const t = document.createElement("span");
    t.className = "pf-badge-count";
    t.textContent = `${r.c} review${r.c === 1 ? "" : "s"}`;
    wrap.append(s, t);
    wrap.setAttribute("aria-label", `Rated ${r.a.toFixed(1)} out of 5 from ${r.c} review${r.c === 1 ? "" : "s"}`);
    wrap.setAttribute("role", "img");
    // On the product page, the badge for this product jumps to the reviews section.
    const widget = document.getElementById("pf-reviews");
    if (widget && widget.dataset.productId === idOf(n) && !n.closest("a")) {
      wrap.classList.add("pf-badge--link");
      wrap.tabIndex = 0;
      wrap.setAttribute("role", "link");
      const go = () => widget.scrollIntoView({ behavior: "smooth", block: "start" });
      wrap.addEventListener("click", go);
      wrap.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go()));
    }
    n.replaceChildren(wrap);
  }

  let pending = false;
  async function run() {
    pending = false;
    const nodes = [...document.querySelectorAll(SEL)].filter((n) => !n.dataset.pfDone && /^\d+$/.test(idOf(n) || ""));
    if (!nodes.length) return;
    const need = [...new Set(nodes.map(idOf))].filter((id) => !cache.has(id));
    for (let i = 0; i < need.length; i += 100) {
      const ids = need.slice(i, i + 100);
      try {
        const res = await fetch(`/apps/proofly/ratings?ids=${ids.join(",")}`, { headers: { Accept: "application/json" } });
        const { ratings } = await res.json();
        ids.forEach((id) => cache.set(id, ratings[id] || null));
      } catch {
        return; // leave badges empty rather than show wrong data; next DOM change retries
      }
    }
    nodes.forEach(paint);
  }
  const schedule = () => { if (!pending) { pending = true; (window.requestIdleCallback || setTimeout)(run); } };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", schedule);
  else schedule();
  new MutationObserver((muts) => {
    if (muts.some((m) => [...m.addedNodes].some((x) => x.nodeType === 1 && (x.matches?.(SEL) || x.querySelector?.(SEL))))) schedule();
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
