import { crc32, inflateRawSync } from "node:zlib";

/**
 * Minimal read-only ZIP reader for the importer's images archive (node:zlib only — no dependency).
 * Safety: entries are only ever READ BY NAME into memory (nothing is written to disk, so archive paths cannot
 * traverse anywhere); encrypted and ZIP64 entries are refused; every entry is inflated with a hard output limit
 * (zip-bomb safe) and its size and CRC-32 are verified.
 * ponytail: the archive is held in memory (≤ 2 GB import limit); switch to ranged reads from storage if that becomes a
 * memory problem.
 */
export interface ZipEntry { name: string; method: number; compressedSize: number; size: number; crc: number; localOffset: number }

export class ZipError extends Error {}

export function readZipDirectory(buf: Buffer): Map<string, ZipEntry> {
  // End of central directory: last 22 bytes + up to 64 KB comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("not a ZIP archive");
  const count = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");
  if (dirOffset + dirSize > eocd) throw new ZipError("corrupt central directory");
  const entries = new Map<string, ZipEntry>();
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("corrupt central directory entry");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // directory
    if (flags & 0x1) throw new ZipError(`encrypted entry: ${name.slice(0, 80)}`);
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("ZIP64 entries are not supported");
    entries.set(normaliseZipName(name), { name, method, compressedSize, size, crc, localOffset });
  }
  return entries;
}

/** Archive member names are compared by their normalised path ("folder/img.jpg"); "./" and "\" are folded. */
export const normaliseZipName = (name: string) => name.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");

/** Reads one entry, refusing anything larger than maxBytes (checked before and during inflation). */
export function readZipEntry(buf: Buffer, e: ZipEntry, maxBytes: number): Buffer {
  if (e.size > maxBytes) throw new ZipError("entry too large");
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new ZipError("corrupt local header");
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  if (start + e.compressedSize > buf.length) throw new ZipError("truncated entry");
  const raw = buf.subarray(start, start + e.compressedSize);
  let out: Buffer;
  if (e.method === 0) out = Buffer.from(raw);
  else if (e.method === 8) {
    try { out = inflateRawSync(raw, { maxOutputLength: maxBytes }); } catch { throw new ZipError("entry too large or corrupt"); }
  } else throw new ZipError(`unsupported compression method ${e.method}`);
  if (out.length !== e.size || (crc32(out) >>> 0) !== e.crc) throw new ZipError("entry failed integrity check");
  return out;
}
