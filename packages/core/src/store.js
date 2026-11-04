/**
 * Persistent job store: one JSON file for the queue, one sidecar per transfer.
 * Writes are atomic (tmp file + rename) so a crash never leaves a half file.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { STATUS } from './downloader.js';
import { DownloadTask } from './downloader.js';

const VERSION = 1;

export class JobStore {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, 'queue.json');
    this.segmentDir = join(dir, 'jobs');
    this.tasks = new Map();
    this.writeChain = Promise.resolve();
    this.tmpSeq = 0;
  }

  async init() {
    await mkdir(this.segmentDir, { recursive: true });
    await this.load();
    return this;
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    for (const job of jobs) {
      const segments = await this.#loadSegments(job.id);
      const task = new DownloadTask({
        ...job,
        segments: segments ?? job.segments ?? [],
        store: this,
        // Anything that was mid-flight becomes "paused" so the user decides.
        status:
          job.status === STATUS.DOWNLOADING || job.status === STATUS.CONNECTING ? STATUS.PAUSED : job.status,
      });
      this.tasks.set(task.id, task);
      this.#wire(task);
    }
    return [...this.tasks.values()];
  }

  async #loadSegments(id) {
    try {
      const raw = await readFile(join(this.segmentDir, `${id}.json`), 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.segments) ? parsed.segments : null;
    } catch {
      return null;
    }
  }

  #wire(task) {
    task.store = this;
    task.on('status', () => this.scheduleSave());
    task.on('progress', (snap) => {
      if (snap.status === STATUS.DOWNLOADING) this.scheduleSave();
    });
  }

  scheduleSave() {
    this.saveSoon ??= Promise.resolve();
    this.saveSoon = this.saveSoon.then(() => this.persist()).catch(() => {});
    return this.saveSoon;
  }

  add(task, { start = true } = {}) {
    if (!(task instanceof DownloadTask)) task = new DownloadTask({ ...task, store: this });
    this.tasks.set(task.id, task);
    this.#wire(task);
    if (start) this.start(task.id).catch(() => {});
    else {
      task.status = task.status === STATUS.QUEUED ? STATUS.QUEUED : task.status;
      this.scheduleSave();
    }
    return task;
  }

  async start(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`No download ${id}`);
    return task.start();
  }

  get(id) {
    return this.tasks.get(id);
  }

  list() {
    return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  remove(id, { deleteFile = false } = {}) {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === STATUS.DOWNLOADING || task.status === STATUS.CONNECTING) task.cancel({ deleteFile });
    this.tasks.delete(id);
    unlink(join(this.segmentDir, `${id}.json`)).catch(() => {});
    if (deleteFile) unlink(task.path).catch(() => {});
    this.scheduleSave();
    return true;
  }

  async persist() {
    const jobs = this.list().map((t) => t.toJSON());
    const payload = JSON.stringify({ version: VERSION, savedAt: new Date().toISOString(), jobs }, null, 2);
    await atomicWrite(this.file, payload, this.#nextTmp());
    for (const task of this.tasks.values()) {
      const segments = JSON.stringify({ segments: task.segments }, null, 0);
      await atomicWrite(join(this.segmentDir, `${task.id}.json`), segments, this.#nextTmp());
    }
  }

  #nextTmp() {
    this.tmpSeq += 1;
    return `${process.pid}-${this.tmpSeq}`;
  }

  async totalStoredBytes() {
    let total = 0;
    try {
      for (const name of await readdir(this.dir)) {
        if (!name.endsWith('.json')) continue;
        const raw = await readFile(join(this.dir, name), 'utf8');
        total += Buffer.byteLength(raw);
      }
    } catch {
      /* empty store */
    }
    return total;
  }
}

export async function atomicWrite(path, data, suffix = 'tmp') {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${suffix}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}
