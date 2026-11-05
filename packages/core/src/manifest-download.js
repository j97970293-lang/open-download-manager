/**
 * Manifest downloader: turn an HLS media playlist (or a DASH segment list) into
 * ONE file on disk, in order, with resume.
 *
 * Design
 *  - Segments are appended sequentially (playlists are ordered by definition).
 *  - Progress is persisted as (segment index, byte offset inside that segment)
 *    so a crash resumes mid-segment instead of restarting it — the same
 *    guarantee the range-based engine gives for single files.
 *  - Concurrency is deliberately 1 for the byte-exact path: MPEG-TS/CMAF parts
 *    must be concatenated in order. A `--parallel` mode fetches ahead into
 *    memory-bounded buffers while keeping write order, for throughput.
 *  - No remuxing: MPEG-TS parts concatenate into a valid .ts; CMAF/fMP4 parts
 *    concatenate into a valid fMP4 when the init segment is included.
 */

import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { resolveManifest } from './media.js';
import { RateLimiter } from './rate.js';
import { backoffDelay, formatBytes, makeId, sleep } from './util.js';
import { HttpError, NetworkError, isRetryable } from './errors.js';

function abortError(signal) {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  err.code = 'ABORTED';
  err.retryable = true;
  if (signal?.reason) err.cause = signal.reason;
  return err;
}

export const MANIFEST_STATUS = Object.freeze({
  QUEUED: 'queued',
  CONNECTING: 'connecting',
  DOWNLOADING: 'downloading',
  PAUSED: 'paused',
  COMPLETE: 'complete',
  ERROR: 'error',
});

export class ManifestDownload extends EventEmitter {
  constructor(options = {}) {
    super();
    const {
      url,
      dir = process.cwd(),
      filename,
      headers = {},
      maxHeight = Infinity,
      prefer = 'best',
      parallel = 1,
      limit = 0,
      store = null,
      now = () => Date.now(),
    } = options;
    this.id = options.id || makeId('mf');
    this.url = url;
    this.dir = dir;
    this.expectedName = filename;
    this.headers = headers;
    this.maxHeight = maxHeight;
    this.prefer = prefer;
    this.parallel = Math.max(1, Math.min(8, parallel));
    this.limit = new RateLimiter(limit);
    this.store = store;
    this.now = now;

    this.manifest = null;
    this.playlistUrl = null;
    this.segments = options.segments?.length ? options.segments : [];
    this.filename = filename || null;
    this.path = filename ? join(dir, filename) : null;
    this.resumeIndex = options.resumeIndex ?? 0;
    this.resumeOffset = options.resumeOffset ?? 0;
    this.bytesWritten = options.bytesWritten ?? 0;
    this.completedSegments = options.completedSegments ?? 0;
    this.status = options.status === MANIFEST_STATUS.COMPLETE ? MANIFEST_STATUS.COMPLETE : MANIFEST_STATUS.QUEUED;
    this.error = options.error ?? null;
    this.createdAt = options.createdAt ?? this.now();
    this.completedAt = options.completedAt ?? null;
    this.controller = null;
    this.runPromise = null;
    this.speedWindow = [];
  }

  get total() {
    return this.segments.length;
  }

  get progress() {
    if (this.status === MANIFEST_STATUS.COMPLETE) return 1;
    if (!this.total) return 0;
    const partial = this.resumeIndex >= this.total ? 1 : 0;
    return Math.min(1, (this.completedSegments + partial) / this.total);
  }

  speed() {
    const now = this.now();
    const w = this.speedWindow.filter((s) => now - s.t <= 1000);
    if (w.length < 2) return 0;
    const dt = (w.at(-1).t - w[0].t) / 1000;
    return dt > 0 ? Math.max(0, (w.at(-1).bytes - w[0].bytes) / dt) : 0;
  }

  snapshot() {
    return {
      id: this.id,
      kind: 'manifest',
      url: this.url,
      playlistUrl: this.playlistUrl,
      filename: this.filename,
      path: this.path,
      dir: this.dir,
      status: this.status,
      segments: this.total,
      completedSegments: this.completedSegments,
      progress: this.progress,
      bytesWritten: this.bytesWritten,
      speed: this.status === MANIFEST_STATUS.DOWNLOADING ? Math.round(this.speed()) : 0,
      error: this.error,
      createdAt: this.createdAt,
      completedAt: this.completedAt,
    };
  }

  toJSON() {
    return { ...this.snapshot(), headers: this.headers, resumeIndex: this.resumeIndex, resumeOffset: this.resumeOffset };
  }

  #setStatus(status, extra = {}) {
    this.status = status;
    Object.assign(this, extra);
    this.emit('status', status, this.snapshot());
    this.store?.save?.(this)?.catch?.(() => {});
  }

  #emit(force = false) {
    const t = this.now();
    if (!force && t - (this.lastEmit ?? 0) < 200) return;
    this.lastEmit = t;
    this.emit('progress', this.snapshot());
  }

  #sample() {
    this.speedWindow.push({ t: this.now(), bytes: this.bytesWritten });
    if (this.speedWindow.length > 12) this.speedWindow.shift();
  }

  /** Resolve the playlist: master → best variant → media segment list (HLS or DASH). */
  async #resolveManifest(signal) {
    const first = await resolveManifest(this.url, { headers: this.headers, signal });
    let manifest = first;
    if (first.kind === 'dash') {
      if (first.drm) {
        throw new NetworkError('DRM-protected DASH manifest — refusing to download protected content');
      }
      const { planDash } = await import('./dash.js');
      const plan = planDash(first.text, first.manifestUrl || this.url, {
        maxHeight: this.maxHeight,
        prefer: this.prefer,
      });
      this.playlistUrl = first.manifestUrl || this.url;
      this.manifest = { kind: 'dash', ...plan };
      this.segments = plan.segments.map((s, i) => ({ index: i, url: s.url, init: s.init || null }));
      if (!this.filename) {
        const base = (() => {
          try {
            const last = new URL(this.playlistUrl).pathname.split('/').filter(Boolean).pop() || 'stream';
            return last.replace(/\.mpd$/i, '') || 'stream';
          } catch {
            return 'stream';
          }
        })();
        const ext = /\.ts(\?|$)/i.test(this.segments[0]?.url || '') ? 'ts' : 'mp4';
        this.filename = `${base}.${ext}`;
        this.path = join(this.dir, this.filename);
      }
      return this.manifest;
    }
    if (first.kind === 'hls' && first.type === 'master') {
      const { pickVariant } = await import('./media.js');
      const variant = pickVariant(first.variants, { maxHeight: this.maxHeight, prefer: this.prefer });
      if (!variant?.url) throw new NetworkError('No playable variant in this master playlist');
      this.playlistUrl = variant.url;
      manifest = await resolveManifest(variant.url, { headers: this.headers, signal });
    } else {
      this.playlistUrl = first.manifestUrl || this.url;
    }
    if (manifest.kind !== 'hls' || manifest.type !== 'media' || !manifest.segments?.length) {
      throw new NetworkError('This manifest does not expose a segment list this downloader can concatenate');
    }
    if (manifest.encrypted) {
      throw new NetworkError('Encrypted playlist (DRM or AES-128) — refusing to download protected content');
    }
    this.manifest = manifest;
    this.segments = manifest.segments.filter((s) => s.url).map((s, i) => ({ index: i, url: s.url, init: s.init || null }));
    if (!this.filename) {
      const base = (() => {
        try {
          const u = new URL(this.playlistUrl);
          const last = u.pathname.split('/').filter(Boolean).pop() || 'stream';
          return last.replace(/\.m3u8$/i, '') || 'stream';
        } catch {
          return 'stream';
        }
      })();
      // TS parts concatenate to .ts; fMP4/CMAF parts (init segment present) to .mp4.
      const ext = this.segments.some((s) => s.init) || /\.m4s(\?|$)/i.test(this.segments[0]?.url || '') ? 'mp4' : 'ts';
      this.filename = `${base}.${ext}`;
      this.path = join(this.dir, this.filename);
    }
    return manifest;
  }

  async start() {
    if (this.runPromise) return this.runPromise;
    if (this.status === MANIFEST_STATUS.COMPLETE) return this.snapshot();
    this.controller = new AbortController();
    this.runPromise = this.#run(this.controller.signal).finally(() => {
      this.runPromise = null;
      this.controller = null;
      this.emit('progress', this.snapshot());
    });
    return this.runPromise;
  }

  async #run(signal) {
    this.#setStatus(MANIFEST_STATUS.CONNECTING);
    try {
      if (!this.segments.length) await this.#resolveManifest(signal);
      await mkdir(dirname(this.path), { recursive: true });
      this.#setStatus(MANIFEST_STATUS.DOWNLOADING);

      const fh = await open(this.path, this.resumeIndex === 0 && this.resumeOffset === 0 ? 'w' : 'r+');
      try {
        if (this.resumeIndex === 0 && this.resumeOffset === 0) await fh.truncate(0);
        await this.#writeLoop(fh, signal);
      } finally {
        await fh.sync().catch(() => {});
        await fh.close();
      }

      this.completedAt = this.now();
      this.#setStatus(MANIFEST_STATUS.COMPLETE);
      this.emit('done', this.snapshot());
      return this.snapshot();
    } catch (err) {
      if (signal.aborted) {
        this.#setStatus(MANIFEST_STATUS.PAUSED);
        this.emit('paused', this.snapshot());
        return this.snapshot();
      }
      this.error = { message: err.message, code: err.code ?? 'ERROR', retryable: err.retryable ?? isRetryable(err) };
      this.#setStatus(MANIFEST_STATUS.ERROR, { error: this.error });
      this.emit('failed', this.error, this.snapshot());
      return this.snapshot();
    }
  }

  async #writeLoop(fh, signal) {
    const queue = [];
    let nextToFetch = this.resumeIndex;
    let nextToWrite = this.resumeIndex;
    const maxAhead = this.parallel;

    const fill = async () => {
      while (queue.length < maxAhead && nextToFetch < this.total) {
        const index = nextToFetch;
        nextToFetch += 1;
        const promise = this.#fetchSegment(this.segments[index], signal).then((buf) => ({ index, buf }));
        queue.push(promise);
      }
    };

    let position = this.bytesWritten;
    await fh.truncate(position === 0 ? 0 : position);

    await fill();
    while (nextToWrite < this.total) {
      const head = queue.shift();
      if (!head) throw new NetworkError('Segment queue drained unexpectedly');
      const { index, buf } = await head;
      nextToWrite += 1;
      let offset = index === this.resumeIndex ? this.resumeOffset : 0;
      await this.resumeGuard(signal);
      const data = offset > 0 ? buf.subarray(offset) : buf;
      if (data.length) {
        await fh.write(data, 0, data.length, position);
        position += data.length;
        this.bytesWritten = position;
        this.#sample();
      }
      this.completedSegments = index + 1;
      this.resumeIndex = index + 1;
      this.resumeOffset = 0;
      this.store?.save?.(this)?.catch?.(() => {});
      this.#emit();
      await fill();
    }
    this.#emit(true);
  }

  async resumeGuard(signal) {
    if (this.limit?.rate > 0 && this.lastChunkBytes) {
      await this.limit.take(this.lastChunkBytes, signal);
    }
  }

  async #fetchSegment(seg, signal) {
    const headers = { ...this.headers };
    // An initialization segment belongs exactly ONCE, at the head of the file —
    // repeating it before every fragment makes the output larger than the sum of
    // its parts (and unplayable). Only segment 0 carries it.
    const chain = seg.init && seg.index === 0 ? [seg.init, seg.url] : [seg.url];
    const parts = [];
    for (const url of chain) {
      const buf = await fetchWithRetry(url, { headers, signal, retries: 4 });
      parts.push(buf);
      if (this.limit?.rate > 0) {
        this.lastChunkBytes = buf.length;
        await this.limit.take(buf.length, signal);
      }
    }
    return Buffer.concat(parts);
  }

  pause() {
    if (this.status !== MANIFEST_STATUS.DOWNLOADING && this.status !== MANIFEST_STATUS.CONNECTING) return false;
    this.controller?.abort();
    return true;
  }

  async resume() {
    if (this.status === MANIFEST_STATUS.COMPLETE) return this.snapshot();
    this.error = null;
    return this.start();
  }
}

async function fetchWithRetry(url, { headers, signal, retries = 4 }) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const res = await fetch(url, { headers, signal, redirect: 'follow' });
      if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (signal?.aborted) throw abortError(signal);
      if (attempt > retries || !(isRetryable(err) || err?.name === 'TypeError')) throw err;
      await sleep(backoffDelay(attempt), signal);
    }
  }
}

/** Read the persisted sidecar for a manifest job. */
export async function loadManifestState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export { stat, writeFile, formatBytes };
