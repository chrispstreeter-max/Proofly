// Security probes (multi-tenant versions of the prototype's probes).
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { after, before, test } from "node:test";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import { action as proxySubmit } from "../app/routes/proxy.reviews";
import { loader as proxyList } from "../app/routes/proxy.products.$id.reviews";
import { args, DOMAIN_A, DOMAIN_B, installMerchant, owner, proxyRequest, resetDb, reviewsIn, SAME_PRODUCT_ID, storefrontHost, storeOf, type Merchant } from "./helpers";

let A: Merchant;
before(async () => {
  await resetDb();
  A = await installMerchant(DOMAIN_A, "A");
  await installMerchant(DOMAIN_B, "B");
});
after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

const submit = (domain: string, label: string, fields: Record<string, string | Blob>, ip: string) => {
  const fd = new FormData();
  const base = { product_id: String(SAME_PRODUCT_ID), rating: "5", body: "Fictional body.", name: "Riley Example" };
  for (const [k, v] of Object.entries({ ...base, ...fields })) fd.set(k, v);
  return proxySubmit(args<ActionFunctionArgs>(proxyRequest(domain, "reviews", {}, { method: "POST", body: fd, headers: { Origin: `https://${storefrontHost(label)}`, "x-forwarded-for": ip } })));
};

test("honeypot and invalid rating are rejected", async () => {
  assert.equal((await submit(DOMAIN_A, "A", { website: "spam" }, "203.0.113.1")).status, 400);
  assert.equal((await submit(DOMAIN_A, "A", { rating: "9" }, "203.0.113.1")).status, 400);
  assert.equal((await reviewsIn(A.api)).filter((r) => r.source === "storefront").length, 0);
});

// Product decision (2026-10-04): no review photos anywhere.
test("photos can't be submitted: oversized requests are refused, a file field is ignored and nothing is stored", async () => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ product_id: String(SAME_PRODUCT_ID), rating: "5", body: "Photo probe.", name: "Riley Example" })) fd.set(k, v);
  fd.set("images", new File([Buffer.alloc(70 * 1024, 1)], "x.jpg", { type: "image/jpeg" }));
  const big = await proxySubmit(args<ActionFunctionArgs>(proxyRequest(DOMAIN_A, "reviews", {}, { method: "POST", body: fd, headers: { Origin: `https://${storefrontHost("A")}`, "x-forwarded-for": "203.0.113.9", "content-length": String(80 * 1024) } })));
  assert.equal(big.status, 413);
  const small = await submit(DOMAIN_A, "A", { body: "Photo probe 2.", images: new File([Buffer.from([0xff, 0xd8, 0xff, 0])], "x.jpg", { type: "image/jpeg" }) }, "203.0.113.9");
  assert.equal(small.status, 201);
  const stored = (await reviewsIn(A.api)).filter((r) => r.body === "Photo probe 2.");
  assert.equal(stored.length, 1);
  const raw = storeOf(DOMAIN_A).metaobjects.get(stored[0].id)!;
  assert.deepEqual([...raw.fields.keys()].filter((k) => /photo|image|media|file/i.test(k)), []); // nothing photo-like in the entry
  const cols = await owner.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND ((column_name ~ '(photo|image|media)' AND table_name <> 'products') OR table_name = 'review_images')`);
  assert.equal(cols[0].n, 0n);
});

test("rate limits are per shop: exhausting shop A does not block shop B", async () => {
  const ip = "203.0.113.50";
  for (let i = 0; i < 5; i++) assert.equal((await submit(DOMAIN_A, "A", { body: `Rate test ${i}.` }, ip)).status, 201);
  assert.equal((await submit(DOMAIN_A, "A", { body: "Rate test 6." }, ip)).status, 429);
  assert.equal((await submit(DOMAIN_B, "B", { body: "Rate test B." }, ip)).status, 201);
});

test("public review JSON contains no private fields", async () => {
  const res = await proxyList(args<LoaderFunctionArgs>(proxyRequest(DOMAIN_A, `products/${SAME_PRODUCT_ID}/reviews`, { summary: "1" }), { id: String(SAME_PRODUCT_ID) }));
  const text = await res.text();
  for (const k of ["email", "reviewerEmail", "shopifyCustomerId", "shopifyOrderId", "submitterIpHash", "shopId", "shop_id"]) assert.ok(!text.includes(k), k);
});

test("there is no public file or media route: nothing Proofly stores is ever served", () => {
  assert.equal(existsSync("app/routes/media.$.tsx"), false);
  assert.deepEqual(readdirSync("app/routes").filter((f) => /media|upload|file|asset/i.test(f) && !f.startsWith("dev.")), []);
});

