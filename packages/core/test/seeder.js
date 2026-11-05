/**
 * A minimal BitTorrent seeder for tests: one TCP port, one torrent, no tracker.
 * It speaks just enough of the wire protocol (BEP 3) to prove the client's
 * handshake, interested/unchoke, request/piece and SHA-1 verification paths.
 *
 * This is test scaffolding, not a downloader feature: it only *serves* bytes.
 */

import { createServer } from 'node:net';
import { createHash } from 'node:crypto';

export async function startSeeder({ payload, pieceLength, infoHash, infoHashMatches = true }) {
  const pieces = [];
  for (let offset = 0; offset < payload.length; offset += pieceLength) {
    const end = Math.min(offset + pieceLength, payload.length);
    pieces.push(createHash('sha1').update(payload.subarray(offset, end)).digest());
  }

  const served = { handshakes: 0, requests: 0, bytes: 0, aborted: 0 };
  const sockets = new Set();

  const server = createServer((sock) => {
    sockets.add(sock);
    let buf = Buffer.alloc(0);
    let handshaken = false;

    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        if (buf.length < 68) return;
        const theirs = buf.subarray(28, 48);
        if (!theirs.equals(infoHash) && !infoHashMatches) {
          sock.destroy();
          return;
        }
        served.handshakes += 1;
        buf = buf.subarray(68);
        handshaken = true;
        // handshake back
        const hs = Buffer.alloc(68);
        hs.writeUInt8(19, 0);
        hs.write('BitTorrent protocol', 1, 'ascii');
        infoHash.copy(hs, 28);
        Buffer.from('-SEED01-' + '0'.repeat(12)).copy(hs, 48);
        sock.write(hs);
        // bitfield: every piece present
        if (pieces.length) {
          const bytes = Math.ceil(pieces.length / 8);
          const msg = Buffer.alloc(4 + 1 + bytes, 0);
          msg.writeUInt32BE(1 + bytes, 0); // message length = id + payload
          msg[4] = 5; // bitfield
          for (let i = 0; i < pieces.length; i += 1) msg[5 + (i >> 3)] |= 0x80 >> (i & 7);
          sock.write(msg);
        }
        sock.write(Buffer.from([0, 0, 0, 1, 1])); // unchoke
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) return;
        const payloadMsg = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        if (!len) continue;
        const id = payloadMsg[0];
        if (id === 2) {
          // interested → already unchoked, ignore
        } else if (id === 6) {
          const index = payloadMsg.readUInt32BE(1);
          const begin = payloadMsg.readUInt32BE(5);
          const length = payloadMsg.readUInt32BE(9);
          served.requests += 1;
          const start = index * pieceLength + begin;
          const block = payload.subarray(start, Math.min(start + length, payload.length));
          const head = Buffer.alloc(13);
          head.writeUInt32BE(9 + block.length, 0);
          head.writeUInt8(7, 4);
          head.writeUInt32BE(index, 5);
          head.writeUInt32BE(begin, 9);
          served.bytes += block.length;
          sock.write(Buffer.concat([head, block]));
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    peer: { ip: '127.0.0.1', port },
    served,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(resolve);
      }),
  };
}
