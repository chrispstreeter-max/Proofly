import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, test } from "node:test";
import { Session } from "@shopify/shopify-api";
import { decryptSecret, encryptSecret, isEncrypted } from "../app/lib/crypto.server";
import { signProxyParams } from "../app/lib/devsign.server";
import { shopPrefix } from "../app/lib/storage.server";
import { parseIds } from "../app/lib/reviews.server";
import { isUuid } from "../app/lib/tenant.server";
import { sessionStorage } from "../app/shopify.server";
import { owner, resetDb } from "./helpers";

after(() => owner.$disconnect());

test("token encryption round-trips, is randomised and detects tampering", () => {
  const a = encryptSecret("fixture-access-token");
  const b = encryptSecret("fixture-access-token");
  assert.notEqual(a, b);
  assert.ok(isEncrypted(a));
  assert.equal(decryptSecret(a), "fixture-access-token");
  const raw = Buffer.from(a.slice("enc:v1:".length), "base64");
  raw[raw.length - 1] ^= 1;
  assert.throws(() => decryptSecret("enc:v1:" + raw.toString("base64")));
  assert.throws(() => decryptSecret("plaintext-token"), /unencrypted/);
});

test("Shopify sessions are stored with encrypted access tokens and loaded decrypted", async () => {
  await resetDb();
  await sessionStorage.storeSession(new Session({ id: "offline_x", shop: "proofly-test-a.myshopify.com", state: "", isOnline: false, accessToken: "fixture-secret-token" }));
  const row = await owner.session.findUniqueOrThrow({ where: { id: "offline_x" } });
  assert.ok(row.accessToken.startsWith("enc:v1:"));
  assert.ok(!row.accessToken.includes("fixture-secret-token"));
  assert.equal((await sessionStorage.loadSession("offline_x"))?.accessToken, "fixture-secret-token");
});

test("app-proxy signature changes when any signed parameter changes", () => {
  const a = signProxyParams(new URLSearchParams({ shop: "proofly-test-a.myshopify.com", timestamp: "1" }), "s").get("signature");
  const b = signProxyParams(new URLSearchParams({ shop: "proofly-test-b.myshopify.com", timestamp: "1" }), "s").get("signature");
  assert.notEqual(a, b);
});

test("dev proxy signer matches Shopify's verifier for keys with underscores and capitals", () => {
  const params = signProxyParams(new URLSearchParams({ shop: "proofly-test-a.myshopify.com", shop_id: "x", shopId: "y", Zeta: "1", alpha: "2", timestamp: "1" }), "s");
  // Recompute exactly as @shopify/shopify-api does for app proxies (localeCompare key order); the isolation suite
  // additionally verifies signed requests against the real library.
  const q = Object.fromEntries([...params].filter(([k]) => k !== "signature"));
  const msg = Object.entries(q).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("");
  assert.equal(params.get("signature"), createHmac("sha256", "s").update(msg).digest("hex"));
});

test("small helpers", () => {
  assert.deepEqual(parseIds("1,2,x,2,99999999999999999999999"), [1n, 2n]);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(shopPrefix("11111111-1111-1111-1111-111111111111"), "s/11111111-1111-1111-1111-111111111111");
});
