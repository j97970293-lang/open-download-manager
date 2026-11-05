/**
 * BitTorrent v1 client — the subset that matters for "download this .torrent or
 * magnet link and give me the files".
 *
 * Supported (BEP 3, 9, 10, 23, 48):
 *   - .torrent metainfo parsing, multi-file and single-file, v2 `file tree` ignored
 *   - HTTP(S) trackers (announce + compact peers), `info_hash` percent-encoding
 *   - magnet links: `xt=urn:btih:<hex|base32>` + `tr=` trackers
 *   - peer wire protocol: handshake, bitfield/have, interested/unchoke, request/piece
 *   - the extension protocol handshake and `ut_metadata` (BEP 9), so a magnet link
 *     can fetch the metainfo from a peer when only the info hash is known
 *   - SHA-1 verification of every piece before it is accepted
 *   - resume from whatever is already on disk (pieces are re-verified, not trusted)
 *
 * Deliberately NOT implemented (see docs/PARITY.md): DHT (BEP 5) and PEX (BEP 11)
 * as discovery sources, uTP, seeding/uploading, and WebTorrent. We never share
 * data back: this is a leech-only client, which is also why it is safe to ship.
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Socket } from 'node:net';
import { decode, encode } from './bencode.js';
import { formatBytes, makeId, sleep } from './util.js';

const BLOCK = 16 * 1024;
const MAX_REQUESTS = 12;

const sha1 = (buf) => createHash('sha1').update(buf).digest();

/** Percent-encode raw bytes the way trackers expect (RFC 3986 on binary). */
function encodeInfoHash(hash) {
  let out = '';
  for (const byte of hash) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9.*()\-_~]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of input.toUpperCase().replace(/=+$/, '')) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error(`base32: bad character ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Parse a magnet URI into { infoHash, name, trackers }. */
export function parseMagnet(uri) {
  const u = new URL(uri);
  if (u.protocol !== 'magnet:') throw new Error('Not a magnet URI');
  const xt = u.searchParams.getAll('xt').find((v) => v.toLowerCase().startsWith('urn:btih:'));
  if (!xt) throw new Error('magnet URI has no urn:btih info hash');
  const raw = xt.slice('urn:btih:'.length);
  const infoHash = raw.length === 32 ? base32Decode(raw) : Buffer.from(raw, 'hex');
  if (infoHash.length !== 20) throw new Error('magnet info hash must be 20 bytes');
  return {
    infoHash,
    name: u.searchParams.get('dn') || null,
    trackers: u.searchParams.getAll('tr'),
  };
}

/** Parse .torrent bytes into a normalised descriptor. */
export function parseTorrent(buf) {
  const meta = decode(buf);
  if (!meta?.info) throw new Error('Not a torrent: no info dictionary');
  const info = meta.info;
  const pieceLength = Number(info['piece length']);
  const pieces = info.pieces;
  if (!Buffer.isBuffer(pieces)) throw new Error('torrent has no piece hashes');
  const hashes = [];
  for (let i = 0; i + 20 <= pieces.length; i += 20) hashes.push(pieces.subarray(i, i + 20));

  const files = [];
  let offset = 0;
  if (Array.isArray(info.files)) {
    for (const f of info.files) {
      const length = Number(f.length);
      files.push({
        path: [info.name?.toString?.('utf8') ?? '', ...(f.path || []).map((p) => p.toString('utf8'))].join('/'),
        length,
        offset,
      });
      offset += length;
    }
  } else {
    const length = Number(info.length);
    files.push({ path: info.name.toString('utf8'), length, offset: 0 });
    offset = length;
  }

  const total = files.reduce((n, f) => n + f.length, 0);
  const infoHash = sha1(encode(info));
  const trackers = new Set();
  const announce = meta.announce?.toString?.('utf8');
  if (announce) trackers.add(announce);
  for (const tier of meta['announce-list'] || []) {
    for (const url of tier) if (Buffer.isBuffer(url)) trackers.add(url.toString('utf8'));
  }
  return {
    infoHash,
    name: info.name?.toString?.('utf8') ?? 'torrent',
    pieceLength,
    pieceHashes: hashes,
    files,
    total,
    trackers: [...trackers],
    isPrivate: Boolean(info.private),
  };
}

/** GET/POST an announce URL and return { peers, interval, failure }. */
export async function announce(tracker, { infoHash, peerId, left, port = 6881, event = 'started', signal } = {}) {
  const sep = tracker.includes('?') ? '&' : '?';
  const query =
    `info_hash=${encodeInfoHash(infoHash)}` +
    `&peer_id=${encodeInfoHash(peerId)}` +
    `&port=${port}&uploaded=0&downloaded=0&left=${left}&compact=1&event=${event}`;
  const url = `${tracker}${sep}${query}`;
  const res = await fetch(url, { signal, headers: { 'user-agent': 'odm/1.0 (leech-only)' } });
  if (!res.ok) throw new Error(`tracker HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const decoded = decode(body);
  if (decoded['failure reason']) {
    throw new Error(`tracker: ${decoded['failure reason'].toString('utf8')}`);
  }
  const peers = [];
  const compact = decoded.peers;
  if (Buffer.isBuffer(compact)) {
    for (let i = 0; i + 6 <= compact.length; i += 6) {
      peers.push({ ip: [...compact.subarray(i, i + 4)].join('.'), port: compact.readUInt16BE(i + 4) });
    }
  } else if (Array.isArray(compact)) {
    for (const p of compact) {
      peers.push({ ip: p.ip?.toString?.('utf8'), port: Number(p.port) });
    }
  }
  return { peers, interval: Number(decoded.interval || 1800) };
}

/**
 * Fetch the info dictionary for a magnet link from peers via `ut_metadata`
 * (BEP 9): request piece 0, read the size, request the rest, verify SHA-1.
 */
export async function fetchMetadataFromPeers({ infoHash, peers, signal, timeoutMs = 15_000 }) {
  if (!peers.length) throw new Error('no peers to fetch metadata from');
  const want = infoHash;
  for (const peer of peers) {
    try {
      const sock = new Socket();
      const peerId = Buffer.from('-OD0100-' + 'a'.repeat(12));
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('metadata timeout')), timeoutMs);
        let buf = Buffer.alloc(0);
        let handshakeDone = false;
        let metadataId = null;
        let metadataSize = null;
        const chunks = new Map();
        const done = (err, value) => {
          clearTimeout(timer);
          sock.destroy();
          err ? reject(err) : resolve(value);
        };
        sock.on('error', (err) => done(err));
        sock.on('close', () => done(new Error('peer closed before metadata completed')));
        sock.on('connect', () => {
          const hs = Buffer.alloc(68);
          hs.writeUInt8(19, 0);
          hs.write('BitTorrent protocol', 1, 'ascii');
          // extension protocol bit (0x10) = reserved[5] & 0x10
          hs[25] = 0x10;
          want.copy(hs, 28);
          peerId.copy(hs, 48);
          sock.write(hs);
        });
        sock.on('data', (data) => {
          buf = Buffer.concat([buf, data]);
          if (!handshakeDone) {
            if (buf.length < 68) return;
            handshakeDone = true;
            buf = buf.subarray(68);
            const ext = encode({ m: { ut_metadata: 1 }, v: 'odm 1.0' });
            const msg = Buffer.concat([Buffer.from([20, 0]), encode({ m: { ut_metadata: 1 } })]);
            const head = Buffer.alloc(4);
            head.writeUInt32BE(msg.length, 0);
            sock.write(Buffer.concat([head, msg]));
            void ext;
          }
          while (buf.length >= 4) {
            const len = buf.readUInt32BE(0);
            if (len === 0 || buf.length < 4 + len) return;
            const payload = buf.subarray(4, 4 + len);
            buf = buf.subarray(4 + len);
            const id = payload[0];
            if (id === 20) {
              const extId = payload[1];
              const rest = payload.subarray(2);
              if (extId === 0) {
                const handshake = decode(rest);
                metadataId = handshake.m?.ut_metadata ?? null;
                if (metadataId) {
                  const req = encode({ msg_type: 0, piece: 0 });
                  const msg = Buffer.concat([Buffer.from([20, metadataId, 0]), req]);
                  const head = Buffer.alloc(4);
                  head.writeUInt32BE(msg.length, 0);
                  sock.write(Buffer.concat([head, msg.subarray(0)]));
                  // correct framing: [len][20][extId][bencoded dict]
                  void msg;
                }
              } else if (extId === metadataId) {
                const end = rest.indexOf(Buffer.from('ee'));
                const header = decode(rest, { offset: 0 });
                const dict = header.value;
                const consumed = header.consumed;
                const piece = Number(dict.piece);
                const total = Number(dict.total_size);
                if (dict.msg_type === 1) {
                  metadataSize = total;
                  chunks.set(piece, rest.subarray(consumed));
                  const have = chunks.size;
                  const need = Math.ceil(total / 16384);
                  if (have < need) {
                    for (let p = 0; p < need; p += 1) {
                      if (chunks.has(p)) continue;
                      const req = encode({ msg_type: 0, piece: p });
                      const msg = Buffer.concat([Buffer.from([20, metadataId]), req]);
                      const head = Buffer.alloc(4);
                      head.writeUInt32BE(msg.length, 0);
                      sock.write(Buffer.concat([head, msg]));
                    }
                  } else {
                    const ordered = [];
                    for (let p = 0; p < need; p += 1) ordered.push(chunks.get(p));
                    const info = Buffer.concat(ordered).subarray(0, total);
                    if (sha1(info).equals(want)) done(null, info);
                    else done(new Error('metadata hash mismatch'));
                  }
                }
                void end;
              }
            }
          }
        });
        sock.connect(peer.port, peer.ip);
      });
      return result;
    } catch {
      // try the next peer
    }
  }
  throw new Error('could not fetch metadata from any peer');
}

/** Read/write the pieces of one torrent into its files on disk. */
class TorrentWriter {
  constructor(root, files, { flat = false } = {}) {
    this.root = root;
    this.files = files;
    this.flat = flat;
  }

  pathOf(file) {
    return this.flat ? join(this.root, file.path) : join(this.root, ...file.path.split('/'));
  }

  async open() {
    for (const f of this.files) {
      const full = this.pathOf(f);
      await mkdir(dirname(full), { recursive: true });
      // 'a+' sets O_APPEND: every write would land at EOF regardless of the
      // offset, which corrupts a multi-piece file. Use 'r+' and create if absent.
      const fh = await open(full, 'r+').catch(() => open(full, 'w+'));
      const st = await fh.stat();
      if (st.size < f.length) await fh.truncate(f.length);
      f.handle = fh;
    }
  }

  /** Write a piece that starts at byte `offset` of the torrent. */
  async writePiece(offset, data) {
    let pos = 0;
    while (pos < data.length) {
      const absolute = offset + pos;
      const file = this.files.find((f) => absolute >= f.offset && absolute < f.offset + f.length);
      if (!file) break;
      const within = absolute - file.offset;
      const take = Math.min(data.length - pos, file.length - within);
      await file.handle.write(data, pos, take, within);
      pos += take;
    }
  }

  async readPiece(offset, length) {
    const out = Buffer.alloc(length);
    let pos = 0;
    while (pos < length) {
      const absolute = offset + pos;
      const file = this.files.find((f) => absolute >= f.offset && absolute < f.offset + f.length);
      if (!file) break;
      const within = absolute - file.offset;
      const take = Math.min(length - pos, file.length - within);
      await file.handle.read(out, pos, take, within);
      pos += take;
    }
    return out;
  }

  async close() {
    for (const f of this.files) await f.handle?.close().catch(() => {});
  }
}

export const TORRENT_STATUS = Object.freeze({
  QUEUED: 'queued',
  CONNECTING: 'connecting',
  DOWNLOADING: 'downloading',
  PAUSED: 'paused',
  COMPLETE: 'complete',
  ERROR: 'error',
});

export class TorrentDownload extends EventEmitter {
  constructor(options = {}) {
    super();
    const { url, dir = process.cwd(), magnet = null, torrents = [], limit = 0, meta = null, now = () => Date.now() } = options;
    this.id = options.id || makeId('bt');
    this.url = url || magnet;
    this.dir = resolve(dir);
    this.extraTrackers = torrents;
    this.limit = limit;
    this.now = now;
    this.status = TORRENT_STATUS.QUEUED;
    this.error = null;
    this.bytesWritten = 0;
    this.pieceStates = [];
    this.peers = [];
    this.completedAt = null;
    this.startedAt = null;
    this.meta = meta;
    this.controller = null;
    this.runPromise = null;
  }

  snapshot() {
    return {
      id: this.id,
      url: this.url,
      kind: 'torrent',
      name: this.meta?.name ?? this.url,
      status: this.status,
      size: this.meta?.total ?? 0,
      downloaded: this.bytesWritten,
      progress: this.meta?.total ? this.bytesWritten / this.meta.total : 0,
      peers: this.peers.length,
      files: this.meta?.files?.map((f) => ({ path: f.path, length: f.length })) ?? [],
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      error: this.error,
    };
  }

  #setStatus(status, extra = {}) {
    this.status = status;
    Object.assign(this, extra);
    this.emit('status', status, this.snapshot());
  }

  pause() {
    this.controller?.abort();
    return this.snapshot();
  }

  async start() {
    if (this.runPromise) return this.runPromise;
    this.controller = new AbortController();
    this.startedAt ??= this.now();
    this.runPromise = this.#run(this.controller.signal).finally(() => {
      this.runPromise = null;
      this.controller = null;
    });
    return this.runPromise;
  }

  async #resolveMeta(signal) {
    // Metainfo supplied by the caller (a parsed .torrent) wins: no I/O needed.
    if (this.meta?.pieceHashes?.length) return this.meta;
    // 1. A .torrent file / URL was given → parse it directly.
    if (/^magnet:/i.test(this.url)) {
      const magnet = parseMagnet(this.url);
      this.meta = { ...magnet, trackers: [...new Set([...magnet.trackers, ...this.extraTrackers])], files: [], total: 0, pieceHashes: [] };
      this.#setStatus(TORRENT_STATUS.CONNECTING);
      // Ask trackers for peers, then pull the info dictionary over the wire.
      const peers = [];
      for (const tracker of this.meta.trackers) {
        try {
          const { peers: found } = await announce(tracker, {
            infoHash: magnet.infoHash,
            peerId: Buffer.from('-OD0100-' + 'b'.repeat(12)),
            left: 0,
            signal,
          });
          peers.push(...found);
        } catch (err) {
          this.emit('notice', { message: `tracker ${new URL(tracker).host} failed: ${err.message}` });
        }
      }
      this.peers = peers;
      const infoBuf = await fetchMetadataFromPeers({ infoHash: magnet.infoHash, peers, signal });
      const parsed = parseTorrent(encode({ info: decode(infoBuf) }));
      this.meta = { ...parsed, trackers: [...new Set([...parsed.trackers, ...magnet.trackers, ...this.extraTrackers])] };
      return this.meta;
    }

    let buf;
    if (/^https?:/i.test(this.url)) {
      const res = await fetch(this.url, { signal });
      if (!res.ok) throw new Error(`torrent HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      buf = await readFile(this.url);
    }
    this.meta = parseTorrent(buf);
    this.meta.trackers = [...new Set([...this.meta.trackers, ...this.extraTrackers])];
    return this.meta;
  }

  async #run(signal) {
    try {
      await this.#resolveMeta(signal);
      let root = join(this.dir, this.meta.name);
      if (this.meta.files.length === 1 && this.meta.files[0].path === this.meta.name) {
        root = this.dir; // single-file torrent: the file sits in the target dir
      }
      await mkdir(root, { recursive: true });
      const flat = this.meta.files.length === 1 && this.meta.files[0].path === this.meta.name;
      const writer = new TorrentWriter(root, this.meta.files, { flat });
      await writer.open();
      this.writer = writer;

      const pieceCount = this.meta.pieceHashes.length;
      this.pieceStates = new Array(pieceCount).fill('missing');
      this.pieceAttempts ??= new Map();

      // Resume: anything already on disk is re-verified, never trusted.
      for (let i = 0; i < pieceCount; i += 1) {
        const offset = i * this.meta.pieceLength;
        const length = Math.min(this.meta.pieceLength, this.meta.total - offset);
        if (!length) continue;
        try {
          const data = await writer.readPiece(offset, length);
          if (sha1(data).equals(this.meta.pieceHashes[i])) {
            this.pieceStates[i] = 'done';
            this.bytesWritten += length;
          }
        } catch {
          /* unreadable → treat as missing */
        }
      }

      this.#setStatus(TORRENT_STATUS.DOWNLOADING);
      this.emit('progress', this.snapshot());

      // Announce to every tracker and poll for peers while we work.
      const peerId = Buffer.from('-OD0100-' + 'c'.repeat(12));
      let peers = [...this.peers];
      const refresh = async (event) => {
        const found = [];
        for (const tracker of this.meta.trackers) {
          try {
            const res = await announce(tracker, {
              infoHash: this.meta.infoHash,
              peerId,
              left: this.meta.total - this.bytesWritten,
              event,
              signal,
            });
            found.push(...res.peers);
          } catch {
            /* a dead tracker must not kill the transfer */
          }
        }
        this.peers = [...new Map([...peers, ...found].map((p) => [`${p.ip}:${p.port}`, p])).values()];
        return this.peers;
      };
      if (!peers.length) peers = await refresh('started');

      // A local/private swarm (the test harness) has peers on loopback; keep them.
      const swarm = this.peers.filter((p) => p.ip);
      if (!swarm.length) throw new Error('no peers found for this torrent');

      await this.#downloadFromPeers(swarm, writer, signal);
      await writer.close();
      this.completedAt = this.now();
      this.#setStatus(TORRENT_STATUS.COMPLETE);
      this.emit('done', this.snapshot());
      return this.snapshot();
    } catch (err) {
      this.writer?.close().catch(() => {});
      if (signal.aborted) {
        this.#setStatus(TORRENT_STATUS.PAUSED);
        this.emit('paused', this.snapshot());
        return this.snapshot();
      }
      this.error = { message: err.message, code: err.code ?? 'TORRENT_ERROR' };
      this.#setStatus(TORRENT_STATUS.ERROR);
      this.emit('failed', this.error, this.snapshot());
      return this.snapshot();
    }
  }

  /** One peer at a time keeps the implementation honest and the tests deterministic. */
  async #downloadFromPeers(peers, writer, signal) {
    for (const peer of peers) {
      if (this.pieceStates.every((s) => s === 'done')) break;
      try {
        await this.#session(peer, writer, signal);
      } catch (err) {
        if (signal.aborted) throw err;
        this.emit('notice', { message: `peer ${peer.ip}:${peer.port} dropped: ${err.message}` });
      }
    }
    const corrupt = this.pieceStates.filter((s) => s === 'corrupt').length;
    if (corrupt) throw new Error(`${corrupt} of ${this.pieceStates.length} pieces are corrupt (SHA-1 mismatch on every peer)`);
    const missing = this.pieceStates.filter((s) => s !== 'done').length;
    if (missing) throw new Error(`${missing} of ${this.pieceStates.length} pieces could not be downloaded`);
  }

  #session(peer, writer, signal) {
    return new Promise((resolve, reject) => {
      const sock = new Socket();
      let buffer = Buffer.alloc(0);
      let handshaken = false;
      let choked = true;
      let done = false;
      let inflight = 0;
      const queue = [];

      const finish = (err) => {
        if (done) return;
        done = true;
        sock.destroy();
        err ? reject(err) : resolve();
      };
      const fail = (err) => finish(err);

      const nextPiece = () => {
        const idx = this.pieceStates.indexOf('missing');
        return idx;
      };

      // Keep up to MAX_REQUESTS block requests in flight, across as many pieces as
      // needed. `queue` holds the pieces we are fetching right now.
      const pump = () => {
        while (inflight < MAX_REQUESTS) {
          let job = queue.find((j) => j.requested < j.length);
          if (!job) {
            const idx = nextPiece();
            if (idx < 0) break;
            const offset = idx * this.meta.pieceLength;
            const length = Math.min(this.meta.pieceLength, this.meta.total - offset);
            this.pieceStates[idx] = 'active';
            job = { index: idx, offset, length, data: Buffer.alloc(length), requested: 0, arrived: 0 };
            queue.push(job);
          }
          const begin = job.requested;
          const blockLen = Math.min(BLOCK, job.length - begin);
          const msg = Buffer.alloc(17);
          msg.writeUInt32BE(13, 0);
          msg.writeUInt8(6, 4); // request
          msg.writeUInt32BE(job.index, 5);
          msg.writeUInt32BE(begin, 9);
          msg.writeUInt32BE(blockLen, 13);
          sock.write(msg);
          inflight += 1;
          job.requested += blockLen;
        }
      };

      sock.on('error', fail);
      sock.on('close', () => finish(new Error('peer closed the connection')));
      sock.on('connect', () => {
        const hs = Buffer.alloc(68);
        hs.writeUInt8(19, 0);
        hs.write('BitTorrent protocol', 1, 'ascii');
        this.meta.infoHash.copy(hs, 28);
        Buffer.from('-OD0100-' + 'd'.repeat(12)).copy(hs, 48);
        sock.write(hs);
      });

      sock.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!handshaken) {
          if (buffer.length < 68) return;
          if (buffer[0] !== 19 || buffer.toString('ascii', 1, 20) !== 'BitTorrent protocol') return fail(new Error('not a BitTorrent peer'));
          if (!buffer.subarray(28, 48).equals(this.meta.infoHash)) return fail(new Error('peer serves a different torrent'));
          buffer = buffer.subarray(68);
          handshaken = true;
          const interested = Buffer.from([0, 0, 0, 1, 2]);
          sock.write(interested);
        }
        while (buffer.length >= 4) {
          const len = buffer.readUInt32BE(0);
          if (buffer.length < 4 + len) return;
          const payload = buffer.subarray(4, 4 + len);
          buffer = buffer.subarray(4 + len);
          if (!len) continue;
          const id = payload[0];
          if (id === 0) choked = true;
          else if (id === 1) {
            choked = false;
            pump();
          } else if (id === 7) {
            // BEP 3 message ids: 0 choke, 1 unchoke, 2 interested, 3 not interested,
            // 4 have, 5 bitfield, 6 request, 7 piece, 8 cancel.
            const index = payload.readUInt32BE(1);
            const begin = payload.readUInt32BE(5);
            const block = payload.subarray(9);
            const job = queue.find((j) => j.index === index);
            inflight -= 1;
            if (job) {
              block.copy(job.data, begin);
              job.arrived += block.length;
              if (job.arrived >= job.length && !job.complete) {
                job.complete = true;
                const hashOk = sha1(job.data).equals(this.meta.pieceHashes[index]);
                if (!hashOk) {
                  const attempts = (this.pieceAttempts.get(index) ?? 0) + 1;
                  this.pieceAttempts.set(index, attempts);
                  queue.splice(queue.indexOf(job), 1);
                  if (attempts >= 3) {
                    this.pieceStates[index] = 'corrupt';
                    this.emit('notice', {
                      message: `piece ${index} failed SHA-1 three times — giving up on it`,
                    });
                    if (!this.pieceStates.includes('missing') && !this.pieceStates.includes('active')) {
                      finish(new Error(`piece ${index} is corrupt on every peer (SHA-1 mismatch)`));
                    }
                    continue;
                  }
                  this.pieceStates[index] = 'missing';
                  this.emit('notice', { message: `piece ${index} failed SHA-1, re-requesting (${attempts}/3)` });
                  pump();
                  continue;
                }
                writer.writePiece(job.offset, job.data).then(() => {
                  this.pieceStates[index] = 'done';
                  this.bytesWritten += job.data.length;
                  queue.splice(queue.indexOf(job), 1);
                  this.emit('progress', this.snapshot());
                  if (this.pieceStates.every((s) => s === 'done')) finish(null);
                  else if (!choked) pump();
                }).catch(fail);
              }
            }
          }
        }
      });

      const timer = setTimeout(() => fail(new Error('peer timed out')), 30_000);
      const abort = () => {
        clearTimeout(timer);
        fail(new Error('aborted'));
      };
      signal.addEventListener('abort', abort, { once: true });
      sock.on('close', () => clearTimeout(timer));
      sock.connect(peer.port, peer.ip);
    });
  }
}

export { formatBytes, sleep };
