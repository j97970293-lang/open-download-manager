/** Small, dependency-free helpers shared by the core engine. */

const UNIT = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Human readable byte count, e.g. 1536 -> "1.5 KB". */
export function formatBytes(bytes, digits = 1) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNIT.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(digits)} ${UNIT[unit]}`;
}

/** Parse "10 MB", "512k", "1.5GiB" or a raw number into bytes. */
export function parseSize(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : 0;
  if (typeof input !== 'string') return 0;
  const match = /^\s*([\d.]+)\s*([kmgtp]?i?b?)?\s*$/i.exec(input);
  if (!match) return 0;
  const value = Number.parseFloat(match[1]);
  const suffix = (match[2] || '').toLowerCase().replace('ib', 'b');
  const power = { b: 0, k: 1, kb: 1, m: 2, mb: 2, g: 3, gb: 3, t: 4, tb: 4, p: 5, pb: 5 }[suffix] ?? 0;
  return Math.round(value * 1024 ** power);
}

/** "4821300" -> "00:01:20"; "3725000" -> "1:02:05". */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Zero-padded numeric seconds for filenames: 83 -> "01m23s". */
export function formatStamp(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}m${String(total % 60).padStart(2, '0')}s`;
}

export function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function abortError(signal) {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  err.code = 'ABORTED';
  err.retryable = true;
  if (signal?.reason) err.cause = signal.reason;
  return err;
}

/**
 * Full-jitter exponential backoff (AWS "Exponential Backoff and Jitter").
 * attempt is 1-based: attempt 1 -> [0, base], attempt 2 -> [0, 2*base] ...
 */
export function backoffDelay(attempt, { base = 500, cap = 30_000 } = {}) {
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(Math.random() * ceiling);
}

/** RFC 6266 / 5987 aware Content-Disposition filename extraction. */
export function filenameFromContentDisposition(header) {
  if (!header) return null;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    const charset = (extended[1] || 'utf-8').trim().toLowerCase();
    const raw = extended[2].trim().replace(/^"|"$/g, '');
    try {
      return charset === 'iso-8859-1'
        ? Buffer.from(unescape(raw), 'latin1').toString('utf8')
        : decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  const simple = /filename\s*=\s*("([^"]+)"|[^;]+)/i.exec(header);
  if (!simple) return null;
  return (simple[2] ?? simple[1]).trim();
}

const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * Cross-platform safe filename: strips path separators and control chars,
 * clamps to 180 bytes, keeps the extension, and guards Windows reserved names.
 */
export function sanitizeFilename(name, fallback = 'download.bin') {
  let base = String(name ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!base) base = fallback;
  const dot = base.lastIndexOf('.');
  let stem = dot > 0 ? base.slice(0, dot) : base;
  let ext = dot > 0 ? base.slice(dot) : '';
  if (WINDOWS_RESERVED.has(stem.toLowerCase())) stem = `_${stem}`;
  const maxBytes = 180 - Buffer.byteLength(ext);
  if (Buffer.byteLength(stem) > maxBytes) {
    stem = stem.slice(0, Math.max(1, maxBytes));
  }
  return `${stem}${ext}`;
}

/** Guess a filename from a URL, Content-Disposition, or the last path segment. */
export function filenameFromUrl(url, fallback = 'download.bin') {
  try {
    const { pathname } = new URL(url);
    const last = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
    return sanitizeFilename(last, fallback);
  } catch {
    return fallback;
  }
}

export function extOf(name) {
  const idx = String(name).lastIndexOf('.');
  return idx > 0 ? String(name).slice(idx + 1).toLowerCase() : '';
}

/** Simple deterministic id (time + randomness), sortable enough for a local app. */
export function makeId(prefix = 'dl') {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${t}${r}`;
}

/** Clamp helper used by the scheduler and rate limiter. */
export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** Split a size into n contiguous chunks: [[start,end], ...] inclusive. */
export function planRanges(total, parts) {
  const n = Math.max(1, Math.min(parts, total || 1));
  const base = Math.floor(total / n);
  const remainder = total % n;
  const ranges = [];
  let start = 0;
  for (let i = 0; i < n; i += 1) {
    const size = base + (i < remainder ? 1 : 0);
    if (size <= 0) continue;
    ranges.push([start, start + size - 1]);
    start += size;
  }
  return ranges;
}
