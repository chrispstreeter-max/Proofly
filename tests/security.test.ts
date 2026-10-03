// Security probes (multi-tenant versions of the prototype's probes).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../app/db.server";
import { action as proxySubmit } from "../app/routes/proxy.reviews";
import { loader as proxyList } from "../app/routes/proxy.products.$id.reviews";
import { loader as media } from "../app/routes/media.$";
import { loader as devIndex } from "../app/routes/dev._index";
import { loader as devPreview } from "../app/routes/dev.preview";
import { loader as devProxy } from "../app/routes/apps.$";
import { args, DOMAIN_A, DOMAIN_B, installMerchant, owner, proxyRequest, resetDb, run, SAME_PRODUCT_ID, storefrontHost } from "./helpers";

before(async () => {
  await resetDb();
  await installMerchant(DOMAIN_A, "A");
  await installMerchant(DOMAIN_B, "B");
});
after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

const submit = (domain: string, label: string, fields: Record<string, string | Blob>, ip: string) => {
  const fd = new FormData();
  const base = { product_id: String(SAME_PRODUCT_ID), rating: "5", body: "Fictional body.", name: "Riley Example" };
  for (const [k, v] of Object.entries({ ...base, ...fields })) fd.set(k, v);
  return proxySubmit(args<ActionFunctionArgs>(proxyRequest(domain, "reviews", {}, { method: "POST", body: fd, headers: { Origin: `https://${storefrontHost(label)}`, "x-forwarded-for": ip } })));
};

test("honeypot, invalid rating and non-image uploads are rejected", async () => {
  assert.equal((await submit(DOMAIN_A, "A", { website: "spam" }, "203.0.113.1")).status, 400);
  assert.equal((await submit(DOMAIN_A, "A", { rating: "9" }, "203.0.113.1")).status, 400);
  const fake = new File([Buffer.from("not an image")], "x.jpg", { type: "image/jpeg" });
  assert.equal((await submit(DOMAIN_A, "A", { images: fake }, "203.0.113.1")).status, 400);
  assert.equal(await owner.review.count({ where: { source: "storefront" } }), 0);
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

test("media route rejects path traversal and private originals", async () => {
  for (const p of ["../.env", "s/x/originals/y/z.jpg", "..%2F..%2Fpackage.json", "x.txt"]) {
    const r = await run(() => media(args<LoaderFunctionArgs>(new Request(`http://localhost/media/${p}`), { "*": p })));
    assert.equal(r.response?.status, 404, p);
  }
});

test("dev-only routes are 404 outside development", async () => {
  for (const loader of [devIndex, devPreview, devProxy]) {
    const r = await run(() => loader(args<LoaderFunctionArgs>(new Request("http://localhost/dev"), { "*": "proofly/ratings" })));
    assert.equal(r.response?.status, 404);
  }
});
