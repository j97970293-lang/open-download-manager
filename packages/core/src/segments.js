/**
 * Segmented download state.
 *
 * A download is split into N contiguous segments, each with its own byte cursor.
 * Segment state is persisted so a process restart can resume exactly where the
 * previous run stopped — the core feature people keep IDM around for.
 */

import { access, mkdir, open, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { planRanges } from './util.js';
import { DiskError, ResumeMismatchError } from './errors.js';

/** Race any filesystem call against a deadline: a hung mount must not hang a task. */
export async function withDiskTimeout(factory, { ms = 30_000, what = 'filesystem operation', path = '' } = {}) {
  let timer;
  // The operation may never settle (a wedged mount), so it is detached from the
  // caller: the timeout wins, and a late result is discarded instead of blocking.
  const operation = Promise.resolve().then(factory);
  operation.catch(() => {});
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new DiskError(`${what} timed out after ${ms}ms${path ? ` (${path})` : ''}`, { path })),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const SEGMENT_STATE = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  DONE: 'done',
  FAILED: 'failed',
});

export function createSegments(totalBytes, connections) {
  return planRanges(totalBytes, connections).map(([start, end], i) => ({
    index: i,
    start,
    end,
    cursor: start,
    status: SEGMENT_STATE.PENDING,
  }));
}

export function segmentRemaining(seg) {
  return Math.max(0, seg.end - seg.cursor + 1);
}

export function totalRemaining(segments) {
  return segments.reduce((sum, seg) => sum + segmentRemaining(seg), 0);
}

export function isComplete(segments) {
  return segments.length > 0 && segments.every((s) => s.cursor > s.end || s.status === SEGMENT_STATE.DONE);
}

/**
 * A preallocated output file that many segment workers write into concurrently.
 * One file handle, positioned writes (pwrite) — no file-descriptor explosion and
 * no cross-segment interference.
 */
export class TargetFile {
  constructor(path, size) {
    this.path = path;
    this.size = size;
    this.handle = null;
    this.written = 0;
    this.diskTimeoutMs = null;
  }

  async open() {
    const ms = this.diskTimeoutMs ?? 30_000;
    await withDiskTimeout(() => mkdir(dirname(this.path), { recursive: true }), {
      ms,
      what: 'Cannot create directory',
      path: dirname(this.path),
    });
    try {
      if (Number.isFinite(this.size) && this.size > 0) {
        const fh = await open(this.path, 'r+').catch(() => null);
        if (fh) {
          const s = await fh.stat();
          await fh.close();
          if (s.size < this.size) await this.#truncate(this.size);
        } else {
          this.handle = await open(this.path, 'w');
          await this.handle.truncate(this.size);
        }
      }
    } catch (err) {
      throw new DiskError(`Cannot allocate ${this.path}: ${err.message}`, { path: this.path });
    }
    if (!this.handle) {
      try {
        this.handle = await withDiskTimeout(() => open(this.path, 'r+'), { ms, what: 'Cannot open', path: this.path });
      } catch {
        this.handle = await withDiskTimeout(() => open(this.path, 'w+'), { ms, what: 'Cannot create', path: this.path });
      }
    }
    const current = await stat(this.path).catch(() => null);
    if (Number.isFinite(this.size) && this.size > 0 && current && current.size < this.size) {
      await this.handle.truncate(this.size);
    }
    return this;
  }

  async #truncate(size) {
    const fh = await open(this.path, 'r+').catch(() => null);
    if (!fh) return;
    await fh.truncate(size);
    await fh.close();
  }

  /** Positioned write; returns bytes written. */
  async write(buffer, position) {
    if (!this.handle) await this.open();
    try {
      const { bytesWritten } = await this.handle.write(buffer, 0, buffer.length, position);
      this.written += bytesWritten;
      return bytesWritten;
    } catch (err) {
      throw new DiskError(`Write failed at ${position}: ${err.message}`, { path: this.path });
    }
  }

  async flush() {
    try {
      await this.handle?.sync();
    } catch {
      /* sync is best-effort (some filesystems reject fsync on pipes) */
    }
  }

  async close() {
    await this.flush();
    await this.handle?.close().catch(() => {});
    this.handle = null;
  }
}

/**
 * Pick a destination path that never overwrites an unrelated file:
 * report.pdf → "report (1).pdf" → "report (2).pdf" …
 * A file that this job already owns (resume) keeps its path.
 */
export async function uniquePath(dir, filename, { owned = false, maxTries = 500 } = {}) {
  if (owned) return join(dir, filename);
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let i = 0; i < maxTries; i += 1) {
    const candidate = i === 0 ? filename : `${stem} (${i})${ext}`;
    const target = join(dir, candidate);
    const taken = await access(target).then(() => true, () => false);
    if (!taken) return target;
  }
  throw new DiskError(`Cannot find a free name for ${filename} in ${dir}`, { path: dir });
}

/** Validate that a stored job can still resume against the live remote resource. */
export function assertResumable(job, remote) {
  if (!job.size || !remote.size) return;
  if (job.size !== remote.size) {
    throw new ResumeMismatchError(
      `Remote size changed (${job.size} -> ${remote.size}); start a new download instead of resuming`,
      { expected: job.size, actual: remote.size },
    );
  }
  if (job.etag && remote.etag && job.etag !== remote.etag) {
    throw new ResumeMismatchError(`Remote ETag changed (${job.etag} -> ${remote.etag})`);
  }
}
