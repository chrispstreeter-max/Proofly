import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LoaderFunctionArgs } from "react-router";
import { localDir } from "../lib/media.server";

// Serves PUBLIC review image derivatives when MEDIA_DRIVER=local (development). In production images are
// served by the public bucket/CDN and this route is disabled. Originals (private/) are never served.
export const loader = async ({ params }: LoaderFunctionArgs) => {
  if ((process.env.MEDIA_DRIVER || "local") !== "local") return new Response("Not found", { status: 404 });
  const base = path.join(localDir(), "public");
  const file = path.resolve(base, params["*"] ?? "");
  if (!file.startsWith(base + path.sep) || !file.endsWith(".webp")) return new Response("Not found", { status: 404 });
  const body = await readFile(file).catch(() => null);
  return body
    ? new Response(body, { headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000, immutable" } })
    : new Response("Not found", { status: 404 });
};
