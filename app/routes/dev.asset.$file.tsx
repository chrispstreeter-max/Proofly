import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LoaderFunctionArgs } from "react-router";
import { isDev } from "../lib/devsign.server";

// DEV ONLY: serves theme-extension assets for /dev/preview.
const TYPES: Record<string, string> = { ".css": "text/css", ".js": "text/javascript" };

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const file = path.basename(params.file ?? "");
  if (!isDev() || !TYPES[path.extname(file)]) return new Response("Not found", { status: 404 });
  const body = await readFile(path.resolve("extensions/proofly/assets", file)).catch(() => null);
  return body
    ? new Response(body, { headers: { "Content-Type": `${TYPES[path.extname(file)]}; charset=utf-8`, "Cache-Control": "no-store" } })
    : new Response("Not found", { status: 404 });
};
