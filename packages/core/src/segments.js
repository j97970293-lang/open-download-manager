/**
 * Segmented download state.
 *
 * A download is split into N contiguous segments, each with its own byte cursor.
 * Segment state is persisted so a process restart can resume exactly where the
 * previous run stopped — the core feature people keep IDM around for.
 */

import { open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { planRanges } from './util.js';
import { DiskError, ResumeMismatchError } from './errors.js';

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
  }

  async open() {
    await mkdir(dirname(this.path), { recursive: true });
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
        this.handle = await open(this.path, 'r+');
      } catch {
        this.handle = await open(this.path, 'w+');
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
