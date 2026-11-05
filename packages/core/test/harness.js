/**
 * Tiny deterministic HTTP server used by the test-suite and by `npm run demo`.
 * Supports: HEAD, ranged GET (206), no-range mode, chunked slow responses,
 * flaky connections (to exercise retries), ETag/Last-Modified, redirects,
 * Content-Disposition, and basic auth.
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

/** Generate a reproducible pseudo-random payload. */
export function makePayload(size, seed = 42) {
  const buf = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i += 1) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

export async function startTestServer(options = {}) {
  const {
    size = 512 * 1024,
    seed = 42,
    ranges = true,
    chunkDelayMs = 0,
    chunkSize = 16 * 1024,
    flaky = 0, // number of connections to abort mid-stream
    auth = null, // "user:pass"
    filename = 'payload.bin',
    routes = {}, // extra exact-path routes: { '/x.mpd': { body, type } }
  } = options;

  const payload = makePayload(size, seed);
  const sha256 = createHash('sha256').update(payload).digest('hex');
  let flakyLeft = flaky;
  let requests = 0;
  const hits = [];

  const server = createServer(async (req, res) => {
    requests += 1;
    hits.push({ method: req.method, url: req.url, range: req.headers.range || null });

    const extra = routes[req.url];
    if (extra) {
      const body = Buffer.isBuffer(extra.body) ? extra.body : Buffer.from(String(extra.body));
      res.writeHead(extra.status ?? 200, {
        'content-type': extra.type || 'application/octet-stream',
        'content-length': body.length,
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(body);
    }

    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/file' });
      res.end();
      return;
    }
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<!doctype html><html><head><meta property="og:video" content="/media/clip.mp4"></head>
         <body><video src="/media/clip.mp4"><source src="/media/clip.webm" type="video/webm"></video>
         <a href="/files/doc.pdf">pdf</a></body></html>`,
      );
      return;
    }
    if (req.url === '/master.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow/index.m3u8\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720\nhigh/index.m3u8\n',
      );
      return;
    }
    if (req.url === '/hls/master.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360\n/hls/low/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720\n/hls/high/index.m3u8\n');
      return;
    }
    if (req.url === '/hls/high/index.m3u8' || req.url === '/hls/low/index.m3u8') {
      const n = req.url.includes('/low/') ? 2 : 5;
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-PLAYLIST-TYPE:VOD'];
      for (let i = 0; i < n; i += 1) lines.push('#EXTINF:4.0,', `/hls/${req.url.includes('/low/') ? 'low' : 'high'}/seg${i}.ts`);
      lines.push('#EXT-X-ENDLIST');
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end(lines.join('\n'));
      return;
    }
    if (req.url.startsWith('/hls/high/seg') || req.url.startsWith('/hls/low/seg')) {
      const name = req.url.split('/').pop().replace('.ts', '');
      const idx = Number(name.replace('seg', ''));
      const body = Buffer.from(`SEGMENT-${req.url.includes('/low/') ? 'low' : 'high'}-${idx}-` + 'x'.repeat(1000 + idx * 7));
      res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': body.length });
      res.end(body);
      return;
    }
    if (req.url === '/hls/drm/index.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n');
      return;
    }
    if (req.url === '/manifest.mpd') {
      res.writeHead(200, { 'content-type': 'application/dash+xml' });
      res.end(
        '<MPD mediaPresentationDuration="PT8S"><Period duration="PT8S"><AdaptationSet mimeType="video/mp4" contentType="video">' +
          '<Representation id="v0" bandwidth="900000" width="640" height="360"><BaseURL>v0.mp4</BaseURL></Representation>' +
          '<Representation id="v1" bandwidth="3000000" width="1920" height="1080"><BaseURL>v1.mp4</BaseURL></Representation>' +
          '</AdaptationSet></Period></MPD>',
      );
      return;
    }
    if (req.url === '/v0.mp4' || req.url === '/v1.mp4') {
      const body = Buffer.from(String(req.url).repeat(64));
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': body.length });
      return res.end(body);
    }
    if (req.url === '/flaky' && req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size, 'accept-ranges': 'none' });
      res.end();
      return;
    }
    if (req.url === '/flaky') {
      // Drops the connection after 3 chunks, `flaky` times in total.
      if (flakyLeft > 0) {
        flakyLeft -= 1;
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size, 'accept-ranges': 'none' });
        let sent = 0;
        while (sent < payload.length) {
          const piece = payload.subarray(sent, Math.min(sent + chunkSize, payload.length));
          res.write(piece);
          sent += piece.length;
          if (sent >= chunkSize * 3) {
            setTimeout(() => res.destroy(), 5);
            return;
          }
        }
        res.end();
        return;
      }
    }
    if (req.url.startsWith('/auth') && auth) {
      const header = req.headers.authorization || '';
      const expected = `Basic ${Buffer.from(auth).toString('base64')}`;
      if (header !== expected) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="test"' });
        res.end('unauthorized');
        return;
      }
    }
    if (req.url === '/plain') {
      // 200, correct Content-Length, but explicitly refuses ranges.
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size, 'accept-ranges': 'none' });
      if (req.method === 'GET') await sendRange(res, payload, 0, size - 1, chunkSize, chunkDelayMs);
      else res.end();
      return;
    }
    if (req.url === '/missing') {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    if (req.url.startsWith('/media/')) {
      // Small fake media file so grabber tests can actually transfer it.
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 11 * 1024 });
      res.end(payload.subarray(0, 11 * 1024));
      return;
    }
    if (!req.url.startsWith('/file') && !req.url.startsWith('/auth') && !req.url.startsWith('/flaky')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const etag = `"${sha256.slice(0, 16)}"`;
    const baseHeaders = {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${filename}"`,
      etag,
      'last-modified': new Date(1700000000000).toUTCString(),
    };

    if (req.method === 'HEAD') {
      res.writeHead(200, { ...baseHeaders, 'content-length': size, 'accept-ranges': ranges ? 'bytes' : 'none' });
      res.end();
      return;
    }

    const range = req.headers.range;
    if (ranges && range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...baseHeaders,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
      });
      if (req.method === 'GET') await sendRange(res, payload, start, end, chunkSize, chunkDelayMs);
      else res.end();
      return;
    }

    res.writeHead(200, { ...baseHeaders, 'content-length': size });
    if (req.method === 'GET') await sendRange(res, payload, 0, size - 1, chunkSize, chunkDelayMs);
    else res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    url: (p = '/file') => `${base}${p}`,
    sha256,
    payload,
    hits,
    get requests() {
      return requests;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };

  async function sendRange(res, data, start, end, piece, delay) {
    let cursor = start;
    while (cursor <= end) {
      const next = Math.min(cursor + piece, end + 1);
      const ok = res.write(data.subarray(cursor, next));
      cursor = next;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      else if (!ok) await new Promise((r) => res.once('drain', r));
      if (res.destroyed) return;
    }
    res.end();
  }
}
