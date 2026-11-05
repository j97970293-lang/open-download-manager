#!/usr/bin/env node
/**
 * End-to-end smoke test: real HTTP server → CLI → REST API → MCP (stdio).
 * Run with `npm run smoke`.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startTestServer } from '../packages/core/test/harness.js';

const run = promisify(execFile);
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CLI = join(ROOT, 'apps/cli/bin/odm.js');
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  process.exitCode = 1;
};

const srv = await startTestServer({ size: 768 * 1024, flaky: 1, ranges: true });
const home = await mkdtemp(join(tmpdir(), 'odm-smoke-'));
const dl = join(home, 'downloads');
await mkdir(dl, { recursive: true });
const env = { ...process.env, ODM_HOME: join(home, 'state-home') };

console.log('\n1. CLI download + checksum + resume');
{
  const { stdout } = await run(process.execPath, [CLI, 'add', srv.url('/file'), '-d', dl, '-c', '4', '--checksum', srv.sha256, '-q'], { env });
  if (stdout.includes('✓')) ok(`odm add completed: ${stdout.trim().split('\n').pop()}`);
  else bad(`odm add output: ${stdout}`);
  const data = await readFile(join(dl, 'payload.bin'));
  createHash('sha256').update(data).digest('hex') === srv.sha256 ? ok('file bytes match server payload') : bad('checksum of saved file differs');
  const { stdout: list } = await run(process.execPath, [CLI, 'list', '--json'], { env });
  JSON.parse(list).length >= 1 ? ok('odm list reports the job') : bad('odm list empty');
}

console.log('\n2. CLI probe / grab / manifest');
{
  const { stdout: probe } = await run(process.execPath, [CLI, 'probe', srv.url('/file')], { env });
  JSON.parse(probe).acceptRanges === true ? ok('probe reports byte-range support') : bad('probe missed ranges');
  const { stdout: grab } = await run(process.execPath, [CLI, 'grab', srv.url('/page')], { env });
  grab.includes('/media/clip.mp4') ? ok('grab found <video>/<source>/og:video links') : bad(`grab output: ${grab}`);
  const { stdout: man } = await run(process.execPath, [CLI, 'manifest', srv.url('/master.m3u8')], { env });
  man.includes('1280x720') ? ok('HLS manifest variants listed') : bad(`manifest: ${man}`);
  const { stdout: mpd } = await run(process.execPath, [CLI, 'manifest', srv.url('/manifest.mpd')], { env });
  mpd.includes('1920x1080') ? ok('DASH manifest representations listed') : bad(`mpd: ${mpd}`);
}

console.log('\n3. REST API + SSE');
{
  const { startServer } = await import('../apps/server/src/server.js');
  const app = await startServer({ port: 0, host: '127.0.0.1', stateDir: join(home, 'api-state'), downloadDir: dl });
  const base = `http://127.0.0.1:${app.port}`;
  const health = await (await fetch(`${base}/api/health`)).json();
  health.ok ? ok('GET /api/health') : bad('health failed');

  const events = [];
  const ac = new AbortController();
  fetch(`${base}/api/events`, { signal: ac.signal }).then(async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        events.push(dec.decode(value));
      }
    } catch {
      /* aborted */
    }
  });

  const created = await (
    await fetch(`${base}/api/downloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls: [srv.url('/file')], dir: dl, connections: 4 }),
    })
  ).json();
  created.created?.length === 1 ? ok('POST /api/downloads queues a job') : bad(`create failed ${JSON.stringify(created)}`);
  const id = created.created[0].id;

  const deadline = Date.now() + 20_000;
  let snap;
  while (Date.now() < deadline) {
    snap = await (await fetch(`${base}/api/downloads/${id}`)).json();
    if (snap.status === 'complete' || snap.status === 'error') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  snap.status === 'complete' ? ok('job reaches complete over REST') : bad(`job status ${snap.status} ${snap.error?.message || ''}`);
  await new Promise((r) => setTimeout(r, 250));
  ac.abort();
  events.some((e) => e.includes('event: progress')) ? ok('SSE streamed progress events') : bad('no SSE progress seen');

  const html = await (await fetch(`${base}/`)).text();
  html.includes('Open Download Manager') ? ok('dashboard HTML served') : bad('dashboard not served');
  const css = await fetch(`${base}/styles.css`);
  css.status === 200 ? ok('dashboard CSS served') : bad('CSS 404');
  await new Promise((r) => app.server.close(r));
}

console.log('\n4. MCP server (stdio JSON-RPC)');
{
  const child = spawn(process.execPath, [join(ROOT, 'apps/server/src/mcp.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
  const wait = (pred, timeout = 15000) =>
    new Promise((res, rej) => {
      let buf = '';
      const t = setTimeout(() => rej(new Error('mcp timeout')), timeout);
      child.stdout.on('data', (d) => {
        buf += d.toString();
        for (const line of buf.split('\n')) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (pred(msg)) {
              clearTimeout(t);
              res(msg);
            }
          } catch {
            /* partial */
          }
        }
      });
    });

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke' } } });
  const init = await wait((m) => m.id === 1);
  init.result?.serverInfo?.name === 'open-download-manager' ? ok('initialize handshake') : bad('initialize failed');

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = await wait((m) => m.id === 2);
  tools.result.tools.length >= 6 ? ok(`${tools.result.tools.length} MCP tools advertised`) : bad('too few tools');

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'download_probe', arguments: { url: srv.url('/file') } } });
  const probeCall = await wait((m) => m.id === 3);
  const payload = JSON.parse(probeCall.result.content[0].text);
  payload.acceptRanges ? ok('tools/call download_probe works') : bad('probe tool returned no ranges');

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'download_add', arguments: { urls: [srv.url('/file')], dir: dl, connections: 2, wait: true } } });
  const addCall = await wait((m) => m.id === 4, 25_000);
  const added = JSON.parse(addCall.result.content[0].text);
  added.jobs[0].status === 'complete' ? ok('agent-driven download completes via MCP') : bad(`mcp add status ${added.jobs[0].status}`);
  child.kill();
}

console.log('\n5. HLS concatenation (CLI)');
{
  const hlsDir = join(home, 'hls');
  await mkdir(hlsDir, { recursive: true });
  const res = await run(process.execPath, [CLI, 'hls', srv.url('/hls/master.m3u8'), '-d', hlsDir, '--max-height', '720', '-q'], { env }).catch((e) => ({ stdout: e.stdout || '', stderr: e.stderr || '' }));
  const { stdout } = res;
  if (res.stderr) console.log('   stderr:', res.stderr.trim());
  if (stdout.includes('segments')) ok(`odm hls wrote one file: ${stdout.trim()}`);
  else bad(`odm hls output: ${stdout}`);
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(hlsDir);
  const ts = files.find((f) => f.endsWith('.ts'));
  ts ? ok(`playlist concatenated to ${ts}`) : bad(`no .ts output: ${files}`);
  if (ts) {
    const body = await readFile(join(hlsDir, ts), 'utf8');
    const ordered = body.indexOf('SEGMENT-high-0-') < body.indexOf('SEGMENT-high-4-');
    body.includes('SEGMENT-high-4-') && ordered ? ok('segments written in order') : bad('segment order wrong');
  }
}

console.log('\n6. DASH concatenation (CLI)');
{
  const dashDir = join(home, 'dash');
  await mkdir(dashDir, { recursive: true });
  const res = await run(process.execPath, [CLI, 'hls', srv.url('/manifest.mpd'), '-d', dashDir, '--max-height', '720', '-q'], { env }).catch((e) => ({ stdout: e.stdout || '', stderr: e.stderr || '' }));
  if (res.stderr) console.log('   stderr:', res.stderr.trim());
  res.stdout.includes('segments') ? ok(`odm hls handled a DASH manifest: ${res.stdout.trim()}`) : bad(`odm hls DASH output: ${res.stdout}`);
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(dashDir);
  files.some((f) => f.endsWith('.mp4')) ? ok(`DASH representation saved as ${files.find((f) => f.endsWith('.mp4'))}`) : bad(`no DASH output: ${files}`);
}

await srv.close();
await rm(home, { recursive: true, force: true });
console.log(process.exitCode ? '\n\x1b[31mSMOKE FAILED\x1b[0m\n' : '\n\x1b[32mSMOKE PASSED\x1b[0m\n');
