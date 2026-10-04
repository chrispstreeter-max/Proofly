/* Proofly — Review Widget. No dependencies, no polling. Renders from the storefront projection Shopify served with
   the page (data-initial); anything beyond it loads through the store's own app proxy. Review data is only ever written with textContent /
   attributes (never innerHTML) so customer text cannot inject markup. */
(() => {
  const root = document.getElementById("pf-reviews");
  if (!root || root.dataset.ready) return;
  root.dataset.ready = "1";

  const API = root.dataset.api; // the merchant's configured app proxy path (empty → no requests)
  const productId = root.dataset.productId;
  const $ = (s) => root.querySelector(s);
  const list = $("[data-list]");
  const more = $("[data-more]");
  const state = { page: 1, sort: "recent", rating: 0, summary: null, loading: false };
  const PAGE = 10; // the proxy's page size
  let initial = null; // { summary, complete, reviews (newest first) } — published by Proofly on the product
  try { initial = JSON.parse(root.dataset.initial || "null"); } catch { /* ignore: the proxy serves everything */ }
  if (!initial || !Array.isArray(initial.reviews) || !initial.summary) initial = null;
  const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const stars = (rating, cls = "") => {
    const s = el("span", `pf-stars ${cls}`);
    s.style.setProperty("--p", `${(rating / 5) * 100}%`);
    s.setAttribute("role", "img");
    s.setAttribute("aria-label", `Rated ${rating} out of 5`);
    return s;
  };

  function renderSummary(sum) {
    const total = sum.count || 0;
    root.querySelectorAll("[data-bars] .pf-bar").forEach((b) => {
      const n = Number(b.dataset.rating);
      const c = sum.distribution[n - 1] || 0;
      const pct = total ? Math.round((c / total) * 100) : 0;
      b.querySelector(".pf-bar-fill").style.width = `${pct}%`;
      b.querySelector(".pf-bar-pct").textContent = `${pct}%`;
      b.disabled = c === 0;
      b.setAttribute("aria-label", `${n} star: ${c} review${c === 1 ? "" : "s"}, ${pct}%`);
    });
    const filters = $("[data-filters]");
    filters.replaceChildren();
    const pill = (label, rating) => {
      const b = el("button", "pf-pill", label);
      b.type = "button";
      b.dataset.rating = String(rating);
      b.setAttribute("aria-pressed", String(state.rating === rating));
      return b;
    };
    filters.append(pill(`All Reviews (${total})`, 0));
    for (let n = 5; n >= 1; n--) filters.append(pill(`${n} ★ (${sum.distribution[n - 1] || 0})`, n));
  }

  function renderReview(r) {
    const li = el("li", "pf-review");
    const head = el("div", "pf-review-head");
    head.append(el("span", "pf-avatar", (r.name.trim()[0] || "?").toUpperCase()));
    const who = el("div", "pf-who");
    const nameRow = el("div", "pf-name-row");
    nameRow.append(el("span", "pf-name", r.name));
    if (r.verified) {
      const v = el("span", "pf-verified", "Verified Purchase");
      v.prepend(el("span", "pf-check"));
      nameRow.append(v);
    }
    who.append(nameRow, stars(r.rating));
    const time = el("time", "pf-date", dateFmt.format(new Date(`${r.date}T00:00:00Z`)));
    time.dateTime = r.date;
    head.append(who, time);
    li.append(head);
    if (r.title) li.append(el("h3", "pf-title", r.title));
    li.append(el("p", "pf-body", r.body));
    if (r.reply) {
      const rep = el("div", "pf-reply");
      rep.append(el("p", "pf-reply-h", `Response from ${root.dataset.shopName || "the store"}`), el("p", "pf-body", r.reply.body));
      li.append(rep);
    }
    return li;
  }

  // The projection answers when it holds every review, or for newest-first pages it covers; otherwise the proxy.
  function fromProjection() {
    if (!initial || !(initial.complete || (state.sort === "recent" && !state.rating && state.page * PAGE <= initial.reviews.length))) return null;
    let rows = initial.reviews.map((r, i) => [r, i]);
    if (state.rating) rows = rows.filter(([r]) => r.rating === state.rating);
    const dir = state.sort === "highest" ? -1 : state.sort === "lowest" ? 1 : 0;
    if (dir) rows.sort((a, b) => dir * (a[0].rating - b[0].rating) || a[1] - b[1]); // ties: newest first, as the proxy
    const end = state.page * PAGE;
    return { reviews: rows.slice(end - PAGE, end).map(([r]) => r), hasMore: rows.length > end || !initial.complete };
  }

  async function load(reset) {
    if (state.loading) return;
    state.loading = true;
    list.setAttribute("aria-busy", "true");
    more.disabled = true;
    if (reset) state.page = 1;
    const q = new URLSearchParams({ page: String(state.page), sort: state.sort });
    if (state.rating) q.set("rating", String(state.rating));
    if (!state.summary) q.set("summary", "1");
    try {
      let data = fromProjection();
      if (!data) {
        if (!API) throw new Error("no proxy path");
        const res = await fetch(`${API}/products/${productId}/reviews?${q}`, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(String(res.status));
        data = await res.json();
      }
      if (data.summary) renderSummary((state.summary = data.summary));
      if (reset) list.replaceChildren();
      data.reviews.forEach((r) => list.append(renderReview(r)));
      if (!list.children.length) list.append(el("li", "pf-empty", "No reviews match this filter yet."));
      more.hidden = !data.hasMore;
    } catch {
      // The summary above is server-rendered and stays; only the list reports the problem.
      if (reset) {
        const li = el("li", "pf-empty", "Reviews couldn't be loaded right now. ");
        const retry = el("button", "pf-link", "Try again");
        retry.type = "button";
        retry.dataset.retry = "";
        li.append(retry);
        list.replaceChildren(li);
      }
    } finally {
      state.loading = false;
      more.disabled = false;
      list.setAttribute("aria-busy", "false");
    }
  }

  function setFilter(patch) {
    Object.assign(state, patch);
    root.querySelectorAll(".pf-pill").forEach((p) => p.setAttribute("aria-pressed", String(Number(p.dataset.rating) === state.rating)));
    root.querySelectorAll(".pf-bar").forEach((b) => b.classList.toggle("is-active", Number(b.dataset.rating) === state.rating));
    load(true);
  }

  root.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t || !root.contains(t)) return;
    if (t.matches(".pf-pill, .pf-bar")) setFilter({ rating: state.rating === Number(t.dataset.rating) && t.matches(".pf-bar") ? 0 : Number(t.dataset.rating) });
    else if (t.matches("[data-more]")) { state.page += 1; load(false); }
    else if (t.matches("[data-retry]")) load(true);
    else if (t.matches("[data-write]")) openForm();
    else if (t.matches("[data-close]")) t.closest("dialog").close();
  });
  $("[data-sort]")?.addEventListener("change", (e) => setFilter({ sort: e.target.value }));

  root.querySelectorAll("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));

  // Write a review
  const dialog = $("[data-form-dialog]");
  const form = $("[data-form]");
  const thanks = $("[data-thanks]");
  function openForm() {
    if (!dialog) return;
    form.hidden = false;
    thanks.hidden = true;
    dialog.showModal();
  }
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    form.querySelectorAll("[data-err]").forEach((n) => (n.textContent = ""));
    const fd = new FormData(form);
    if (!fd.get("rating")) return void (form.querySelector('[data-err="rating"]').textContent = "Choose a star rating.");
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Submitting…";
    try {
      if (!API) throw new Error("no proxy path");
      const res = await fetch(`${API}/reviews`, { method: "POST", body: fd, headers: { Accept: "application/json" } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        const target = form.querySelector(`[data-err="${data.field || "form"}"]`) || form.querySelector('[data-err="form"]');
        target.textContent = data.error || "Something went wrong. Please try again.";
        return;
      }
      form.reset();
      form.hidden = true;
      thanks.hidden = false;
    } catch {
      form.querySelector('[data-err="form"]').textContent = "Network error. Please try again.";
    } finally {
      btn.disabled = false;
      btn.textContent = "Submit review";
    }
  });

  if (!list) return;
  // Projection served with the page: render now, no request.
  if (initial) { renderSummary((state.summary = initial.summary)); load(true); return; }
  // Otherwise fetch only when the section approaches the viewport.
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) { io.disconnect(); load(true); }
    }, { rootMargin: "600px 0px" });
    io.observe(root);
  } else load(true);
})();
