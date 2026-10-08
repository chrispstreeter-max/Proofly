/* eslint-env node */
// Production server: react-router-serve's setup (gzip, asset caching) with one change — request logs show the path
// only. Shopify puts id_token, hmac, session and signature in the query string, and they must not reach the host's logs.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";
import morgan from "morgan";

morgan.token("path", (req) => (req.originalUrl ?? req.url).split("?")[0]);
// morgan "tiny" with :path in place of :url.
const tiny = morgan.compile(":method :path :status :res[content-length] - :response-time ms");
export const logLine = (req, res) => tiny(morgan, req, res);

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.env.NODE_ENV ??= "production";
  const build = await import(pathToFileURL(path.resolve("build/server/index.js")).href);
  const app = express();
  app.disable("x-powered-by");
  app.use(compression());
  app.use(path.posix.join(build.publicPath, "assets"), express.static(path.join(build.assetsBuildDirectory, "assets"), { immutable: true, maxAge: "1y" }));
  app.use(build.publicPath, express.static(build.assetsBuildDirectory));
  app.use(express.static("public", { maxAge: "1h" }));
  app.use(morgan((_tokens, req, res) => logLine(req, res)));
  app.all("*", createRequestHandler({ build, mode: process.env.NODE_ENV }));
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, process.env.HOST, () => console.log(`[proofly] http://localhost:${port}`));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close(console.error));
}
