import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// Review image storage.
//  - originals: byte-identical copy in PRIVATE storage (never served publicly; GPS EXIF stays private)
//  - thumb/large: re-encoded WebP in PUBLIC storage, EXIF stripped, immutable cache
// Driver "local" (dev) writes to MEDIA_LOCAL_DIR/{private,public}; "s3" works with any S3-compatible store.

export const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function sniffType(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

type Visibility = "private" | "public";

let s3: S3Client | null = null;
function s3Client() {
  s3 ??= new S3Client({
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION || "auto",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
    },
  });
  return s3;
}

async function put(visibility: Visibility, key: string, body: Buffer, contentType: string) {
  if ((process.env.MEDIA_DRIVER || "local") === "s3") {
    const Bucket = visibility === "public" ? process.env.S3_BUCKET_PUBLIC : process.env.S3_BUCKET_PRIVATE;
    await s3Client().send(
      new PutObjectCommand({
        Bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: visibility === "public" ? "public, max-age=31536000, immutable" : "private, no-store",
      }),
    );
    return;
  }
  const file = path.join(localDir(), visibility, key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
}

export function localDir() {
  return path.resolve(process.env.MEDIA_LOCAL_DIR || "./storage");
}

export function publicUrl(key: string) {
  return `${(process.env.MEDIA_PUBLIC_URL || "").replace(/\/$/, "")}/${key}`;
}

export interface StoredImage {
  storageKey: string;
  thumbKey: string;
  largeKey: string;
  contentType: string;
  fileSize: number;
  sha256: string;
  width: number | null;
  height: number | null;
}

/** Stores one review image. Keys are deterministic, so re-running is idempotent. */
export async function storeReviewImage(reviewId: string, original: Buffer): Promise<StoredImage> {
  const contentType = sniffType(original);
  if (!contentType) throw new Error("Unsupported image type");
  const hash = sha256(original);
  const storageKey = `originals/${reviewId}/${hash}.${ALLOWED_TYPES[contentType]}`;
  const base = `r/${reviewId}/${hash.slice(0, 16)}`;

  const img = sharp(original, { failOn: "error" }).rotate(); // apply EXIF orientation, then metadata is dropped
  const meta = await img.metadata();
  const [thumb, large] = await Promise.all([
    img.clone().resize({ width: 320, height: 320, fit: "cover" }).webp({ quality: 76 }).toBuffer(),
    img.clone().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(),
  ]);

  await put("private", storageKey, original, contentType);
  await put("public", `${base}-320.webp`, thumb, "image/webp");
  await put("public", `${base}-1600.webp`, large, "image/webp");

  // EXIF orientations 5–8 swap width/height.
  const swap = (meta.orientation ?? 1) >= 5;
  return {
    storageKey,
    thumbKey: `${base}-320.webp`,
    largeKey: `${base}-1600.webp`,
    contentType,
    fileSize: original.length,
    sha256: hash,
    width: (swap ? meta.height : meta.width) ?? null,
    height: (swap ? meta.width : meta.height) ?? null,
  };
}
