/**
 * Scheduler: queue jobs for an off-peak window ("start at 01:30", "stop at 07:00").
 * Deliberately tiny: HH:MM daily windows, evaluated once a minute.
 */

export class ScheduleWindow {
  constructor({ start = null, stop = null, days = null } = {}) {
    this.start = start; // "HH:MM"
    this.stop = stop; // "HH:MM"
    this.days = days; // [0..6] or null for every day
  }

  static parse(spec) {
    if (!spec) return null;
    if (typeof spec === 'object') return new ScheduleWindow(spec);
    const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(String(spec).trim());
    if (!m) return null;
    return new ScheduleWindow({ start: m[1], stop: m[2] });
  }

  #minutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  isOpen(date = new Date()) {
    if (this.days && !this.days.includes(date.getDay())) return false;
    const now = date.getHours() * 60 + date.getMinutes();
    const start = this.#minutes(this.start);
    const stop = this.#minutes(this.stop);
    if (start <= stop) return now >= start && now < stop;
    return now >= start || now < stop; // window crosses midnight
  }
}

export class Scheduler {
  constructor(queue, { now = () => new Date(), intervalMs = 30_000 } = {}) {
    this.queue = queue;
    this.now = now;
    this.intervalMs = intervalMs;
    this.windows = new Map(); // jobId -> ScheduleWindow
    this.timer = null;
    this.autoPaused = false;
  }

  schedule(jobId, spec) {
    const window = ScheduleWindow.parse(spec);
    if (!window) throw new Error(`Invalid schedule "${spec}" (expected HH:MM-HH:MM)`);
    this.windows.set(jobId, window);
    return window;
  }

  unschedule(jobId) {
    return this.windows.delete(jobId);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.evaluate(), this.intervalMs);
    this.timer.unref?.();
    this.evaluate();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  evaluate() {
    const now = this.now();
    const anyOpen = [...this.windows.values()].some((w) => w.isOpen(now));
    if (this.windows.size === 0) return;
    if (!anyOpen && !this.autoPaused) {
      this.autoPaused = true;
      this.queue.setPaused(true);
    } else if (anyOpen && this.autoPaused) {
      this.autoPaused = false;
      this.queue.setPaused(false);
    }
  }
}
