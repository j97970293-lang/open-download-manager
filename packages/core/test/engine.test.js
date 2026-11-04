import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { startTestServer } from './harness.js';
import {
  DownloadTask,
  JobStore,
  QueueManager,
  STATUS,
  parseContentRange,
  planRanges,
  sanitizeFilename,
  formatBytes,
  parseSize,
  extractMediaFromHtml,
  parseM3u8,
  parseMpd,
  pickVariant,
  parseChecksum,
  probeUrl,
  TokenBucket,
} from '../src/index.js';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const tmp = () => mkdtemp(join(tmpdir(), 'odm-'));

test('utility helpers behave', () => {
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(parseSize('2.5 MB'), 2621440);
  assert.equal(parseSize('10k'), 10240);
  assert.deepEqual(planRanges(10, 3), [[0, 3], [4, 6], [7, 9]]);
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFilename('a/b\\c*.zip'), 'c_.zip');
  assert.equal(parseContentRange('bytes 0-1023/4096').total, 4096);
  assert.equal(parseChecksum('a'.repeat(64)).algorithm, 'sha256');
  assert.equal(parseChecksum('md5:' + 'b'.repeat(32)).algorithm, 'md5');
});

test('token bucket shapes throughput', async () => {
  let fake = 0;
  const bucket = new TokenBucket(1000, { now: () => fake });
  assert.equal(bucket.take(400), 400);
  assert.equal(bucket.take(1000), 600);
  assert.ok(bucket.delayFor(100) > 0);
  fake += 1000;
  assert.equal(bucket.take(1000), 1000);
});

test('probe detects ranges, size, etag, filename', async () => {
  const srv = await startTestServer({ size: 64 * 1024, filename: 'thing.bin' });
  try {
    const info = await probeUrl(srv.url('/file'));
    assert.equal(info.size, 64 * 1024);
    assert.equal(info.acceptRanges, true);
    assert.equal(info.filename, 'thing.bin');
    assert.ok(info.etag);
    const noRange = await probeUrl(srv.url('/plain')); // serves 200 w/o ranges
    assert.equal(noRange.acceptRanges, false);
  } finally {
    await srv.close();
  }
});

test('multi-connection download produces byte-identical file', async () => {
  const dir = await tmp();
  const srv = await startTestServer({ size: 1024 * 1024, chunkSize: 8 * 1024 });
  try {
    const task = new DownloadTask({ url: srv.url('/file'), dir, connections: 8 });
    const snap = await task.start();
    assert.equal(snap.status, STATUS.COMPLETE);
    assert.equal(snap.progress, 1);
    const data = await readFile(join(dir, task.filename));
    assert.equal(data.length, 1024 * 1024);
    assert.equal(sha(data), srv.sha256);
    const rangeHits = srv.hits.filter((h) => h.range).length;
    assert.ok(rangeHits >= 8, `expected >=8 ranged requests, saw ${rangeHits}`);
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
  }
});

test('download survives a server without range support', async () => {
  const dir = await tmp();
  const srv = await startTestServer({ size: 200 * 1024, ranges: false });
  try {
    const notices = [];
    const task = new DownloadTask({ url: srv.url('/file'), dir, connections: 8 });
    task.on('notice', (n) => notices.push(n));
    const snap = await task.start();
    assert.equal(snap.status, STATUS.COMPLETE);
    assert.equal(sha(await readFile(join(dir, task.filename))), srv.sha256);
    assert.equal(notices.length, 1);
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
  }
});

test('pause then resume continues from the same offsets', async () => {
  const dir = await tmp();
  const srv = await startTestServer({ size: 1024 * 1024, chunkDelayMs: 2, chunkSize: 16 * 1024 });
  try {
    const task = new DownloadTask({ url: srv.url('/file'), dir, connections: 4 });
    const run = task.start();
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (task.downloaded > 128 * 1024) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
    task.pause();
    const paused = await run;
    assert.equal(paused.status, STATUS.PAUSED);
    const before = task.segments.map((s) => s.cursor);
    assert.ok(before.some((c, i) => c > task.segments[i].start), 'some segments advanced before pause');

    const resumed = await task.resume();
    assert.equal(resumed.status, STATUS.COMPLETE);
    assert.equal(sha(await readFile(join(dir, task.filename))), srv.sha256);
    // No segment restarted from zero after resume.
    const cursorCeiling = task.segments.map((s) => s.cursor);
    for (let i = 0; i < before.length; i += 1) {
      assert.ok(cursorCeiling[i] >= before[i], 'cursor never goes backwards');
    }
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
  }
});

test('state persists and a new process-like store resumes the job', async () => {
  const dir = await tmp();
  const storeDir = await tmp();
  const srv = await startTestServer({ size: 512 * 1024, chunkDelayMs: 2 });
  try {
    const store1 = await new JobStore(storeDir).init();
    const task = store1.add({ url: srv.url('/file'), dir, connections: 4 }, { start: false });
    const run = store1.start(task.id);
    await new Promise((resolve) => {
      const t = setInterval(() => {
        if (task.downloaded > 64 * 1024) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });
    task.pause();
    await run;
    await store1.persist();

    const store2 = await new JobStore(storeDir).init();
    const [restored] = store2.list();
    assert.equal(restored.id, task.id);
    assert.equal(restored.status, STATUS.PAUSED);
    assert.ok(restored.segments.every((s) => s.cursor >= s.start));
    const done = await restored.resume();
    assert.equal(done.status, STATUS.COMPLETE);
    assert.equal(sha(await readFile(join(dir, restored.filename))), srv.sha256);
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
    await rm(storeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
  }
});

test('checksum verification rejects a bad hash', async () => {
  const dir = await tmp();
  const srv = await startTestServer({ size: 128 * 1024 });
  try {
    const bad = new DownloadTask({ url: srv.url('/file'), dir, connections: 2, checksum: 'sha256:' + 'f'.repeat(64) });
    const snap = await bad.start();
    assert.equal(snap.status, STATUS.ERROR);
    assert.equal(snap.error.code, 'CHECKSUM_MISMATCH');

    const good = new DownloadTask({ url: srv.url('/file'), dir, connections: 2, checksum: srv.sha256 });
    const ok = await good.start();
    assert.equal(ok.status, STATUS.COMPLETE);
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
  }
});

test('retries a dropped connection to completion', async () => {
  const dir = await tmp();
  const srv = await startTestServer({ size: 256 * 1024, flaky: 2, ranges: false });
  try {
    const task = new DownloadTask({ url: srv.url('/flaky'), dir, connections: 1, maxRetries: 5 });
    const snap = await task.start();
    assert.equal(snap.status, STATUS.COMPLETE, JSON.stringify(snap.error));
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
  }
});

test('follows redirects and keeps server filename', async () => {
  const dir = await tmp();
  const srv = await startTestServer({ size: 32 * 1024, filename: 'report.pdf' });
  try {
    const task = new DownloadTask({ url: srv.url('/redirect'), dir });
    const snap = await task.start();
    assert.equal(snap.status, STATUS.COMPLETE);
    assert.equal(task.filename, 'report.pdf');
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
  }
});

test('404 surfaces a non-retryable HttpError', async () => {
  const dir = await tmp();
  const srv = await startTestServer({});
  try {
    const task = new DownloadTask({ url: srv.url('/missing'), dir });
    const snap = await task.start();
    assert.equal(snap.status, STATUS.ERROR);
    assert.equal(snap.error.code, 'HTTP_404');
    assert.equal(snap.error.retryable, false);
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
  }
});

test('queue respects priority order and concurrency cap', async () => {
  const dir = await tmp();
  const storeDir = await tmp();
  const srv = await startTestServer({ size: 128 * 1024, chunkDelayMs: 2 });
  try {
    const store = await new JobStore(storeDir).init();
    const queue = new QueueManager(store, { maxConcurrent: 1, autostart: false });
    store.add({ url: srv.url('/file'), dir, filename: 'low.bin', priority: 1, connections: 2 }, { start: false });
    store.add({ url: srv.url('/file'), dir, filename: 'high.bin', priority: 9, connections: 2 }, { start: false });
    const started = [];
    queue.on('start', (s) => started.push(s.filename));
    for (const task of store.list()) {
      task.on('done', () => queue.tick());
    }
    let maxParallel = 0;
    const sampler = setInterval(() => {
      const n = store.list().filter((t) => t.status === STATUS.DOWNLOADING).length;
      maxParallel = Math.max(maxParallel, n);
    }, 5);
    queue.autostart = true;
    queue.tick();
    await new Promise((resolve) => {
      const t = setInterval(() => {
        if (store.list().every((x) => x.status === STATUS.COMPLETE)) {
          clearInterval(t);
          resolve();
        }
      }, 20);
    });
    clearInterval(sampler);
    assert.deepEqual(started, ['high.bin', 'low.bin']);
    assert.equal(maxParallel, 1, 'only one transfer may run at a time with maxConcurrent=1');
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
    await rm(storeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 });
  }
});

test('media grabber finds video sources in HTML', () => {
  const html = `<html><head><meta property="og:video" content="/v/og.mp4"></head>
    <body><video src="https://cdn.example/a/clip.mp4?x=1"></video>
    <source src="/v/clip.webm" type="video/webm"><a href="/docs/manual.pdf">pdf</a>
    <script>var src = "https://cdn.example/hls/master.m3u8";</script></body></html>`;
  const found = extractMediaFromHtml(html, 'https://site.example/watch/1');
  const urls = found.map((f) => f.url);
  assert.ok(urls.includes('https://cdn.example/a/clip.mp4?x=1'));
  assert.ok(urls.includes('https://site.example/v/clip.webm'));
  assert.ok(urls.includes('https://site.example/v/og.mp4'));
  assert.ok(urls.includes('https://cdn.example/hls/master.m3u8'));
  assert.ok(urls.includes('https://site.example/docs/manual.pdf'));
  assert.equal(found.find((f) => f.url.includes('master.m3u8')).kind, 'hls');
});

test('HLS and DASH manifests parse and rank variants', () => {
  const hls = parseM3u8(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360\na.m3u8\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\nb.m3u8\n',
    'https://cdn.example/master.m3u8',
  );
  assert.equal(hls.type, 'master');
  assert.equal(hls.variants[0].height, 1080);
  assert.equal(hls.variants[0].url, 'https://cdn.example/b.m3u8');
  assert.equal(pickVariant(hls.variants, { maxHeight: 720 }).height, 360);

  const media = parseM3u8('#EXTM3U\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\nseg2.ts\n#EXT-X-ENDLIST', 'https://c/x/i.m3u8');
  assert.equal(media.type, 'media');
  assert.equal(media.segments.length, 2);
  assert.equal(media.live, false);

  const mpd = parseMpd(
    '<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation id="a" bandwidth="1" width="640" height="360"><BaseURL>360.mp4</BaseURL></Representation>' +
      '<Representation id="b" bandwidth="9" width="1920" height="1080"><BaseURL>1080.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>',
    'https://cdn.example/m.mpd',
  );
  assert.equal(mpd.sets[0].representations[0].height, 1080);
  assert.ok(!mpd.drm);
});
