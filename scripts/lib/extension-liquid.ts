/**
 * Renders the theme app extension's Liquid outside Shopify (tests only; liquidjs is a
 * devDependency). liquidjs implements the Liquid language; the handful of Shopify-only filters the blocks use are
 * registered below, and strictFilters makes any other Shopify-only filter fail loudly instead of rendering blank.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Liquid, Tag, type TagToken, type TopLevelToken } from "liquidjs";
import { DEFAULT_PROXY_PATH } from "../../app/lib/proxy-path.server";

export const EXTENSION_DIR = path.resolve("extensions/proofly");

class SchemaTag extends Tag { // {% schema %}…{% endschema %} renders nothing
  constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
    super(token, remain, liquid);
    while (remain.length) if ((remain.shift() as TagToken).name === "endschema") return;
  }
  *render() {}
}

const engine = new Liquid({ strictFilters: true });
engine.registerTag("schema", SchemaTag);
engine.registerFilter("image_url", (v: string) => String(v ?? "").replace(/^https?:/, "")); // Shopify: protocol-relative

export const blockSource = (name: string) => readFileSync(path.join(EXTENSION_DIR, "blocks", `${name}.liquid`), "utf8");

export function blockSchema(name: string) {
  const m = /{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/.exec(blockSource(name));
  if (!m) throw new Error(`${name}: no {% schema %}`);
  return JSON.parse(m[1]) as { name: string; target: string; javascript?: string; stylesheet?: string; settings: { id?: string; type: string; default?: unknown }[]; enabled_on?: unknown };
}

/** Default block settings from the schema, overridable per render. */
export const defaults = (name: string) =>
  Object.fromEntries(blockSchema(name).settings.filter((s) => s.id).map((s) => [s.id, s.default ?? (s.type === "checkbox" ? false : "")]));

/** A storefront product as Shopify's Liquid exposes it, with the standard rating metafields Proofly keeps in sync. */
export function liquidProduct(p: { id: string | number | bigint; handle: string; title: string; average: number; count: number }) {
  return {
    id: String(p.id), handle: p.handle, title: p.title, url: `/products/${p.handle}`, featured_image: null, object_type: "product",
    metafields: { reviews: { rating_count: { value: p.count }, rating: { value: p.count > 0 ? { rating: p.average, scale_min: 1, scale_max: 5 } : null } } },
  };
}

export function renderBlock(name: string, ctx: Record<string, unknown>, settings: Record<string, unknown> = {}) {
  return engine.parseAndRender(blockSource(name), {
    shop: { name: "Example Store" }, routes: { root_url: "/" }, request: { origin: "https://example.myshopify.com" }, customer: null,
    // The app-data metafield Proofly publishes per merchant (pass `app: null` to render without it).
    app: { metafields: { proofly: { proxy_path: { value: DEFAULT_PROXY_PATH } } } },
    ...ctx,
    block: { settings: { ...defaults(name), ...settings }, shopify_attributes: "" },
  });
}
