// Checkpoint 10: production readiness — startup environment checks, health check, container contents, stalled-import
// recovery in the UI, and no unreleased feature shown in the admin. Offline; network guard.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import prisma from "../app/db.server";
import { getImport } from "../app/lib/import.server";
import { withTenant } from "../app/lib/tenant.server";
import { loader as health } from "../app/routes/healthz";
import { envProblems } from "../app/shopify.server";
import { installMerchant, owner, resetDb, type Merchant } from "./helpers";

let A: Merchant;
before(async () => { await resetDb(); A = await installMerchant("proofly-test-ra.myshopify.com", "RA"); });
after(async () => { await prisma.$disconnect(); await owner.$disconnect(); });

const PROD = {
  NODE_ENV: "production", SHOPIFY_API_KEY: "k", SHOPIFY_API_SECRET: "s", SHOPIFY_APP_URL: "https://app.example.com", SCOPES: "read_products",
  TOKEN_ENCRYPTION_KEY: "x", DATABASE_URL: "postgresql://a", IP_HASH_SALT: "s".repeat(32), SHOPIFY_APP_HANDLE: "proofly",
};

test("production refuses to start without its database, a real salt and https; no file storage is needed", () => {
  assert.deepEqual(envProblems(PROD), []);
  assert.deepEqual(envProblems({ ...PROD, NODE_ENV: "development", IP_HASH_SALT: "" }), []);
  const bad = envProblems({ ...PROD, DATABASE_URL: "", IP_HASH_SALT: "short", SHOPIFY_APP_URL: "http://app.example.com", SHOPIFY_API_SECRET: "" });
  for (const p of ["missing SHOPIFY_API_SECRET", "missing DATABASE_URL",
    "IP_HASH_SALT must be at least 32 characters", "SHOPIFY_APP_URL must be https"]) assert.ok(bad.includes(p), p);
  // Phase 4: Proofly has no S3/R2 or other file storage (import CSVs live in the database).
  assert.equal(JSON.parse(readFileSync("package.json", "utf8")).dependencies["@aws-sdk/client-s3"], undefined);
});

test("health check: up/down only, never cached", async () => {
  const res = await health();
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("container image: no secrets, local data, fixtures or tests; runs as a non-root user", () => {
  const ignore = readFileSync(".dockerignore", "utf8").split("\n");
  for (const p of [".env", ".env.*", ".pgdata", "storage", "storage-test", "fixtures", "tests", ".git"]) assert.ok(ignore.includes(p), p);
  const docker = readFileSync("Dockerfile", "utf8");
  const runtime = docker.slice(docker.lastIndexOf("FROM "));
  assert.doesNotMatch(runtime, /COPY \. \./);
  assert.match(runtime, /npm ci --omit=dev/);
  assert.match(runtime, /^USER node$/m);
  // The non-root user can't write node_modules (owned by root): the Prisma client is generated at build time, and the
  // start command only migrates and serves (regenerating at start would fail with EACCES).
  assert.match(runtime, /RUN npx prisma generate/);
  const start = JSON.parse(readFileSync("package.json", "utf8")).scripts["docker-start"] as string;
  assert.doesNotMatch(start, /prisma generate|npm run setup/);
  assert.match(start, /prisma migrate deploy/);
});

test("an import whose worker stopped can be resumed straight away (before maintenance runs)", async () => {
  const job = await withTenant(A.shopId, ({ db, shopId }) => db.importJob.create({ data: { shopId, source: "csv", status: "running", heartbeatAt: new Date(Date.now() - 3_600_000) } }));
  assert.equal((await getImport(A.shopId, job.id))!.stalled, true);
  await owner.importJob.update({ where: { id: job.id }, data: { heartbeatAt: new Date() } });
  assert.equal((await getImport(A.shopId, job.id))!.stalled, false);
});

test("the admin never shows an unreleased feature (verified purchases ship in V1.1)", () => {
  for (const f of ["app/routes/app._index.tsx", "app/routes/app.reviews._index.tsx"]) assert.doesNotMatch(readFileSync(f, "utf8"), /Verified purchase/, f);
});
