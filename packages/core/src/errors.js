/**
 * Typed error hierarchy for Open Download Manager.
 *
 * Every failure that can reach a UI or an API response is one of these, so the
 * dashboard can map it to an actionable message instead of leaking a stack trace.
 */
export class OdmError extends Error {
  constructor(message, { code = 'ODM_ERROR', retryable = false, details = null } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export class NetworkError extends OdmError {
  constructor(message, details) {
    super(message, { code: 'NETWORK_ERROR', retryable: true, details });
  }
}

export class HttpError extends OdmError {
  constructor(status, message, { retryable = status === 408 || status === 429 || status >= 500, details = null } = {}) {
    super(message || `HTTP ${status}`, { code: `HTTP_${status}`, retryable, details });
    this.status = status;
  }
}

export class DiskError extends OdmError {
  constructor(message, details) {
    super(message, { code: 'DISK_ERROR', retryable: false, details });
  }
}

/** The server answered 200 with content but refused/ignored byte ranges. */
export class RangeUnsupportedError extends OdmError {
  constructor(message = 'Server does not support byte-range requests') {
    super(message, { code: 'RANGE_UNSUPPORTED', retryable: false });
  }
}

/** Resume state on disk does not match the remote resource (ETag/Last-Modified drifted). */
export class ResumeMismatchError extends OdmError {
  constructor(message, details) {
    super(message, { code: 'RESUME_MISMATCH', retryable: false, details });
  }
}

export class ChecksumError extends OdmError {
  constructor(expected, actual) {
    super(`Checksum mismatch: expected ${expected}, got ${actual}`, {
      code: 'CHECKSUM_MISMATCH',
      retryable: true,
      details: { expected, actual },
    });
  }
}

export class AbortError extends OdmError {
  constructor(message = 'Aborted') {
    super(message, { code: 'ABORTED', retryable: true });
  }
}

export function isRetryable(err) {
  return Boolean(err && (err.retryable === true || err.code === 'NETWORK_ERROR' || err.code === 'ABORTED'));
}
