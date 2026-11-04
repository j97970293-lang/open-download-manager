/** Token-bucket limiter: smooth global and per-download bandwidth caps. */

export class TokenBucket {
  constructor(bytesPerSecond = 0, { now = () => Date.now() } = {}) {
    this.rate = bytesPerSecond;
    this.now = now;
    this.tokens = bytesPerSecond;
    this.last = now();
  }

  setRate(bytesPerSecond) {
    this.refill();
    this.rate = Math.max(0, bytesPerSecond);
    this.tokens = Math.min(this.tokens, this.rate || 0);
  }

  refill() {
    const t = this.now();
    const elapsed = (t - this.last) / 1000;
    this.last = t;
    if (this.rate > 0 && elapsed > 0) {
      this.tokens = Math.min(this.rate, this.tokens + elapsed * this.rate);
    }
  }

  /** Consume up to `wanted` bytes; returns how many were granted (0 when paused by cap). */
  take(wanted) {
    if (this.rate <= 0) return wanted; // unlimited
    this.refill();
    const granted = Math.min(wanted, Math.floor(this.tokens));
    this.tokens -= granted;
    return granted;
  }

  /** Milliseconds until `bytes` would be available at the current rate. */
  delayFor(bytes) {
    if (this.rate <= 0) return 0;
    this.refill();
    const missing = bytes - this.tokens;
    return missing <= 0 ? 0 : Math.ceil((missing / this.rate) * 1000);
  }
}

/**
 * A limiter shared by every connection of one download (or the whole engine).
 * Acquire() resolves when the bucket has room for `bytes`.
 */
export class RateLimiter {
  constructor(bytesPerSecond = 0, options = {}) {
    this.bucket = new TokenBucket(bytesPerSecond, options);
    this.waiters = 0;
  }

  get rate() {
    return this.bucket.rate;
  }

  setRate(bytesPerSecond) {
    this.bucket.setRate(bytesPerSecond);
  }

  async take(bytes, signal) {
    if (this.bucket.rate <= 0) return bytes;
    let remaining = bytes;
    while (remaining > 0) {
      const granted = this.bucket.take(remaining);
      remaining -= granted;
      if (remaining <= 0) break;
      const wait = Math.max(1, this.bucket.delayFor(Math.min(remaining, this.bucket.rate)));
      await new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError', retryable: true }));
        const timer = setTimeout(resolve, wait);
        signal?.addEventListener?.(
          'abort',
          () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError', retryable: true }));
          },
          { once: true },
        );
      });
    }
    return bytes;
  }
}
