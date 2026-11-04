/** Checksums + media sniffing, implemented with node:crypto only. */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export const CHECKSUM_ALGOS = ['sha256', 'sha1', 'md5', 'sha512'];

export async function hashFile(path, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Parse "sha256:abc…", "abc…32hex" or "md5=…" into { algorithm, value }. */
export function parseChecksum(input) {
  if (!input) return null;
  const trimmed = String(input).trim().toLowerCase();
  const withAlgo = /^([a-z0-9]+)[:=\s]([a-f0-9]+)$/.exec(trimmed);
  if (withAlgo) return { algorithm: withAlgo[1], value: withAlgo[2] };
  const byLength = { 32: 'md5', 40: 'sha1', 64: 'sha256', 128: 'sha512' };
  if (byLength[trimmed.length] && /^[a-f0-9]+$/.test(trimmed)) {
    return { algorithm: byLength[trimmed.length], value: trimmed };
  }
  return { algorithm: 'sha256', value: trimmed };
}

/** Magic-number table for the formats a download manager most often saves. */
const SIGNATURES = [
  { ext: 'png', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'jpg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { ext: 'gif', mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'pdf', mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  { ext: 'zip', mime: 'application/zip', magic: [0x50, 0x4b, 0x03, 0x04] },
  { ext: 'gz', mime: 'application/gzip', magic: [0x1f, 0x8b, 0x08] },
  { ext: 'webp', mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46], offset4: [0x57, 0x45, 0x42, 0x50] },
  { ext: 'mp4', mime: 'video/mp4', asciiAt4: 'ftyp' },
  { ext: 'mkv', mime: 'video/x-matroska', magic: [0x1a, 0x45, 0xdf, 0xa3] },
  { ext: 'ogg', mime: 'audio/ogg', magic: [0x4f, 0x67, 0x67, 0x53] },
  { ext: 'flac', mime: 'audio/flac', magic: [0x66, 0x4c, 0x61, 0x43] },
  { ext: 'mp3', mime: 'audio/mpeg', magic: [0x49, 0x44, 0x33] },
  { ext: '7z', mime: 'application/x-7z-compressed', magic: [0x37, 0x7a, 0xbc, 0xaf] },
  { ext: 'rar', mime: 'application/vnd.rar', magic: [0x52, 0x61, 0x72, 0x21] },
  { ext: 'exe', mime: 'application/vnd.microsoft.portable-executable', magic: [0x4d, 0x5a] },
  { ext: 'apk', mime: 'application/vnd.android.package-archive', magic: [0x50, 0x4b, 0x03, 0x04] },
];

/** Sniff a file header and return { ext, mime } or null. */
export function sniffFile(head) {
  if (!head || head.length < 4) return null;
  for (const sig of SIGNATURES) {
    const okMagic = sig.magic ? sig.magic.every((b, i) => head[i] === b) : true;
    const okTail = sig.offset4 ? sig.offset4.every((b, i) => head[4 + i] === b) : true;
    const okAscii = sig.asciiAt4 ? head.subarray(4, 8).toString('latin1') === sig.asciiAt4 : true;
    if (okMagic && okTail && okAscii) {
      if (sig.ext === 'zip' || sig.ext === 'apk') {
        // Both are ZIP; distinguish APK by the android manifest name in the archive.
        const text = head.subarray(0, Math.min(head.length, 4096)).toString('latin1');
        if (text.includes('AndroidManifest.xml') || text.includes('classes.dex')) {
          return { ext: 'apk', mime: 'application/vnd.android.package-archive' };
        }
        return { ext: 'zip', mime: 'application/zip' };
      }
      return { ext: sig.ext, mime: sig.mime };
    }
  }
  return null;
}
