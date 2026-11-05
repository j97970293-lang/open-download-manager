/**
 * Open Download Manager core — public API.
 *
 * A clean-room, MIT-licensed reimplementation of a segmented download manager:
 * multi-connection transfers, crash-safe resume, bandwidth shaping, checksum
 * verification, media/manifest grabbing, and an automatable queue.
 */

export { DownloadTask, STATUS } from './downloader.js';
export { ManifestDownload, MANIFEST_STATUS, loadManifestState } from './manifest-download.js';
export { TorrentDownload, TORRENT_STATUS, parseTorrent, parseMagnet, announce } from './torrent.js';
export { planDash, expandTimeline, describeDash } from './dash.js';
export { encode as bencodeEncode, decode as bencodeDecode } from './bencode.js';
export { JobStore, atomicWrite } from './store.js';
export { QueueManager } from './queue.js';
export { Scheduler, ScheduleWindow } from './scheduler.js';
export { RateLimiter, TokenBucket } from './rate.js';
export {
  TargetFile,
  createSegments,
  segmentRemaining,
  totalRemaining,
  isComplete,
  assertResumable,
  SEGMENT_STATE,
  withDiskTimeout,
  uniquePath,
} from './segments.js';
export { probeUrl, streamRange, parseContentRange, mergeHeaders, DEFAULT_HEADERS } from './net.js';
export { hashFile, parseChecksum, sniffFile, CHECKSUM_ALGOS } from './checksum.js';
export {
  extractMediaFromHtml,
  resolveManifest,
  parseM3u8,
  parseMpd,
  classifyUrl,
  isMediaUrl,
  pickVariant,
  buildMediaPlaylist,
} from './media.js';
export {
  formatBytes,
  parseSize,
  formatDuration,
  backoffDelay,
  filenameFromContentDisposition,
  sanitizeFilename,
  filenameFromUrl,
  planRanges,
  makeId,
  clamp,
} from './util.js';
export { OdmError, HttpError, NetworkError, DiskError, ChecksumError, RangeUnsupportedError, ResumeMismatchError, AbortError, isRetryable } from './errors.js';
