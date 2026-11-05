# Audit report — defects found by static analysis, and their fixes

**Tools used**

| Tool | Version | What it did here |
| --- | --- | --- |
| [REA](https://github.com/morluto/rea) | 6.8.0 | `rea analyze-javascript-application` over the whole repo: 25 files, 28,932 AST nodes, 280-node application graph, 18,445-node semantic graph, 16,298 relations and **7,335 explicit unknowns** with file:line locations |
| [Craft Anything](https://github.com/storytart/craft-anything) | 0.2.0 | `craft-anything-cli --deep js-app-map`: 21 modules, 790 edges, 51 event→handler pairs, storage + network surface |

Neither tool was used to look inside a third-party app: both were pointed at **this
repository** to audit it. That is the intended use — REA turns "I think this is
fine" into "here are the 7,335 places where the static analyser cannot prove it".

## What the graphs confirmed (no action needed)

- 21 modules parsed, 0 parse failures, 0 invalid UTF-8 files.
- Event wiring is complete: **51** emitter→handler edges (tasks, streams, SSE, MCP stdio).
- Network surface matches the design: `EventSource('/api/events')`, `${base}/api/downloads`, `${base}/api/health`, `${base}/api/downloads/:id`.
- Only one storage key (`localStorage: odm-theme`) — no hidden persistence.
- No `TODO`/`FIXME`/`HACK` anywhere in the tree.

## Defects found — all four were real

### 1. Silent file corruption on resume (severity: critical)

`assertResumable()` existed and was exported but **was never called** — the audit
found exactly one occurrence in the tree (its definition). Consequence: if a server
replaced the resource while a download was paused, resuming spliced the old and new
bytes into one file and reported **success**.

*Probe:* pause at 25 %, swap the server payload (same size, new ETag), resume →
`status=complete`, file contained two different byte patterns.

*Fix:* the resume path now re-probes the origin as soon as a segment has advanced and
throws `RESUME_MISMATCH` on ETag/size drift. Test: *"resume refuses a resource whose
ETag changed (no spliced files)"*.

### 2. Silent overwrite of an unrelated file (severity: high)

Two downloads whose server-side filename collided wrote to the same path; the second
destroyed the first with no warning.

*Fix:* `uniquePath()` picks `name (1).ext`, `name (2).ext`, … unless the job already
owns the file (resume keeps its own path). The chosen name is announced via a `notice`
event and persisted (`pathOverride`) so a restart keeps writing to the same file.
Test: *"a second download with the same name never overwrites the first"*.

### 3. URLs with credentials failed outright (severity: medium)

`http://user:pass@host/file` made `fetch` throw `Request cannot be constructed from a
URL that includes credentials` — the task died with `NETWORK_ERROR` before any byte
moved.

*Fix:* `stripCredentials()` in `net.js` moves the user-info into a `Basic` Authorization
header and keeps the credential-free URL in the persisted job. Applies to probing,
ranged streaming and the single-stream path. Test: *"credentials in the URL become an
Authorization header"*.

### 4. A stalled filesystem hung the task forever (severity: high)

No filesystem call had a deadline. A wedged mount (reproduced with a `/proc` path whose
`mkdir` never resolves) left the task in `downloading` with 0 bytes and no error —
indistinguishable from a very slow transfer.

*Fix:*
- `withDiskTimeout()` races every disk call against a deadline (default 30 s, configurable
  per task via `diskTimeoutMs`), and **detaches** the operation so a promise that never
  settles cannot keep the caller alive.
- A destination pre-flight (`#assertDestinationWritable`) writes and removes a probe file
  *before* any network work, so an unusable folder fails in milliseconds instead of after
  a full transfer.
- Typed `DiskError` reaches the UI/API/MCP instead of an unhandled rejection.

Tests: *"a destination that cannot hold files fails fast with DISK_ERROR"* and
*"a filesystem call that never answers is abandoned, not awaited forever"*.

## Missing features the same graphs pointed at

REA's unknowns and Craft Anything's module map both flagged the manifest path as the
weakest part of the codebase (`promise-ownership` and `request` unknown families sat on
`manifest-download.js`). Comparing that against the reference product's declared MIME
filters — `application/dash+xml`, `video/vnd.mpeg.dash.mpd`, `audio/vnd.mpeg.dash.mpd`,
`video/vnd.3gpp.mpd` — exposed a real gap: **DASH was detected, listed, and never
downloadable**. `parseMpd()` stopped at `<Representation>`; nothing expanded a
`<SegmentTemplate>`.

That is now closed by `packages/core/src/dash.js`:

| MPD feature | Support |
| --- | --- |
| `SegmentTemplate` + `$Number$` (zero-padded via `%0Nd`) | ✅ |
| `SegmentTemplate` + `$Time$` | ✅ |
| `$RepresentationID$`, `$Bandwidth$` substitution | ✅ |
| `<SegmentTimeline>` with `@t`, `@d`, `@r` (including `r="-1"`) | ✅ |
| `<SegmentList>` / `<Initialization sourceURL>` | ✅ |
| `<BaseURL>` chains (MPD → Period → Set → Rep → manifest URL) | ✅ |
| `mediaPresentationDuration` / `Period@duration` ISO-8601 | ✅ |
| `<ContentProtection>` | refused with a clear error, never downloaded |
| Multi-period, subtitle/text adaptation sets, live MPD (`type="dynamic")` | ❌ out of scope (documented) |

Three tests and one smoke section cover it, and the demo server now serves a real DASH
ladder (`/demo/manifest.mpd` → `/demo/dash/{init-}v{360,720,1080}-NN.m4s`).

A second bug surfaced while testing: the initialization segment was prepended to **every**
fragment, so a 12-segment stream came out 12 KB too large. The fix (write it only for
segment 0) is asserted by comparing the output length to the exact sum of the parts.

## Also cleaned up

- Three exports were dead code (`headSize`, `formatStamp`, `guessNameFromUrl`); two were
  removed, and the third is now used by the grabber's naming path.
- `DownloadTask.#run()` had its first `await` outside the `try` — a thrown error there
  escaped the task's own error handling. Now inside.

## Test evidence

```console
$ npm test
# tests 22   # pass 22   # fail 0   (7.6 s)
$ npm run smoke
20 checks ─ CLI · probe · grab · manifest · REST · SSE · MCP · HLS ─ PASSED
```

Four of the 22 tests are exactly the defects above; they fail on the previous commit
and pass on this one.

## Reproduce

```bash
rea analyze-javascript-application ./open-download-manager --format json > audit.json
craft-anything-cli --deep js-app-map --input-path ./open-download-manager --output-format json
node -e "const d=require('./audit.json'); console.log(d.normalized_result.semantic_graph.unknowns.length)"
```
