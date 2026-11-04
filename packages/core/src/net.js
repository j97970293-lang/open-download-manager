/** Network primitives: capability probing and range streaming with retries. */

import { HttpError, NetworkError, RangeUnsupportedError, isRetryable } from './errors.js';
import { backoffDelay, filenameFromContentDisposition, filenameFromUrl, sleep } from './util.js';

export const DEFAULT_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 OpenDownloadManager/1.0',
  accept: '*/*',
  'accept-encoding': 'identity', // ranges + identity keep byte offsets honest
  'cache-control': 'no-cache',
};

export function mergeHeaders(...sets) {
  const out = { ...DEFAULT_HEADERS };
  for (const set of sets) {
    if (!set) continue;
    for (const [k, v] of Object.entries(set)) {
      if (v === undefined || v === null) continue;
      out[k.toLowerCase()] = v;
    }
  }
  return out;
}

/** Parse `Content-Range: bytes 0-1023/4096` into { start, end, total }. */
export function parseContentRange(value) {
  if (!value) return null;
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(value);
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
}

/**
 * Ask a server what it can do before downloading.
 * Uses HEAD first (cheap); falls back to a 1-byte ranged GET for servers that
 * reject HEAD or omit Content-Length. Never downloads the whole body.
 */
export async function probeUrl(url, { headers, signal, timeout = 20_000, redirect = 'follow' } = {}) {
  const baseHeaders = mergeHeaders(headers);
  const withTimeout = (signal) => {
    if (typeof AbortSignal.timeout !== 'function') return signal;
    const t = AbortSignal.timeout(timeout);
    return signal ? AbortSignal.any([signal, t]) : t;
  };

  const attempt = async (method) => {
    const requestHeaders = { ...baseHeaders };
    if (method === 'GET') requestHeaders.range = 'bytes=0-0';
    const res = await fetch(url, {
      method,
      headers: requestHeaders,
      redirect,
      signal: withTimeout(signal),
    });
    const contentRange = parseContentRange(res.headers.get('content-range'));
    let size = Number(res.headers.get('content-length')) || null;
    let acceptRanges = (res.headers.get('accept-ranges') || '').toLowerCase().includes('bytes');
    if (method === 'GET' && contentRange) {
      acceptRanges = true;
      size = contentRange.total ?? size;
    }
    if (method === 'GET' && res.status === 200) acceptRanges = false;
    if (method === 'GET' && res.body) await res.body.cancel().catch(() => {});
    return {
      status: res.status,
      finalUrl: res.url || url,
      size,
      acceptRanges,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      contentType: res.headers.get('content-type'),
      filename:
        filenameFromContentDisposition(res.headers.get('content-disposition')) ||
        filenameFromUrl(res.url || url),
      headers: Object.fromEntries(res.headers.entries()),
    };
  };

  let info;
  try {
    info = await attempt('HEAD');
  } catch (err) {
    if (signal?.aborted) throw err;
    info = null;
  }
  const needsGet =
    !info ||
    info.status === 405 ||
    info.status === 501 ||
    info.status === 403 ||
    !info.size ||
    info.size === 0;
  if (needsGet) {
    try {
      info = await attempt('GET');
    } catch (err) {
      if (signal?.aborted) throw err;
      if (!info) throw new NetworkError(`Cannot reach ${url}: ${err.message}`, { url });
    }
  }
  if (!info) throw new NetworkError(`Cannot probe ${url}`, { url });
  if (info.status >= 400) throw new HttpError(info.status, `Server answered ${info.status} for ${url}`);
  return info;
}

/**
 * Stream one byte range into an async iterator of Buffer chunks, with retry on
 * transient failures. Validates the server actually honoured the range.
 */
export async function* streamRange(url, { start, end, headers, signal, retries = 4, onRetry } = {}) {
  let attempt = 0;
  let cursor = start;
  for (;;) {
    attempt += 1;
    try {
      const requestHeaders = {
        ...mergeHeaders(headers),
        range: `bytes=${cursor}-${end}`,
      };
      const res = await fetch(url, { headers: requestHeaders, redirect: 'follow', signal });
      if (res.status === 416) throw new HttpError(416, `Range not satisfiable at ${cursor}`);
      if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} while reading ${cursor}-${end}`);
      const ranged = parseContentRange(res.headers.get('content-range'));
      if (res.status === 200 && cursor > 0) {
        throw new RangeUnsupportedError('Server ignored the Range header on resume');
      }
      if (ranged && ranged.start !== cursor) {
        throw new NetworkError(`Server returned range starting at ${ranged.start}, expected ${cursor}`);
      }
      if (!res.body) throw new NetworkError('Empty response body');
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk);
        if (!buf.length) continue;
        cursor += buf.length;
        yield buf;
        if (cursor > end) return;
      }
      if (cursor <= end) {
        // Connection closed early: treat as transient and resume from cursor.
        throw new NetworkError(`Stream ended at ${cursor}, expected ${end}`);
      }
      return;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (!isRetryable(err) || attempt > retries) throw err;
      const delay = backoffDelay(attempt);
      onRetry?.({ attempt, delay, error: err, cursor });
      await sleep(delay, signal);
    }
  }
}

/** HEAD-less size discovery for when only a GET is allowed. */
export async function headSize(url, opts = {}) {
  const info = await probeUrl(url, opts);
  return info.size;
}
