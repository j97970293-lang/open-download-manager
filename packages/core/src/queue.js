/**
 * Queue manager: decides *which* transfers may run, in what order.
 *
 * Policy
 *  - global max concurrent transfers (default 3)
 *  - strict priority (higher number first), FIFO inside a priority band
 *  - optional global bandwidth ceiling shared by every connection of every job
 */

import { EventEmitter } from 'node:events';
import { RateLimiter } from './rate.js';
import { STATUS } from './downloader.js';

export class QueueManager extends EventEmitter {
  constructor(store, { maxConcurrent = 3, globalRate = 0, autostart = true } = {}) {
    super();
    this.store = store;
    this.maxConcurrent = maxConcurrent;
    this.globalLimiter = new RateLimiter(globalRate);
    this.autostart = autostart;
    this.paused = false;
    this.running = new Set();
    this.tickScheduled = false;
  }

  get concurrency() {
    return this.maxConcurrent;
  }

  setMaxConcurrent(n) {
    this.maxConcurrent = Math.max(1, Math.min(16, Number(n) || 1));
    this.tick();
  }

  setGlobalRate(bytesPerSecond) {
    this.globalLimiter.setRate(bytesPerSecond);
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    if (this.paused) {
      for (const task of this.store.list()) {
        if (task.status === STATUS.QUEUED || task.status === STATUS.DOWNLOADING || task.status === STATUS.CONNECTING) {
          task.pause();
        }
      }
    } else {
      this.tick();
    }
    this.emit('paused', this.paused);
  }

  /** Called by the store whenever a job is added or a slot frees up. */
  tick() {
    if (this.tickScheduled) return;
    this.tickScheduled = true;
    queueMicrotask(() => {
      this.tickScheduled = false;
      this.#schedule();
    });
  }

  #schedule() {
    if (this.paused || !this.autostart) return;
    for (const task of this.running) {
      if (task.status !== STATUS.DOWNLOADING && task.status !== STATUS.CONNECTING) this.running.delete(task);
    }
    const free = this.maxConcurrent - this.running.size;
    if (free <= 0) return;
    const candidates = this.store
      .list()
      .filter((t) => t.status === STATUS.QUEUED && !this.running.has(t))
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
      .slice(0, free);
    for (const task of candidates) {
      this.running.add(task);
      task.globalLimiter = this.globalLimiter;
      this.emit('start', task.snapshot());
      task
        .start()
        .catch(() => {})
        .finally(() => {
          this.running.delete(task);
          this.emit('slot', task.snapshot());
          this.tick();
        });
    }
  }
}
