import type { LoaderFunctionArgs } from "react-router";
import { parsePublicMediaName, readDerivative } from "../lib/media.server";
import { publicMediaKey } from "../lib/tenant.server";

// GET /media/<opaque-id>-320.webp | -1600.webp — public review photos.
// The URL carries only an opaque asset id: no shop, review or product identifier, and no way to choose a tenant.
// The resolver returns a storage key only while the photo is public (published media of a published, un-held review
// of a live product of an installed shop); every other case — unknown id, malformed name, internal key, original,
// hidden/pending/plan-limited review, storage-limited media — is the same 404.
const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const parsed = parsePublicMediaName(params["*"] ?? "");
  if (!parsed) return notFound();
  const key = await publicMediaKey(parsed.publicId, parsed.size);
  const body = key ? await readDerivative(key) : null;
  if (!body) return notFound();
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "image/webp",
      // ponytail: 1 h cache bounds how long a photo stays cached after it is hidden; put a CDN with purge in front
      // of /media if moderation needs faster takedown.
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
};
