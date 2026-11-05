#!/usr/bin/env node
/**
 * Model Context Protocol (MCP) server for Open Download Manager.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio profile).
 * This is what lets coding agents — Claude Code, Cursor, Craft Anything, Codex —
 * queue, inspect and steer downloads with the same engine the UI uses.
 *
 * Methods: initialize, tools/list, tools/call, ping, resources/list, prompts/list
 */

import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import {
  JobStore,
  QueueManager,
  ManifestDownload,
  TorrentDownload,
  STATUS,
  probeUrl,
  extractMediaFromHtml,
  resolveManifest,
  pickVariant,
  parseSize,
  formatBytes,
  formatDuration,
} from '../../../packages/core/src/index.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'open-download-manager', version: '1.0.0' };

const TOOLS = [
  {
    name: 'download_add',
    description:
      'Queue one or more URLs for segmented, resumable download. Returns the created job ids. Use connections 8-16 for large files on fast links.',
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'Direct URLs to fetch' },
        dir: { type: 'string', description: 'Destination directory (defaults to ~/Downloads)' },
        connections: { type: 'integer', minimum: 1, maximum: 32, default: 8 },
        limit: { type: 'string', description: 'Per-download speed cap, e.g. "2MB" or "500k"' },
        checksum: { type: 'string', description: 'Expected digest: "sha256:…" or bare hash' },
        referer: { type: 'string' },
        wait: { type: 'boolean', description: 'Block until every job finishes' },
      },
      required: ['urls'],
    },
  },
  {
    name: 'download_list',
    description: 'List every job with progress, speed, ETA, segments and error state.',
    inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
  },
  {
    name: 'download_control',
    description: 'Pause, resume, cancel or delete one job (or "all").',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job id, id prefix, or "all"' },
        action: { type: 'string', enum: ['pause', 'resume', 'cancel', 'remove'] },
        delete_file: { type: 'boolean', default: false },
      },
      required: ['id', 'action'],
    },
  },
  {
    name: 'download_probe',
    description: 'Report a URL\'s size, ETag, MIME type and whether it supports byte ranges (i.e. whether segmented resume is possible).',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'download_grab',
    description: 'Scan an HTML page for downloadable media (video/audio/HLS/DASH/direct files) and return candidates.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'download_manifest',
    description: 'Parse an HLS (.m3u8) or DASH (.mpd) manifest, list variants, and optionally queue the best one.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_height: { type: 'integer', description: 'Cap resolution, e.g. 720' },
        download: { type: 'boolean', description: 'Queue the selected variant' },
      },
      required: ['url'],
    },
  },
  {
    name: 'download_hls',
    description:
      'Concatenate a streaming manifest — HLS (.m3u8, master or media playlist) or DASH (.mpd, SegmentTemplate/SegmentTimeline/SegmentList) — into ONE file on disk, resumably. Picks the best variant under max_height. Refuses encrypted/DRM content.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Manifest URL: .m3u8 (HLS) or .mpd (DASH)' },
        dir: { type: 'string' },
        filename: { type: 'string' },
        max_height: { type: 'integer', description: 'Cap resolution when picking a variant' },
        parallel: { type: 'integer', minimum: 1, maximum: 8, default: 3 },
        wait: { type: 'boolean', description: 'Block until the stream is written' },
      },
      required: ['url'],
    },
  },
  {
    name: 'download_torrent',
    description:
      'Download a .torrent file (local path or http(s) URL) or a magnet link. Leeches only — never uploads. Pieces are SHA-1 verified; verified pieces already on disk are reused.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Path or URL of a .torrent, or a magnet: URI (magnet support needs trackers that return peers)' },
        dir: { type: 'string' },
        wait: { type: 'boolean', description: 'Block until every piece is written' },
      },
      required: ['source'],
    },
  },
  {
    name: 'queue_set',
    description: 'Tune the global queue: max concurrent transfers, global bandwidth cap, pause everything.',
    inputSchema: {
      type: 'object',
      properties: {
        max_concurrent: { type: 'integer', minimum: 1, maximum: 16 },
        global_rate: { type: 'string', description: 'e.g. "10MB"' },
        paused: { type: 'boolean' },
      },
    },
  },
];

function asText(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function describe(snap) {
  return {
    id: snap.id,
    filename: snap.filename,
    status: snap.status,
    progress: Number((snap.progress * 100).toFixed(1)) + '%',
    size: snap.size ? formatBytes(snap.size) : 'unknown',
    downloaded: formatBytes(snap.downloaded),
    speed: snap.speed ? `${formatBytes(snap.speed)}/s` : null,
    eta: snap.eta != null ? formatDuration(snap.eta) : null,
    connections: snap.connections,
    path: snap.path,
    error: snap.error?.message ?? null,
  };
}

export async function createMcpContext({ home = process.env.ODM_HOME || join(process.env.HOME || '.', '.odm') } = {}) {
  const store = await new JobStore(join(home, 'state')).init();
  const queue = new QueueManager(store, { maxConcurrent: 3 });
  for (const task of store.list()) task.on('done', () => queue.tick());
  return { store, queue, home };
}

async function callTool(ctx, name, args) {
  const { store, queue, home } = ctx;
  const findIds = (id) =>
    id === 'all'
      ? store.list().map((t) => t.id)
      : store.list().filter((t) => t.id === id || t.id.startsWith(id)).map((t) => t.id);

  switch (name) {
    case 'download_add': {
      const urls = args.urls || (args.url ? [args.url] : []);
      if (!urls.length) throw new Error('urls is required');
      const dir = args.dir || join(process.env.HOME || '.', 'Downloads');
      const tasks = urls.map((url) =>
        store.add({
          url,
          dir,
          connections: Number(args.connections ?? 8),
          limit: args.limit ? parseSize(args.limit) : 0,
          checksum: args.checksum,
          referer: args.referer,
        }),
      );
      queue.tick();
      if (args.wait) {
        await Promise.all(
          tasks.map(
            (t) =>
              new Promise((res) => {
                if ([STATUS.COMPLETE, STATUS.ERROR, STATUS.CANCELED].includes(t.status)) return res();
                t.once('done', res);
                t.once('failed', res);
              }),
          ),
        );
      }
      return { jobs: tasks.map((t) => describe(t.snapshot())) };
    }
    case 'download_list': {
      let list = store.list().map((t) => t.snapshot());
      if (args.status) list = list.filter((s) => s.status === args.status);
      return {
        count: list.length,
        queue: { maxConcurrent: queue.concurrency, paused: queue.paused, globalRate: queue.globalLimiter.rate },
        downloads: list.map(describe),
      };
    }
    case 'download_control': {
      const ids = findIds(args.id);
      if (!ids.length) throw new Error(`no download matching ${args.id}`);
      for (const id of ids) {
        const task = store.get(id);
        if (!task) continue;
        if (args.action === 'pause') task.pause();
        if (args.action === 'resume') {
          task.status = STATUS.QUEUED;
          task.error = null;
          queue.tick();
        }
        if (args.action === 'cancel') task.cancel();
        if (args.action === 'remove') store.remove(id, { deleteFile: Boolean(args.delete_file) });
      }
      return { affected: ids.length, action: args.action };
    }
    case 'download_probe': {
      const info = await probeUrl(args.url);
      return {
        url: args.url,
        finalUrl: info.finalUrl,
        size: info.size,
        humanSize: info.size ? formatBytes(info.size) : 'unknown',
        acceptRanges: info.acceptRanges,
        segmentedResume: info.acceptRanges,
        etag: info.etag,
        contentType: info.contentType,
        filename: info.filename,
      };
    }
    case 'download_grab': {
      const res = await fetch(args.url, { headers: { 'user-agent': 'Mozilla/5.0 OpenDownloadManager' }, redirect: 'follow' });
      const html = await res.text();
      return { page: res.url || args.url, items: extractMediaFromHtml(html, res.url || args.url) };
    }
    case 'download_manifest': {
      const manifest = await resolveManifest(args.url);
      const best =
        manifest.kind === 'hls'
          ? pickVariant(manifest.variants, { maxHeight: args.max_height || Infinity })
          : manifest.sets?.[0]?.representations?.[0] ?? null;
      let queued = null;
      if (args.download && best?.url) {
        const task = store.add({ url: best.url, dir: join(process.env.HOME || '.', 'Downloads'), connections: 8 });
        queue.tick();
        queued = task.snapshot().id;
      }
      return { kind: manifest.kind, type: manifest.type, best, queued };
    }
    case 'download_hls': {
      const job = new ManifestDownload({
        url: args.url,
        dir: args.dir || join(process.env.HOME || '.', 'Downloads'),
        filename: args.filename,
        maxHeight: args.max_height || Infinity,
        parallel: Number(args.parallel ?? 3),
      });
      const done = job.start();
      if (args.wait) await done;
      const snap = args.wait ? await done : job.snapshot();
      return {
        id: snap.id,
        status: snap.status,
        filename: snap.filename,
        path: snap.path,
        segments: snap.segments,
        completed_segments: snap.completedSegments,
        bytes_written: snap.bytesWritten,
        error: snap.error?.message ?? null,
      };
    }
    case 'download_torrent': {
      const job = new TorrentDownload({ url: args.source, dir: args.dir || join(process.env.HOME || '.', 'Downloads') });
      const done = job.start();
      if (args.wait) await done;
      const snap = args.wait ? await done : job.snapshot();
      return {
        id: snap.id,
        status: snap.status,
        name: snap.name,
        size: snap.size,
        downloaded: snap.downloaded,
        peers: snap.peers,
        files: snap.files,
        error: snap.error?.message ?? null,
      };
    }
    case 'queue_set': {
      if (args.max_concurrent) queue.setMaxConcurrent(args.max_concurrent);
      if (args.global_rate !== undefined) queue.setGlobalRate(args.global_rate ? parseSize(args.global_rate) : 0);
      if (args.paused !== undefined) queue.setPaused(args.paused);
      return { maxConcurrent: queue.concurrency, paused: queue.paused, globalRate: queue.globalLimiter.rate, home };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

/** Handle a single JSON-RPC message; returns the response object or null for notifications. */
export async function handleMessage(ctx, msg) {
  const { id, method, params } = msg || {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

  try {
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
          serverInfo: SERVER_INFO,
          instructions:
            'Open Download Manager exposes a segmented, resumable download engine. Prefer download_probe before large transfers; use download_add with connections 8-16. HLS/DASH: use download_manifest. Never use this server to fetch content you are not licensed to download.',
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments ?? {};
        const result = await callTool(ctx, name, args);
        return reply(asText(result));
      }
      case 'resources/list':
        return reply({
          resources: [
            { uri: 'odm://queue', name: 'Download queue', mimeType: 'application/json' },
            { uri: 'odm://completed', name: 'Completed downloads', mimeType: 'application/json' },
          ],
        });
      case 'resources/read': {
        const uri = params?.uri;
        const list = ctx.store.list().map((t) => describe(t.snapshot()));
        if (uri === 'odm://queue') return reply({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(list, null, 2) }] });
        if (uri === 'odm://completed') {
          const done = list.filter((d) => d.status === STATUS.COMPLETE);
          return reply({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(done, null, 2) }] });
        }
        return fail(-32602, `unknown resource ${uri}`);
      }
      case 'prompts/list':
        return reply({
          prompts: [
            {
              name: 'grab-and-download',
              description: 'Find media on a page, pick the best quality, download it',
              arguments: [{ name: 'url', required: true }],
            },
          ],
        });
      case 'prompts/get':
        return reply({
          description: 'Grab media from a page',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Call download_grab for ${params?.arguments?.url}, then download_manifest on any HLS/DASH result with max_height 1080, then download_add the chosen URL. Summarise the result with download_list.`,
              },
            },
          ],
        });
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return fail(-32603, err.message || String(err));
  }
}

export async function startMcpServer({ home } = {}) {
  const ctx = await createMcpContext({ home });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let sawInitialize = false;
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    if (msg.method === 'initialize') sawInitialize = true;
    if (!sawInitialize && msg.method?.startsWith('tools/')) {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32002, message: 'initialize first' } }) + '\n',
      );
      return;
    }
    const response = await handleMessage(ctx, msg);
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  });
  rl.on('close', () => process.exit(0));
  return ctx;
}

// Allow `node mcp.js` directly as well as import.
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  startMcpServer().catch((err) => {
    process.stderr.write(`odm mcp failed: ${err.message}\n`);
    process.exit(1);
  });
}
