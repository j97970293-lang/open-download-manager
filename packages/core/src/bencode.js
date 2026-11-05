/**
 * bencode — the serialisation used by .torrent files and tracker responses
 * (BEP 3). Integers, byte strings, lists and dictionaries; dictionaries are
 * encoded with sorted keys, as the spec requires.
 *
 * Decoding returns Buffers for byte strings (not strings) because `pieces` and
 * `info_hash` are binary and must not be mangled by a UTF-8 round trip.
 */

export function encode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') return encode(Buffer.from(value, 'utf8'));
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TypeError(`bencode: non-integer number ${value}`);
    return Buffer.from(`i${value}e`);
  }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(encode), Buffer.from('e')]);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = [Buffer.from('d')];
    for (const key of keys) parts.push(encode(key), encode(value[key]));
    parts.push(Buffer.from('e'));
    return Buffer.concat(parts);
  }
  if (typeof value === 'boolean') return encode(value ? 1 : 0);
  throw new TypeError(`bencode: cannot encode ${typeof value}`);
}

export function decode(input, { offset = 0 } = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const read = (pos) => {
    const c = buf[pos];
    if (c === undefined) throw new Error('bencode: unexpected end of data');
    if (c === 0x69) {
      // 'i'
      const end = buf.indexOf(0x65, pos + 1);
      if (end < 0) throw new Error('bencode: unterminated integer');
      const n = Number(buf.subarray(pos + 1, end).toString('ascii'));
      if (!Number.isFinite(n)) throw new Error('bencode: bad integer');
      return [n, end + 1];
    }
    if (c === 0x6c) {
      // 'l'
      const out = [];
      let p = pos + 1;
      while (buf[p] !== 0x65) {
        if (p >= buf.length) throw new Error('bencode: unterminated list');
        const [v, next] = read(p);
        out.push(v);
        p = next;
      }
      return [out, p + 1];
    }
    if (c === 0x64) {
      // 'd'
      const out = {};
      let p = pos + 1;
      while (buf[p] !== 0x65) {
        if (p >= buf.length) throw new Error('bencode: unterminated dict');
        const [k, nextK] = read(p);
        const key = Buffer.isBuffer(k) ? k.toString('utf8') : String(k);
        const [v, nextV] = read(nextK);
        out[key] = v;
        p = nextV;
      }
      return [out, p + 1];
    }
    // byte string: <len>:<bytes>
    const colon = buf.indexOf(0x3a, pos);
    if (colon < 0) throw new Error('bencode: malformed string length');
    const len = Number(buf.subarray(pos, colon).toString('ascii'));
    if (!Number.isInteger(len) || len < 0) throw new Error('bencode: bad string length');
    const start = colon + 1;
    const end = start + len;
    if (end > buf.length) throw new Error('bencode: string overruns data');
    return [buf.subarray(start, end), end];
  };
  const [value, consumed] = read(offset);
  return offset === 0 ? value : { value, consumed };
}
