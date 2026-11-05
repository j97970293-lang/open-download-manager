/**
 * DownloadTask — one resumable, multi-connection transfer.
 *
 * Lifecycle:  queued -> connecting -> downloading -> (paused | complete | error)
 *
 * Design notes
 *  - Segments are independent readers of the same preallocated file.
 *  - A single AbortController per run cancels every connection instantly.
 *  - Progress is emitted on a timer (never per chunk) so the UI stays cheap.
 *  - State is saved on every transition and every `saveEveryMs` while running.
 */

import { EventEmitter } from 'node:events';
import { basename, join } from 'node:path';
import { mkdir, open, unlink } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { createSegments, TargetFile, SEGMENT_STATE, totalRemaining, isComplete, uniquePath, assertResumable, withDiskTimeout } from './segments.js';
import { streamRange, probeUrl, stripCredentials } from './net.js';
import { RateLimiter } from './rate.js';
import {
  AbortError,
  DiskError,
  ChecksumError,
  HttpError,
  NetworkError,
  RangeUnsupportedError,
  isRetryable,
} from './errors.js';
import {
  backoffDelay,
  extOf,
  filenameFromUrl,
  formatBytes,
  makeId,
  sanitizeFilename,
  sleep,
} from './util.js';
import { hashFile, parseChecksum } from './checksum.js';

export const STATUS = Object.freeze({
  QUEUED: 'queued',
  CONNECTING: 'connecting',
  DOWNLOADING: 'downloading',
  PAUSED: 'paused',
  COMPLETE: 'complete',
  ERROR: 'error',
  CANCELED: 'canceled',
});

const PAUSABLE = new Set([STATUS.QUEUED, STATUS.CONNECTING, STATUS.DOWNLOADING]);

export class DownloadTask extends EventEmitter {
  constructor(options = {}) {
    super();
    let {
      url,
      dir = process.cwd(),
      filename,
      connections = 8,
      headers = {},
      referer,
      checksum,
      priority = 5,
      store = null,
      globalLimiter = null,
      maxRetries = 6,
      diskTimeoutMs = 30_000,
      speedSamples = 6,
      now = () => Date.now(),
    } = options;

    if (!url) throw new Error('DownloadTask requires a url');
    this.id = options.id || makeId();
    const stripped = stripCredentials(url);
    this.url = stripped.url;
    if (stripped.authorization) headers = { ...headers, authorization: stripped.authorization };
    this.finalUrl = options.finalUrl ? stripCredentials(options.finalUrl).url : stripped.url;
    this.dir = dir;
    this.filename = sanitizeFilename(filename || filenameFromUrl(url));
    this.connections = Math.max(1, Math.min(32, connections));
    this.headers = { ...headers, ...(referer ? { referer } : {}) };
    this.checksum = checksum ? parseChecksum(checksum) : null;
    this.priority = priority;
    this.store = store;
    this.globalLimiter = globalLimiter;
    this.maxRetries = maxRetries;
    this.diskTimeoutMs = diskTimeoutMs;
    this.now = now;

    this.size = options.size ?? null;
    this.etag = options.etag ?? null;
    this.lastModified = options.lastModified ?? null;
    this.contentType = options.contentType ?? null;
    this.acceptRanges = options.acceptRanges ?? null;
    this.segments = options.segments?.length ? options.segments : [];
    this.status = options.status && options.status !== STATUS.PAUSED ? STATUS.QUEUED : options.status || STATUS.QUEUED;
    if (this.status === STATUS.CONNECTING || this.status === STATUS.DOWNLOADING) this.status = STATUS.QUEUED;
    if (options.status === STATUS.COMPLETE) this.status = STATUS.COMPLETE;
    this.error = options.error ?? null;
    this.createdAt = options.createdAt ?? this.now();
    this.startedAt = options.startedAt ?? null;
    this.completedAt = options.completedAt ?? null;
    this.totalBytes = options.totalBytes ?? 0;

    this.limiter = new RateLimiter(options.limit ?? 0);
    this.speedWindow = [];
    this.windowSize = speedSamples;
    this.file = null;
    this.pathOverride = options.pathOverride ?? null;
    if (this.pathOverride) this.filename = basename(this.pathOverride);
    this.controller = null;
    this.active = 0;
    this.progressTimer = null;
    this.saveTimer = null;
    this.lastEmit = 0;
    this.pendingSave = false;
    this.runPromise = null;
  }

  get path() {
    return this.pathOverride || join(this.dir, this.filename);
  }

  get downloaded() {
    if (!this.size || !this.segments.length) {
      return this.status === STATUS.COMPLETE ? this.size ?? 0 : this.totalBytes || 0;
    }
    return this.size - totalRemaining(this.segments);
  }

  get progress() {
    if (this.status === STATUS.COMPLETE) return 1;
    if (!this.size) return 0;
    return Math.min(1, this.downloaded / this.size);
  }

  speed() {
    const now = this.now();
    const window = this.speedWindow.filter((s) => now - s.t <= 1000);
    if (window.length < 2) return 0;
    const first = window[0];
    const last = window[window.length - 1];
    const dt = (last.t - first.t) / 1000;
    return dt > 0 ? Math.max(0, (last.bytes - first.bytes) / dt) : 0;
  }

  eta() {
    const speed = this.speed();
    if (!this.size || speed <= 0) return null;
    const remaining = this.size - this.downloaded;
    return remaining <= 0 ? 0 : Math.round((remaining / speed) * 1000);
  }

  snapshot() {
    return {
      id: this.id,
      url: this.url,
      finalUrl: this.finalUrl,
      filename: this.filename,
      dir: this.dir,
      path: this.path,
      size: this.size,
      downloaded: this.downloaded,
      progress: this.progress,
      status: this.status,
      speed: this.status === STATUS.DOWNLOADING ? Math.round(this.speed()) : 0,
      eta: this.status === STATUS.DOWNLOADING ? this.eta() : null,
      connections: this.connections,
      activeConnections: this.active,
      contentType: this.contentType,
      etag: this.etag,
      priority: this.priority,
      error: this.error ? { message: this.error.message, code: this.error.code, retryable: this.error.retryable } : null,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      segments: this.segments.map((s) => ({
        index: s.index,
        start: s.start,
        end: s.end,
        cursor: s.cursor,
        status: s.status,
        progress: s.end >= s.start ? (s.cursor - s.start) / (s.end - s.start + 1) : 1,
      })),
    };
  }

  toJSON() {
    return {
      ...this.snapshot(),
      headers: this.headers,
      pathOverride: this.pathOverride,
      acceptRanges: this.acceptRanges,
      lastModified: this.lastModified,
      checksum: this.checksum,
      totalBytes: this.totalBytes,
    };
  }

  #setStatus(status, extra = {}) {
    this.status = status;
    Object.assign(this, extra);
    this.#persist(true);
    this.emit('status', status, this.snapshot());
  }

  #persist(immediate = false) {
    if (!this.store) return;
    if (immediate) {
      this.pendingSave = false;
      (this.store.save?.(this) ?? this.store.persist?.() ?? Promise.resolve()).catch((err) => this.emit('warn', { message: `state save failed: ${err.message}` }));
      return;
    }
    this.pendingSave = true;
  }

  #emitProgress(force = false) {
    const now = this.now();
    if (!force && now - this.lastEmit < 200) return;
    this.lastEmit = now;
    this.emit('progress', this.snapshot());
  }

  #sample() {
    this.speedWindow.push({ t: this.now(), bytes: this.downloaded });
    if (this.speedWindow.length > this.windowSize * 2) this.speedWindow.shift();
  }

  async #resolveInfo(signal, { enforceIdentity = false } = {}) {
    const info = await probeUrl(this.url, { headers: this.headers, signal });
    if (enforceIdentity && this.segments.length && this.segments.some((s) => s.cursor > s.start)) {
      // We already have bytes on disk: the remote must still be the same resource.
      assertResumable(this, { size: info.size, etag: info.etag });
    }
    this.finalUrl = info.finalUrl;
    this.size = info.size;
    this.etag = info.etag;
    this.lastModified = info.lastModified;
    this.contentType = info.contentType;
    this.acceptRanges = info.acceptRanges && info.size != null;
    if (!this.size) this.acceptRanges = false;
    if (!this.filename || this.filename === filenameFromUrl(this.url)) {
      this.filename = sanitizeFilename(info.filename || filenameFromUrl(info.finalUrl));
    }
    // Respect the server MIME when the URL had no extension at all.
    if (!extOf(this.filename) && info.contentType) {
      const guessed = mimeToExt(info.contentType);
      if (guessed) this.filename = `${this.filename}.${guessed}`;
    }
    return info;
  }

  /** Download the whole body in one stream (no ranges available). */
  async #singleStream(signal) {
    if (!this.pathOverride) {
      this.pathOverride = await uniquePath(this.dir, this.filename, { owned: this.totalBytes > 0 });
      if (basename(this.pathOverride) !== this.filename) {
        this.filename = basename(this.pathOverride);
        this.emit('notice', { message: `Destination exists — saving as ${this.filename}` });
      }
    }
    const file = new TargetFile(this.path, null);
    await file.open();
    let position = 0;
    let attempt = 0;
    try {
      for (;;) {
        try {
          const headers = position > 0 ? { ...this.headers, range: `bytes=${position}-` } : { ...this.headers };
          const res = await fetch(this.finalUrl, { headers, redirect: 'follow', signal });
          if (res.status === 416 && position > 0) {
            // Already had everything the server is willing to give.
            this.size = position;
            break;
          }
          if (res.status >= 400) throw new HttpError(res.status, `HTTP ${res.status}`);
          if (!res.body) throw new NetworkError('Empty body');
          if (position > 0 && res.status !== 206) {
            // Server restarted from byte 0: rewind our cursor instead of corrupting the file.
            position = 0;
          }
          for await (const chunk of res.body) {
            const buf = Buffer.from(chunk);
            if (position === 0 && this.totalBytes && this.totalBytes > buf.length) {
              await file.handle?.truncate(0).catch?.(() => {});
            }
            await file.write(buf, position);
            position += buf.length;
            this.totalBytes = position;
            if (this.globalLimiter) await this.globalLimiter.take(buf.length, signal);
            await this.limiter.take(buf.length, signal);
            this.#sample();
            this.#emitProgress();
          }
          if (this.size && position < this.size && position > 0) {
            throw new NetworkError(`Stream ended at ${position}/${this.size}`);
          }
          this.size ??= position;
          break;
        } catch (err) {
          if (signal.aborted) throw err;
          attempt += 1;
          if (attempt > this.maxRetries || (err instanceof HttpError && !err.retryable)) throw err;
          const delay = backoffDelay(attempt);
          this.emit('retry', { attempt, delay, error: err, at: position });
          await sleep(delay, signal);
        }
      }
    } finally {
      await file.close();
    }
  }

  /** Run one segment until its cursor passes its end. */
  async #runSegment(seg, signal) {
    if (seg.cursor > seg.end || seg.status === SEGMENT_STATE.DONE) {
      seg.status = SEGMENT_STATE.DONE;
      return;
    }
    seg.status = SEGMENT_STATE.ACTIVE;
    this.active += 1;
    this.emit('segments', this.snapshot());
    try {
      const iterator = streamRange(this.finalUrl, {
        start: seg.cursor,
        end: seg.end,
        headers: this.headers,
        signal,
        retries: this.maxRetries,
        onRetry: ({ attempt, delay, error }) => this.emit('retry', { attempt, delay, error, segment: seg.index }),
      });
      for await (const buf of iterator) {
        const room = seg.end - seg.cursor + 1;
        const slice = buf.length > room ? buf.subarray(0, room) : buf;
        await this.file.write(slice, seg.cursor);
        seg.cursor += slice.length;
        if (this.globalLimiter) await this.globalLimiter.take(slice.length, signal);
        await this.limiter.take(slice.length, signal);
        this.#sample();
        this.#emitProgress();
        if (seg.cursor > seg.end) break;
      }
      if (seg.cursor > seg.end) {
        seg.status = SEGMENT_STATE.DONE;
      } else {
        throw new NetworkError(`Segment ${seg.index} stalled at ${seg.cursor}`);
      }
    } catch (err) {
      seg.status = SEGMENT_STATE.FAILED;
      throw err;
    } finally {
      this.active = Math.max(0, this.active - 1);
      this.#persist();
    }
  }

  async #checkExisting() {
    const existing = await stat(this.path).catch(() => null);
    if (!existing) return false;
    if (this.size && existing.size === this.size && this.status === STATUS.QUEUED && this.segments.length) {
      // A previous run may have finished writing but not flipped the flag.
      if (isComplete(this.segments)) {
        this.totalBytes = existing.size;
        return true;
      }
    }
    return false;
  }

  /** Start (or resume) the transfer. Resolves when finished, paused, or failed. */
  async start() {
    if (this.runPromise) return this.runPromise;
    if (this.status === STATUS.COMPLETE) return this.snapshot();
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.runPromise = this.#run(signal).finally(() => {
      this.runPromise = null;
      this.controller = null;
      clearInterval(this.progressTimer);
      clearInterval(this.saveTimer);
      this.#persist(true);
      this.#emitProgress(true);
    });
    return this.runPromise;
  }

  /** Fail fast when the destination cannot hold files at all (dead mount, read-only fs). */
  async #assertDestinationWritable() {
    const probePath = join(this.dir, `.odm-write-test-${process.pid}-${Date.now()}`);
    try {
      await withDiskTimeout(() => mkdir(this.dir, { recursive: true }), {
        ms: this.diskTimeoutMs,
        what: 'Destination unusable',
        path: this.dir,
      });
      const fh = await withDiskTimeout(() => open(probePath, 'w'), {
        ms: this.diskTimeoutMs,
        what: 'Destination not writable',
        path: this.dir,
      });
      await fh.close();
      await unlink(probePath).catch(() => {});
    } catch (err) {
      // Already typed (timeout / allocation) → keep the precise code and message.
      const wrapped = err instanceof DiskError || err.name === 'DiskError' ? err : new DiskError(`Destination unusable: ${err.message}`, { path: this.dir });
      this.error = { message: wrapped.message, code: wrapped.code ?? 'DISK_ERROR', retryable: false };
      throw wrapped;
    }
  }

  async #run(signal) {
    this.active = 0;
    this.speedWindow = [];
    this.#setStatus(STATUS.CONNECTING);
    this.startedAt ??= this.now();
    try {
      await this.#assertDestinationWritable();
      if (!this.size || this.acceptRanges === null) {
        await this.#resolveInfo(signal, { enforceIdentity: true });
        this.#persist(true);
      }
      if (this.status === STATUS.COMPLETE) return this.snapshot();
      if (await this.#checkExisting()) {
        this.#setStatus(STATUS.COMPLETE, { completedAt: this.now() });
        return this.snapshot();
      }

      // Never write over an unrelated file: pick "name (1).ext" when the target exists.
      if (!this.pathOverride) {
        const owned = this.segments.some((s) => s.cursor > s.start) || this.totalBytes > 0;
        this.pathOverride = await uniquePath(this.dir, this.filename, { owned });
        if (basename(this.pathOverride) !== this.filename) {
          this.filename = basename(this.pathOverride);
          this.emit('notice', { message: `Destination exists — saving as ${this.filename}` });
        }
      }

      this.progressTimer = setInterval(() => this.#emitProgress(), 250);
      this.saveTimer = setInterval(() => {
        if (this.status === STATUS.DOWNLOADING) this.#persist(true);
      }, 1500);

      this.#setStatus(STATUS.DOWNLOADING);
      this.startedAt ??= this.now();

      const useRanges = this.acceptRanges && this.size && this.size > 0;
      if (!useRanges) {
        this.emit('notice', { message: 'Server has no byte-range support — downloading with a single stream' });
        await this.#singleStream(signal);
        this.segments = [{ index: 0, start: 0, end: Math.max(0, this.size - 1), cursor: this.size, status: SEGMENT_STATE.DONE }];
      } else {
        if (!this.segments.length || this.segments.at(-1).end !== this.size - 1) {
          this.segments = createSegments(this.size, this.connections);
        } else if (this.segments.some((s) => s.cursor > s.start)) {
          // Resuming with bytes on disk: the remote must still be the same resource,
          // otherwise we would splice two versions of a file together.
          const fresh = await probeUrl(this.finalUrl, { headers: this.headers, signal });
          assertResumable(this, fresh);
        }
        this.file = new TargetFile(this.path, this.size);
        this.file.diskTimeoutMs = this.diskTimeoutMs;
        await this.file.open();
        // Bounded worker pool over the segment list.
        const queue = [...this.segments];
        const workers = Array.from({ length: Math.min(this.connections, queue.length) }, async () => {
          for (;;) {
            const seg = queue.shift();
            if (!seg || signal.aborted) return;
            await this.#runSegment(seg, signal);
          }
        });
        try {
          await Promise.all(workers);
        } finally {
          await this.file.close();
        }
        if (!isComplete(this.segments)) {
          throw new NetworkError('Download incomplete: some segments did not finish');
        }
      }

      if (this.checksum) {
        this.emit('verifying', { algorithm: this.checksum.algorithm });
        const actual = await hashFile(this.path, this.checksum.algorithm);
        if (actual.toLowerCase() !== this.checksum.value.toLowerCase()) {
          throw new ChecksumError(this.checksum.value, actual);
        }
        this.emit('verified', { algorithm: this.checksum.algorithm, value: actual });
      }

      this.completedAt = this.now();
      this.#setStatus(STATUS.COMPLETE);
      const snap = this.snapshot();
      this.emit('done', snap);
      return snap;
    } catch (err) {
      if (signal.aborted) {
        this.#setStatus(STATUS.PAUSED);
        const snapshot = this.snapshot();
        this.emit('paused', snapshot);
        return snapshot;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      this.error = { message: error.message, code: error.code ?? 'ERROR', retryable: error.retryable ?? isRetryable(error) };
      this.#setStatus(STATUS.ERROR, { error: this.error });
      this.emit('failed', this.error, this.snapshot());
      return this.snapshot();
    }
  }

  pause() {
    if (!PAUSABLE.has(this.status)) return false;
    this.#setStatus(STATUS.PAUSED);
    this.controller?.abort();
    return true;
  }

  async resume() {
    if (this.status === STATUS.COMPLETE) return this.snapshot();
    this.error = null;
    return this.start();
  }

  cancel({ deleteFile = true } = {}) {
    this.controller?.abort();
    this.#setStatus(STATUS.CANCELED);
    if (deleteFile) unlink(this.path).catch(() => {});
    return true;
  }

  setLimit(bytesPerSecond) {
    this.limiter.setRate(bytesPerSecond);
  }

  setPriority(priority) {
    this.priority = priority;
    this.#persist(true);
  }

  setConnections(count) {
    this.connections = Math.max(1, Math.min(32, count));
    this.#persist(true);
  }

  describe() {
    const size = this.size ? formatBytes(this.size) : 'unknown size';
    return `${this.filename} — ${size} — ${this.status} (${Math.round(this.progress * 100)}%)`;
  }
}

function mimeToExt(contentType) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/json': 'json',
    'text/html': 'html',
    'application/octet-stream': 'bin',
  };
  return map[String(contentType).split(';')[0].trim()] ?? null;
}

export { RangeUnsupportedError, AbortError };
