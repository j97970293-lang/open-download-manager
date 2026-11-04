# Parity report — reference behaviour vs. this implementation

**Method.** The reference product (1DM+ for Android, `idm.internet.download.manager.plus`, version 18.2, versionCode 30249, 55,711,317 bytes, minSdk 24 / targetSdk 34, 2 DEX files, 2,324 ZIP entries, native libs for `arm64-v8a` and `armeabi-v7a`) was analysed **statically**: package metadata, the compiled `AndroidManifest.xml`, declared permissions, services, receivers and intent filters. That manifest is a public capability declaration — it says what the app can do, not how it does it.

No DEX was decompiled, no resource was extracted, no asset was copied, and no network protocol of the product was reverse-engineered. The **how** in this repository comes from public specifications: RFC 9110 (`Range`, `Content-Range`, `ETag`, `If-Range`), RFC 8216 (HLS), ISO/IEC 23009-1 (DASH), RFC 6266 (`Content-Disposition`), RFC 7234 (caching validators).

## Evidence collected

| Fact | Value |
| --- | --- |
| Package | `idm.internet.download.manager.plus` |
| App label | `1DM+` |
| Version | 18.2 (30249) |
| SDK range | min 24, target 34 |
| APK SHA-256 | `6d334697c976990e2ad208774a5768c5914a92d37bd7354f497c79ea14b37b47` |
| Manifest size | 861,704 bytes (compiled AXML) |
| Components | 44 activities, 14 services, 4 receivers, 4 providers |
| Permissions | 27 declared |

### Permissions that map to features

| Declared permission | Capability it implies | Implemented here? |
| --- | --- | --- |
| `INTERNET`, `ACCESS_NETWORK_STATE` | network transfers | ✅ engine |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`, `WAKE_LOCK` | survive backgrounding / sleep | ⚠️ host-level (Node process + systemd unit provided) |
| `POST_NOTIFICATIONS` | completion notifications | ⚠️ SSE + host notifications |
| `SCHEDULE_EXACT_ALARM` | timed downloads | ✅ `Scheduler` (HH:MM windows) |
| `RECEIVE_BOOT_COMPLETED` | resume queue after reboot | ✅ state reload on start |
| `WRITE_EXTERNAL_STORAGE`, `READ_EXTERNAL_STORAGE` | file placement | ✅ plain filesystem paths |
| `REQUEST_INSTALL_PACKAGES` | install APKs after download | ❌ out of scope by design |
| `SYSTEM_ALERT_WINDOW` | floating "download this video" bubble | ❌ out of scope |
| `CAMERA`, `RECORD_AUDIO`, `ACCESS_FINE_LOCATION`, `READ_PHONE_STATE`, `QUERY_ALL_PACKAGES`, `PACKAGE_USAGE_STATS` | QR scanning, browser integration, ad/analytics plumbing | ❌ **not replicated** — no telemetry, no analytics |
| `com.google.android.c2dm.permission.RECEIVE` (FCM) | push messaging | ❌ not replicated |

### Services named in the manifest

`DownloadService`, `MediaScannerService`, `TempFilesDeletionService`, `CheckAppVersion`, `IDMTileService{Primary,Secondary,Tertiary,Quaternary}`, `LogcatCaptureService`, plus Firebase/datatransport plumbing.

| Reference service | This project |
| --- | --- |
| `DownloadService` | `DownloadTask` + `QueueManager` (long-lived process) |
| `MediaScannerService` | content-type sniffing (`src/checksum.js`) |
| `TempFilesDeletionService` | `.part`-style preallocation + atomic rename, `remove({deleteFile})` |
| `CheckAppVersion` | none (no update pings — privacy) |
| FCM / analytics / datatransport | none (privacy by construction) |

### Intent filters that define the intake surface

The manifest accepts `VIEW` for `http`, `https`, `file`, `content`, `magnet`, `idmdownload`, `1dmdownload`, `android.intent.action.SEND`/`SENDTO` with `*/*`, and explicit MIME intake for `application/vnd.apple.mpegurl`, `application/dash+xml`, `video/vnd.mpeg.dash.mpd`, `application/x-mpegurl`, `video/*`, `audio/*`, `application/sdp`.

That filter list is the clearest public statement of the product's **domain**: HTTP(S) files, media manifests (HLS/DASH), and torrent/magnet hand-off.

| Intake | Here |
| --- | --- |
| Direct HTTP(S) file | ✅ `odm add` / `POST /api/downloads` |
| HLS (`m3u8`, incl. `x-mpegurl` variants) | ✅ master + media playlist parsing, variant ranking |
| DASH (`mpd`, incl. `3gpp.mpd`, `audio/vnd.mpeg.dash.mpd`) | ✅ MPD parsing, representation ranking |
| In-page media (`video`, `audio`, `og:video`) | ✅ `odm grab` / `POST /api/grab` |
| `file://`, `content://` | ➖ meaningless outside Android |
| `magnet:` / BitTorrent | ❌ not implemented (separate protocol stack) |

## Feature parity matrix

Legend: ✅ implemented · ⚠️ partial / different mechanism · ❌ intentionally absent

### Core transfer

| Feature | Reference | Here | Notes |
| --- | --- | --- | --- |
| Multi-connection split download | ✅ | ✅ | test 4: 8 ranged requests, byte-identical output |
| Configurable connections | ✅ | ✅ | 1–32, default 8 |
| Resume after app kill | ✅ | ✅ | test 7: new `JobStore` resumes to completion |
| Resume after network drop | ✅ | ✅ | test 9: 2 forced connection drops → complete |
| Servers without range support | ✅ | ✅ | test 5: single stream, explicit notice |
| Redirect handling | ✅ | ✅ | test 10: 302 → final filename kept |
| Filename from `Content-Disposition` (RFC 6266/5987) | ✅ | ✅ | `filename*=UTF-8''…` decoded |
| Filename sanitising (Windows reserved names) | ✅ | ✅ | `sanitizeFilename` |
| MIME correction by magic bytes | ✅ | ✅ | 16 signatures + APK/ZIP disambiguation |
| Retry with backoff | ✅ | ✅ | full jitter, per-segment |
| Graceful `404`/`403` | ✅ | ✅ | non-retryable `HttpError` |

### Bandwidth and scheduling

| Feature | Reference | Here |
| --- | --- | --- |
| Per-download speed limit | ✅ | ✅ token bucket |
| Global speed limit | ✅ | ✅ shared bucket across all connections |
| Live limit change without restart | ✅ | ✅ `setLimit` / `PATCH /api/queue` |
| Queue concurrency limit | ✅ | ✅ 1–16 |
| Priority order | ✅ | ✅ 1–10 bands, FIFO inside |
| Timed / scheduled downloads | ✅ | ✅ `Scheduler` (crosses midnight) |
| Pause all / resume all | ✅ | ✅ UI + API |
| Speed graph | ✅ | ✅ sparkline (client-side) |

### Media

| Feature | Reference | Here | Notes |
| --- | --- | --- | --- |
| In-page video/audio detection | ✅ | ✅ | `<video>`, `<source>`, `og:video`, inline JS URLs |
| HLS parsing + quality choice | ✅ | ✅ | master/media playlists, `RESOLUTION`, `BANDWIDTH` |
| DASH parsing + quality choice | ✅ | ✅ | `AdaptationSet`/`Representation`, `BaseURL` |
| Live stream detection | ✅ | ✅ | `#EXT-X-ENDLIST` absence |
| Encrypted / DRM detection | ✅ | ✅ detect-and-refuse | no circumvention, ever |
| Segment remux to a single file | ✅ | ❌ | roadmap; variants are queued as direct streams |
| BitTorrent / magnet | ✅ | ❌ | separate protocol stack |

### Platform

| Feature | Reference | Here |
| --- | --- | --- |
| Mobile UI | ✅ | ⚠️ responsive web UI (430 px verified) |
| Desktop UI | ❌ | ✅ dashboard |
| Browser integration | ✅ | ❌ (API ready; extension is roadmap) |
| Background service | ✅ Android foreground service | ✅ long-lived Node process + systemd unit |
| Notifications | ✅ | ⚠️ browser toasts + SSE; host-level otherwise |
| Agent / automation API | ❌ | ✅ **MCP + REST** (beyond the reference) |
| Cross-platform | Android | macOS / Windows / Linux / FreeBSD (Node) |
| Telemetry / ads / analytics | present | ✅ **none** |
| License | proprietary | MIT |

## What was deliberately not copied

1. **No decompilation.** DEX files were never loaded into a decompiler; the capability list comes from the manifest only.
2. **No resources or assets.** The dashboard is original CSS/SVG; no icon, font, string or layout was lifted.
3. **No protocol reverse-engineering.** No MitM of the reference app, no study of its request signing, scheduling or server APIs.
4. **No circumvention.** DRM/encrypted manifests are detected and refused.
5. **No telemetry reproduction.** Firebase/analytics plumbing has no equivalent here.

## Provenance of this report

Generated from `reference-apks/analyze.py`, which prints package metadata, the permission list, component names and intent filters using `androguard` against the APK's compiled manifest. Re-run it to reproduce every row of the evidence tables above.
