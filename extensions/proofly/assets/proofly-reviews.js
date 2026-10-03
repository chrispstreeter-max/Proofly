/* Proofly — Review Widget. No dependencies, no polling. Loads reviews through the store's own app proxy only when
   the widget nears the viewport and the product has reviews. Review data is only ever written with textContent /
   attributes (never innerHTML) so customer text cannot inject markup. */
(() => {
  const root = document.getElementById("pf-reviews");
  if (!root || root.dataset.ready) return;
  root.dataset.ready = "1";

  const API = root.dataset.api || "/apps/proofly";
  const productId = root.dataset.productId;
  const $ = (s) => root.querySelector(s);
  const list = $("[data-list]");
  const more = $("[data-more]");
  const state = { page: 1, sort: "recent", rating: 0, photos: false, summary: null, loading: false };
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
    const photos = $("[data-photos]");
    if (photos) photos.hidden = !sum.withPhotos;
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
    if (r.images.length) {
      const grid = el("div", "pf-photos");
      r.images.forEach((img, i) => {
        const b = el("button", "pf-photo");
        b.type = "button";
        b.dataset.large = img.large;
        if (img.w && img.h) b.dataset.ratio = `${img.w}x${img.h}`;
        b.setAttribute("aria-label", `Open photo ${i + 1} from ${r.name}`);
        const im = el("img");
        im.src = img.thumb;
        im.alt = "";
        im.loading = "lazy";
        im.decoding = "async";
        im.width = 96;
        im.height = 96;
        b.append(im);
        grid.append(b);
      });
      li.append(grid);
    }
    if (r.reply) {
      const rep = el("div", "pf-reply");
      rep.append(el("p", "pf-reply-h", `Response from ${root.dataset.shopName || "the store"}`), el("p", "pf-body", r.reply.body));
      li.append(rep);
    }
    return li;
  }

  async function load(reset) {
    if (state.loading) return;
    state.loading = true;
    list.setAttribute("aria-busy", "true");
    more.disabled = true;
    if (reset) state.page = 1;
    const q = new URLSearchParams({ page: String(state.page), sort: state.sort });
    if (state.rating) q.set("rating", String(state.rating));
    if (state.photos) q.set("photos", "1");
    if (!state.summary) q.set("summary", "1");
    try {
      const res = await fetch(`${API}/products/${productId}/reviews?${q}`, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
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
    const photos = $("[data-photos]");
    if (photos) photos.setAttribute("aria-pressed", String(state.photos));
    load(true);
  }

  root.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t || !root.contains(t)) return;
    if (t.matches(".pf-pill, .pf-bar")) setFilter({ rating: state.rating === Number(t.dataset.rating) && t.matches(".pf-bar") ? 0 : Number(t.dataset.rating) });
    else if (t.matches("[data-photos]")) setFilter({ photos: !state.photos });
    else if (t.matches("[data-more]")) { state.page += 1; load(false); }
    else if (t.matches("[data-retry]")) load(true);
    else if (t.matches(".pf-photo")) openLightbox(t.dataset.large, t.dataset.ratio);
    else if (t.matches("[data-write]")) openForm();
    else if (t.matches("[data-close]")) t.closest("dialog").close();
  });
  $("[data-sort]")?.addEventListener("change", (e) => setFilter({ sort: e.target.value }));

  // Lightbox
  const lightbox = $("[data-lightbox]");
  function openLightbox(src, ratio) {
    const img = lightbox.querySelector("[data-lightbox-img]");
    const [w, h] = (ratio || "1600x1600").split("x");
    img.width = Number(w);
    img.height = Number(h);
    img.src = src;
    lightbox.showModal();
  }
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
    const files = fd.getAll("images").filter((f) => f.size);
    if (files.length > 5) return void (form.querySelector('[data-err="images"]').textContent = "Add up to 5 photos.");
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Submitting…";
    try {
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

  // Fetch only when the section approaches the viewport.
  if (!list) return;
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) { io.disconnect(); load(true); }
    }, { rootMargin: "600px 0px" });
    io.observe(root);
  } else load(true);
})();
