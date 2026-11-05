#!/usr/bin/env node
/**
 * odm — command line interface for Open Download Manager.
 *
 *   odm add <url...> [--connections 8] [--limit 2MB] [--dir .] [--checksum sha256:…]
 *   odm list [--json]
 *   odm watch [id]
 *   odm pause <id|all> / resume <id|all> / rm <id> [--delete]
 *   odm grab <pageUrl> [--pick 1]       discover media on a page
 *   odm manifest <m3u8|mpd> [--max-height 720]
 *   odm probe <url>                      show what a server supports
 *   odm mcp                              run the MCP server on stdio
 */

import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
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
  formatDuration,
  sniffFile,
} from '../../../packages/core/src/index.js';
import { open } from 'node:fs/promises';

const HOME = process.env.ODM_HOME || join(homedir(), '.odm');
const CONFIG_PATH = join(HOME, 'config.json');

async function loadConfig() {
  try {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return { dir: join(homedir(), 'Downloads'), connections: 8, maxConcurrent: 3, globalRate: 0 };
  }
}

async function boot() {
  const config = await loadConfig();
  await mkdir(HOME, { recursive: true });
  const store = await new JobStore(join(HOME, 'state')).init();
  const queue = new QueueManager(store, {
    maxConcurrent: config.maxConcurrent ?? 3,
    globalRate: config.globalRate ?? 0,
  });
  for (const task of store.list()) {
    task.on('done', () => queue.tick());
  }
  return { config, store, queue };
}

const color = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => color('2', s);
const bold = (s) => color('1', s);
const green = (s) => color('32', s);
const red = (s) => color('31', s);
const cyan = (s) => color('36', s);
const yellow = (s) => color('33', s);

function bar(p, width = 24) {
  const filled = Math.round(Math.max(0, Math.min(1, p)) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function statusTag(status) {
  switch (status) {
    case STATUS.COMPLETE:
      return green('✓ done');
    case STATUS.DOWNLOADING:
      return cyan('↓ active');
    case STATUS.CONNECTING:
      return cyan('… connecting');
    case STATUS.PAUSED:
      return yellow('⏸ paused');
    case STATUS.ERROR:
      return red('✗ error');
    case STATUS.CANCELED:
      return dim('✕ canceled');
    default:
      return dim('· queued');
  }
}

function printRow(snap) {
  const size = snap.size ? formatBytes(snap.size) : '?';
  const speed = snap.speed ? `${formatBytes(snap.speed)}/s` : '';
  const eta = snap.eta != null ? `ETA ${formatDuration(snap.eta)}` : '';
  console.log(
    `${statusTag(snap.status)} ${bold(snap.filename)}\n` +
      `  ${bar(snap.progress)} ${(snap.progress * 100).toFixed(1).padStart(5)}%  ${formatBytes(snap.downloaded)} / ${size}  ${speed}  ${dim(eta)}\n` +
      `  ${dim(snap.id)} ${dim(snap.connections + ' conns')} ${snap.error ? red('· ' + snap.error.message) : ''}`,
  );
}

function findIds(store, arg) {
  if (arg === 'all') return store.list().map((t) => t.id);
  const ids = store.list().filter((t) => t.id.startsWith(arg)).map((t) => t.id);
  if (!ids.length) throw new Error(`no download matching "${arg}"`);
  return ids;
}

async function waitAll(store) {
  await Promise.all(
    store.list().map(
      (t) =>
        new Promise((res) => {
          if ([STATUS.COMPLETE, STATUS.ERROR, STATUS.CANCELED, STATUS.PAUSED].includes(t.status)) return res();
          t.once('done', res);
          t.once('failed', res);
          t.once('paused', res);
        }),
    ),
  );
}

async function cmdAdd(args, values) {
  const { store, queue, config } = await boot();
  const dir = resolve(values.dir || config.dir || '.');
  await mkdir(dir, { recursive: true });
  const limit = values.limit ? parseSize(values.limit) : 0;
  const created = [];
  for (const url of args) {
    const task = store.add({
      url,
      dir,
      filename: values.output,
      connections: Number(values.connections || config.connections || 8),
      limit,
      checksum: values.checksum,
      priority: Number(values.priority ?? 5),
      headers: values.header ? Object.fromEntries(values.header.map((h) => h.split(/:\s*/, 2))) : {},
      referer: values.referer,
    });
    task.on('retry', (r) => console.error(dim(`  retry #${r.attempt} in ${r.delay}ms (${r.error.message})`)));
    task.on('failed', (err) => console.error(red(`  ${task.filename}: ${err.message}`)));
    created.push(task);
  }
  queue.tick();
  if (values.json) {
    await waitAll(store);
    console.log(JSON.stringify(created.map((t) => t.snapshot()), null, 2));
    return created.every((t) => t.status === STATUS.COMPLETE) ? 0 : 1;
  }
  if (values.quiet) {
    const code = (await waitAll(store), store.list().every((t) => t.status === STATUS.COMPLETE) ? 0 : 1);
    for (const t of created) console.log(`${t.status === STATUS.COMPLETE ? '✓' : '✗'} ${t.path}`);
    return code;
  }
  // live progress table
  const timer = setInterval(() => {
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(bold('Open Download Manager') + dim(`   ${dir}\n`));
    for (const t of created) printRow(t.snapshot());
  }, 500);
  await waitAll(store);
  clearInterval(timer);
  process.stdout.write('\x1b[2J\x1b[H');
  for (const t of created) printRow(t.snapshot());
  return created.every((t) => t.status === STATUS.COMPLETE) ? 0 : 1;
}

async function cmdProbe(args, values) {
  const [url] = args;
  if (!url) throw new Error('usage: odm probe <url>');
  const info = await probeUrl(url, { headers: values.header ? Object.fromEntries(values.header.map((h) => h.split(/:\s*/, 2))) : {} });
  console.log(
    JSON.stringify(
      {
        url,
        finalUrl: info.finalUrl,
        status: info.status,
        size: info.size,
        humanSize: info.size ? formatBytes(info.size) : 'unknown',
        acceptRanges: info.acceptRanges,
        segmentedResume: info.acceptRanges,
        etag: info.etag,
        lastModified: info.lastModified,
        contentType: info.contentType,
        filename: info.filename,
      },
      null,
      2,
    ),
  );
  return info.status < 400 ? 0 : 1;
}

async function cmdGrab(args, values) {
  const [page] = args;
  if (!page) throw new Error('usage: odm grab <pageUrl>');
  const res = await fetch(page, { headers: { 'user-agent': 'Mozilla/5.0 OpenDownloadManager' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${page}`);
  const html = await res.text();
  let items = extractMediaFromHtml(html, res.url || page);
  const head = Buffer.from(html.slice(0, 4096), 'latin1');
  const sniffed = sniffFile(head);
  if (!items.length && sniffed) items = [{ url: res.url || page, kind: 'file', source: 'sniff', mime: sniffed.mime }];
  if (!items.length) {
    console.log('No media found. The page may build its player with JavaScript — open it in a browser and copy the request URL, or pass the direct link.');
    return 1;
  }
  items.forEach((it, i) => console.log(`${String(i + 1).padStart(2)}. [${it.kind}] ${it.url}${it.mime ? dim(` (${it.mime})`) : ''}`));
  if (values.pick) {
    const chosen = items[Number(values.pick) - 1];
    if (!chosen) throw new Error('pick index out of range');
    return cmdAdd([chosen.url], { ...values, referer: page });
  }
  return 0;
}

/** Concatenate an HLS playlist into one file (resumable), then report. */
async function cmdHls(args, values) {
  const { config } = await boot();
  const [url] = args;
  if (!url) throw new Error('usage: odm hls <m3u8-url>');
  const dir = resolve(values.dir || config.dir || '.');
  await mkdir(dir, { recursive: true });
  const job = new ManifestDownload({
    url,
    dir,
    filename: values.output,
    maxHeight: Number(values.maxHeight || Infinity),
    parallel: Number(values.connections || 3),
    limit: values.limit ? parseSize(values.limit) : 0,
    headers: values.header ? Object.fromEntries(values.header.map((h) => h.split(/:\s*/, 2))) : {},
  });
  if (!values.quiet && !values.json) {
    job.on('progress', (snap) => {
      process.stdout.write(
        `\r  ${bar(snap.progress)} ${(snap.progress * 100).toFixed(1).padStart(5)}%  segment ${snap.completedSegments}/${snap.segments}  ${formatBytes(snap.bytesWritten)}  ${formatBytes(snap.speed)}/s   `,
      );
    });
  }
  const snap = await job.start();
  if (!values.quiet && !values.json) process.stdout.write('\n');
  if (values.json) console.log(JSON.stringify(snap, null, 2));
  if (snap.status !== 'complete') {
    console.error(red(`stream failed: ${snap.error?.message || snap.status}`));
    return 1;
  }
  console.log(`${green('✓')} ${snap.path}  ${formatBytes(snap.bytesWritten)} (${snap.segments} segments)`);
  return 0;
}

async function cmdManifest(args, values) {
  const [url] = args;
  if (!url) throw new Error('usage: odm manifest <m3u8|mpd>');
  const manifest = await resolveManifest(url);
  if (manifest.kind === 'hls') {
    console.log(bold(`HLS ${manifest.type}`) + dim(manifest.live ? ' (live)' : ' (vod)') + (manifest.encrypted ? red(' encrypted') : ''));
    for (const v of manifest.variants) {
      console.log(`  ${cyan(v.resolution || '?')} ${formatBytes(v.bandwidth)}/s ${dim(v.codecs || '')} ${v.url}`);
    }
    const chosen = pickVariant(manifest.variants, { maxHeight: Number(values.maxHeight || Infinity) });
    if (values.download && chosen) return cmdHls([chosen.url], values);
    if (values.download && chosen) return cmdHls([chosen.url], values);
  } else {
    console.log(bold(`DASH`) + (manifest.drm ? red(' (protected content — not supported)') : ''));
    if (!manifest.drm) {
      try {
        const { planDash } = await import('../../../packages/core/src/dash.js');
        const plan = planDash(manifest.text, manifest.manifestUrl, { maxHeight: Number(values.maxHeight || Infinity) });
        console.log(dim(`  plan: ${plan.segments.length} segments · ${plan.duration}s · ${plan.representation.height || '?'}p`) + (plan.init ? dim(' · init segment') : ''));
      } catch (err) {
        console.log(red(`  plan failed: ${err.message}`));
      }
    }
    for (const set of manifest.sets) {
      console.log(`  ${set.mimeType || set.contentType || '?'} ${set.lang || ''}`);
      for (const r of set.representations) {
        console.log(`    ${cyan(r.height ? `${r.width}x${r.height}` : '?')} ${formatBytes(r.bandwidth)}/s ${dim(r.id || '')} ${r.url || dim('(segment template)')}`);
      }
    }
    if (values.download && !manifest.drm) return cmdHls([url], values);
  }
  return 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      connections: { type: 'string', short: 'c' },
      limit: { type: 'string', short: 'l' },
      dir: { type: 'string', short: 'd' },
      output: { type: 'string', short: 'o' },
      checksum: { type: 'string' },
      priority: { type: 'string', short: 'p' },
      referer: { type: 'string' },
      header: { type: 'string', multiple: true, short: 'H' },
      json: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      delete: { type: 'boolean' },
      download: { type: 'boolean' },
      pick: { type: 'string' },
      'max-height': { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const values2 = { ...values, maxHeight: values['max-height'] };

  switch (command) {
    case 'add':
    case 'get':
      return cmdAdd(positionals, values2);
    case 'list': {
      const { store } = await boot();
      const list = store.list();
      if (values.json) {
        console.log(JSON.stringify(list.map((t) => t.snapshot()), null, 2));
      } else if (!list.length) {
        console.log(dim('No downloads yet. Try: odm add <url>'));
      } else {
        for (const t of list) printRow(t.snapshot());
      }
      return 0;
    }
    case 'watch': {
      const { store } = await boot();
      const ids = positionals.length ? findIds(store, positionals[0]) : store.list().map((t) => t.id);
      const timer = setInterval(() => {
        process.stdout.write('\x1b[2J\x1b[H');
        for (const id of ids) {
          const t = store.get(id);
          if (t) printRow(t.snapshot());
        }
      }, 400);
      await waitAll(store);
      clearInterval(timer);
      return 0;
    }
    case 'pause': {
      const { store } = await boot();
      for (const id of findIds(store, positionals[0] || 'all')) store.get(id)?.pause();
      console.log('paused');
      return 0;
    }
    case 'resume': {
      const { store, queue } = await boot();
      for (const id of findIds(store, positionals[0] || 'all')) {
        const t = store.get(id);
        t.status = STATUS.QUEUED;
        t.error = null;
      }
      queue.tick();
      await waitAll(store);
      for (const t of store.list()) printRow(t.snapshot());
      return 0;
    }
    case 'rm':
    case 'remove': {
      const { store } = await boot();
      for (const id of findIds(store, positionals[0])) store.remove(id, { deleteFile: values.delete });
      console.log('removed');
      return 0;
    }
    case 'probe':
      return cmdProbe(positionals, values2);
    case 'grab':
      return cmdGrab(positionals, values2);
    case 'manifest':
      return cmdManifest(positionals, values2);
    case 'hls':
    case 'stream':
      return cmdHls(positionals, values2);
    case 'mcp': {
      const { startMcpServer } = await import('../../server/src/mcp.js');
      await startMcpServer();
      return new Promise(() => {}); // keep stdio open
    }
    case 'serve': {
      const { startServer } = await import('../../server/src/server.js');
      const port = Number(values.port || 8420);
      await startServer({ port, host: '0.0.0.0' });
      console.log(`API + dashboard on http://localhost:${port}`);
      return new Promise(() => {});
    }
    case 'doctor': {
      const { store } = await boot();
      const list = store.list();
      console.log(JSON.stringify({ home: HOME, stateDir: join(HOME, 'state'), downloads: list.length, node: process.version }, null, 2));
      return 0;
    }
    default:
      console.log(`Open Download Manager — segmented, resumable, open source

${bold('Usage')}  odm <command> [options]

${bold('Commands')}
  add <url...>            download one or more URLs
  list [--json]           show the queue
  watch [id]              live progress
  pause|resume <id|all>   control transfers
  rm <id|all> [--delete]  remove (optionally delete the file)
  grab <pageUrl>          discover media links on a page
  hls <m3u8-url>          concatenate an HLS stream into one file
  manifest <url>          inspect HLS/DASH manifests
  probe <url>             report size, ranges, etag
  serve [--port 8420]     REST API + web dashboard
  mcp                     Model Context Protocol server (stdio)
  doctor                  show paths and versions

${bold('Download options')}
  -c, --connections N     parallel connections (default 8)
  -l, --limit 2MB         per-download speed cap
  -d, --dir PATH          destination directory
  -o, --output NAME       filename override
      --checksum HASH     sha256:…, md5:… or a bare digest
  -H, --header 'K: V'     extra request header (repeatable)
      --referer URL
  -p, --priority N        1-10, higher starts first

${dim('Examples')}
  odm add https://example.com/big.iso -c 16 -l 5MB
  odm grab https://example.com/watch --pick 2
  odm hls https://cdn.example/master.m3u8 --max-height 720
  odm manifest https://cdn.example/master.m3u8 --max-height 720 --download
`);
      return command ? 1 : 0;
  }
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(red(`error: ${err.message}`));
    if (process.env.ODM_DEBUG) console.error(err.stack);
    process.exit(1);
  },
);
