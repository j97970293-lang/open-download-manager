/**
 * REST + Server-Sent-Events API for Open Download Manager.
 *
 * Zero runtime dependencies: node:http router, JSON bodies, SSE progress stream.
 * Serves the web dashboard from apps/web/public.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JobStore,
  QueueManager,
  DownloadTask,
  ManifestDownload,
  STATUS,
  probeUrl,
  extractMediaFromHtml,
  resolveManifest,
  pickVariant,
  parseSize,
  formatBytes,
} from '../../../packages/core/src/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB_ROOT = resolve(HERE, '../../web/public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const originOf = (req) => `http://${req.headers.host || 'localhost'}`;

export async function createApp({ stateDir, downloadDir } = {}) {
  const home = process.env.ODM_HOME || resolve(process.env.HOME || '.', '.odm');
  downloadDir = downloadDir || process.env.ODM_DOWNLOAD_DIR || join(process.env.HOME || '.', 'Downloads');
  const store = await new JobStore(stateDir || join(home, 'state')).init();
  const queue = new QueueManager(store, { maxConcurrent: 3 });
  for (const task of store.list()) task.on('done', () => queue.tick());

  const manifestJobs = new Map();
  const sseClients = new Set();
  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(payload);
  };
  for (const task of store.list()) {
    task.on('progress', (snap) => broadcast('progress', snap));
    task.on('status', (status, snap) => broadcast('status', { status, ...snap }));
    task.on('done', (snap) => {
      broadcast('done', snap);
      queue.tick();
    });
    task.on('failed', (err, snap) => broadcast('failed', { ...snap, error: err }));
  }

  const json = (res, code, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(payload);
  };

  const readBody = async (req, limit = 1_000_000) => {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) throw new Error('body too large');
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      return res.end();
    }

    // ---- API ----
    if (path === '/api/health')
      return json(res, 200, { ok: true, version: '1.0.0', uptime: process.uptime(), demo: process.env.ODM_DEMO === '1' });

    if (path === '/api/downloads' && method === 'GET') {
      return json(res, 200, {
        downloads: [...store.list().map((t) => t.snapshot()), ...[...manifestJobs.values()].map((j) => j.snapshot())],
        queue: { maxConcurrent: queue.concurrency, paused: queue.paused, globalRate: queue.globalLimiter.rate },
      });
    }

    if (path === '/api/downloads' && method === 'POST') {
      const body = await readBody(req);
      const urls = Array.isArray(body.urls) ? body.urls : body.url ? [body.url] : [];
      if (!urls.length) return json(res, 400, { error: 'url or urls[] is required' });
      const created = [];
      const streams = [];
      for (const u of urls) {
        if (body.kind === 'hls' || /\.m3u8(\?|$)/i.test(u)) {
          const job = new ManifestDownload({
            url: u,
            dir: body.dir || downloadDir,
            maxHeight: body.maxHeight || Infinity,
            parallel: Number(body.connections ?? 3),
            limit: body.limit ? parseSize(body.limit) : 0,
          });
          manifestJobs.set(job.id, job);
          job.on('progress', (snap) => broadcast('progress', snap));
          job.on('status', (status, snap) => broadcast('status', { status, ...snap }));
          job.on('done', (snap) => broadcast('done', snap));
          job.on('failed', (err, snap) => broadcast('failed', { ...snap, error: err }));
          streams.push(job);
          created.push(job.snapshot());
          continue;
        }
        const task = store.add({
          url: u,
          dir: body.dir || downloadDir || join(process.env.HOME || '.', 'Downloads'),
          connections: Number(body.connections ?? 8),
          limit: body.limit ? parseSize(body.limit) : 0,
          checksum: body.checksum,
          filename: body.filename,
          referer: body.referer,
          priority: Number(body.priority ?? 5),
        });
        task.on('progress', (s) => broadcast('progress', s));
        task.on('status', (status, s) => broadcast('status', { status, ...s }));
        task.on('done', (s) => {
          broadcast('done', s);
          queue.tick();
        });
        task.on('failed', (err, s) => broadcast('failed', { ...s, error: err }));
        created.push(task.snapshot());
      }
      for (const job of streams) job.start().catch(() => {});
      queue.tick();
      return json(res, 201, { created });
    }

    const idMatch = /^\/api\/downloads\/([^/]+)(?:\/(pause|resume|cancel|limit))?$/.exec(path);
    if (idMatch) {
      const [, id, action] = idMatch;
      const stream = manifestJobs.get(id);
      if (stream) {
        if (method === 'GET') return json(res, 200, stream.snapshot());
        if (method === 'DELETE') {
          stream.pause();
          manifestJobs.delete(id);
          return json(res, 200, { removed: id });
        }
        if (method === 'POST' && action === 'pause') {
          stream.pause();
          return json(res, 200, stream.snapshot());
        }
        if (method === 'POST' && action === 'resume') {
          stream.resume();
          return json(res, 200, stream.snapshot());
        }
        if (method === 'POST' && action === 'cancel') {
          stream.pause();
          manifestJobs.delete(id);
          return json(res, 200, { canceled: id });
        }
        return json(res, 405, { error: 'method not allowed' });
      }
      const task = store.get(id);
      if (!task) return json(res, 404, { error: 'not found' });
      if (method === 'GET' && !action) return json(res, 200, task.snapshot());
      if (method === 'DELETE' && !action) {
        store.remove(id, { deleteFile: url.searchParams.get('delete') === '1' });
        return json(res, 200, { removed: id });
      }
      if (method === 'POST' && action === 'pause') {
        task.pause();
        return json(res, 200, task.snapshot());
      }
      if (method === 'POST' && action === 'resume') {
        task.status = STATUS.QUEUED;
        task.error = null;
        queue.tick();
        return json(res, 200, task.snapshot());
      }
      if (method === 'POST' && action === 'cancel') {
        task.cancel({ deleteFile: url.searchParams.get('delete') === '1' });
        return json(res, 200, task.snapshot());
      }
      if (method === 'POST' && action === 'limit') {
        const body = await readBody(req);
        task.setLimit(body.limit ? parseSize(body.limit) : 0);
        return json(res, 200, task.snapshot());
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    if (path === '/api/queue' && method === 'PATCH') {
      const body = await readBody(req);
      if (body.maxConcurrent) queue.setMaxConcurrent(body.maxConcurrent);
      if (body.globalRate !== undefined) queue.setGlobalRate(body.globalRate ? parseSize(body.globalRate) : 0);
      if (body.paused !== undefined) queue.setPaused(body.paused);
      return json(res, 200, { maxConcurrent: queue.concurrency, paused: queue.paused, globalRate: queue.globalLimiter.rate });
    }

    if (path === '/api/probe' && method === 'POST') {
      const body = await readBody(req);
      if (!body.url) return json(res, 400, { error: 'url required' });
      try {
        const info = await probeUrl(body.url);
        return json(res, 200, {
          url: body.url,
          finalUrl: info.finalUrl,
          size: info.size,
          humanSize: info.size ? formatBytes(info.size) : 'unknown',
          acceptRanges: info.acceptRanges,
          segmentedResume: info.acceptRanges,
          etag: info.etag,
          contentType: info.contentType,
          filename: info.filename,
          status: info.status,
        });
      } catch (err) {
        return json(res, 502, { error: err.message });
      }
    }

    if (path === '/api/grab' && method === 'POST') {
      const body = await readBody(req);
      if (!body.url) return json(res, 400, { error: 'url required' });
      try {
        const r = await fetch(body.url, { headers: { 'user-agent': 'Mozilla/5.0 OpenDownloadManager' }, redirect: 'follow' });
        const contentType = r.headers.get('content-type') || '';
        if (!contentType.includes('html')) {
          return json(res, 200, { items: [{ url: r.url || body.url, kind: 'file', source: 'direct', mime: contentType }] });
        }
        const html = await r.text();
        return json(res, 200, { page: r.url || body.url, items: extractMediaFromHtml(html, r.url || body.url) });
      } catch (err) {
        return json(res, 502, { error: err.message });
      }
    }

    if (path === '/api/manifest' && method === 'POST') {
      const body = await readBody(req);
      try {
        const manifest = await resolveManifest(body.url);
        const best = manifest.kind === 'hls' ? pickVariant(manifest.variants, { maxHeight: body.maxHeight || Infinity }) : null;
        return json(res, 200, { ...manifest, best });
      } catch (err) {
        return json(res, 502, { error: err.message });
      }
    }

    if (path === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ downloads: store.list().map((t) => t.snapshot()) })}\n\n`);
      sseClients.add(res);
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
      });
      return;
    }

    // ---- deterministic demo endpoints (ODM_DEMO=1 only) ----
    if (process.env.ODM_DEMO === '1' && path === '/demo/file') {
      const mb = Math.max(1, Math.min(512, Number(url.searchParams.get('mb') || 120)));
      const delay = Math.max(0, Math.min(200, Number(url.searchParams.get('delay') || 18)));
      const piece = 32 * 1024;
      const total = mb * 1024 * 1024;
      const name = url.searchParams.get('name') || `demo-${mb}mb.bin`;
      const seed = Number(url.searchParams.get('seed') || 7);
      const headers = {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"`,
        'accept-ranges': 'bytes',
        etag: `"demo-${mb}-${seed}"`,
      };
      const range = req.headers.range;
      let start = 0;
      let end = total - 1;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${total}` });
      } else {
        res.writeHead(200, { ...headers, 'content-length': total });
      }
      if (req.method === 'HEAD') return res.end();
      let x = ((start + seed) >>> 0) || 1;
      let cursor = start;
      const pump = async () => {
        while (cursor <= end) {
          const size = Math.min(piece, end - cursor + 1);
          const buf = Buffer.allocUnsafe(size);
          for (let i = 0; i < size; i += 1) {
            x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
            buf[i] = x & 0xff;
          }
          if (!res.write(buf)) await new Promise((r) => res.once('drain', r));
          cursor += size;
          if (delay) await new Promise((r) => setTimeout(r, delay));
          if (res.destroyed) return;
        }
        res.end();
      };
      pump().catch(() => res.destroy());
      return;
    }

    if (process.env.ODM_DEMO === '1' && path === '/demo/page') {
      const html = `<!doctype html><html><head><title>Demo gallery</title>
        <meta property="og:video" content="/demo/file?mb=12&name=trailer-1080p.mp4"></head><body>
        <h1>Demo gallery</h1>
        <video src="/demo/file?mb=12&name=trailer-1080p.mp4" controls></video>
        <audio src="/demo/file?mb=3&name=podcast-ep12.mp3"></audio>
        <a href="/demo/file?mb=6&name=dataset.csv">dataset.csv</a>
        </body></html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (process.env.ODM_DEMO === '1' && path === '/demo/master.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480\n/demo/file?mb=8&name=480p.mp4\n#EXT-X-STREAM-INF:BANDWIDTH=3200000,RESOLUTION=1920x1080\n/demo/file?mb=20&name=1080p.mp4\n');
    }

    if (process.env.ODM_DEMO === '1' && path === '/demo/seed' && method === 'POST') {
      const plan = [
        { url: `${originOf(req)}/demo/file?mb=160&delay=45&name=ubuntu-demo.iso`, connections: 8 },
        { url: `${originOf(req)}/demo/file?mb=90&delay=40&name=photo-archive.zip`, connections: 6 },
        { url: `${originOf(req)}/demo/file?mb=40&delay=22&name=product-tour-1080p.mp4`, connections: 4 },
        { url: `${originOf(req)}/demo/file?mb=6&delay=40&name=changelog.json`, connections: 2 },
      ];
      const seeded = [];
      for (const item of plan) {
        const t = store.add({ url: item.url, dir: downloadDir, connections: item.connections, referer: `${originOf(req)}/demo/page` });
        t.on('progress', (snap) => broadcast('progress', snap));
        t.on('status', (status, snap) => broadcast('status', { status, ...snap }));
        t.on('done', (snap) => { broadcast('done', snap); queue.tick(); });
        t.on('failed', (err, snap) => broadcast('failed', { ...snap, error: err }));
        seeded.push(t.snapshot().id);
      }
      queue.tick();
      return json(res, 201, { seeded });
    }

    // ---- static dashboard ----
    if (method === 'GET') {
      const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
      const target = safe === '/' || safe === '\\' ? '/index.html' : safe;
      const file = join(WEB_ROOT, target);
      if (!file.startsWith(WEB_ROOT)) return json(res, 403, { error: 'forbidden' });
      try {
        const info = await stat(file);
        if (info.isFile()) {
          const data = await readFile(file);
          res.writeHead(200, {
            'content-type': MIME[extname(file)] || 'application/octet-stream',
            'content-length': data.length,
            'cache-control': 'no-cache',
          });
          return res.end(data);
        }
      } catch {
        /* fall through to 404 */
      }
    }

    return json(res, 404, { error: 'not found', path });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: err.message });
      else res.end();
    });
  });

  return { server, store, queue, sseClients };
}

export async function startServer({ port = 8420, host = '0.0.0.0', stateDir, downloadDir } = {}) {
  const app = await createApp({ stateDir, downloadDir });
  await new Promise((resolveP, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, resolveP);
  });
  const addr = app.server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return { ...app, port: actualPort, url: `http://${host}:${actualPort}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8420);
  startServer({ port, host: '0.0.0.0' }).then(({ url }) => {
    console.log(`Open Download Manager API + dashboard → ${url}`);
  });
}
