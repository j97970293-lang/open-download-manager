/**
 * Media grabber (clean-room).
 *
 * Generic, standards-based discovery only:
 *   - HTML scan for <video>, <source>, <audio>, og:video, meta links
 *   - direct media extensions, HLS (.m3u8) and DASH (.mpd) manifests
 *   - HLS/DASH variant selection by resolution/bandwidth
 * No DRM circumvention, no protocol reverse-engineering of private apps.
 */

import { filenameFromUrl, sanitizeFilename, makeId } from './util.js';

const MEDIA_EXT = /\.(mp4|m4v|webm|mkv|mov|avi|flv|ts|m4s|mp3|m4a|aac|flac|ogg|oga|opus|wav|webp|png|jpe?g|gif|pdf|zip|7z|rar|tar|gz|iso|dmg|exe|msi|apk|xpi|deb|rpm)(\?|#|$)/i;

export function classifyUrl(url) {
  const clean = url.split('#')[0];
  const path = clean.split('?')[0].toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  if (/\.(mp4|m4v|webm|mkv|mov|avi|flv)$/.test(path)) return 'video';
  if (/\.(mp3|m4a|aac|flac|ogg|oga|opus|wav)$/.test(path)) return 'audio';
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(path)) return 'image';
  if (MEDIA_EXT.test(path)) return 'file';
  return 'unknown';
}

export function isMediaUrl(url) {
  const kind = classifyUrl(url);
  return kind === 'hls' || kind === 'dash' || kind === 'video' || kind === 'audio';
}

function absolutize(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/** Extract candidate media URLs from an HTML document. */
export function extractMediaFromHtml(html, pageUrl) {
  const found = new Map();
  const push = (url, extra = {}) => {
    const abs = absolutize(url, pageUrl);
    if (!abs) return;
    if (!found.has(abs)) found.set(abs, { url: abs, kind: classifyUrl(abs), ...extra });
  };

  const attrs = (tag, re) => {
    for (const m of html.matchAll(re)) push(m[1]);
  };

  for (const m of html.matchAll(/<video\b[^>]*>/gi)) {
    const tag = m[0];
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (src) push(src[1], { source: 'video' });
  }
  for (const m of html.matchAll(/<source\b[^>]*>/gi)) {
    const tag = m[0];
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (src) push(src[1], { source: 'source', mime: type?.[1] });
  }
  for (const m of html.matchAll(/<audio\b[^>]*>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (src) push(src[1], { source: 'audio' });
  }
  attrs('meta', /<meta[^>]+property=["']og:(?:video|audio)(?::url|:secure_url)?["'][^>]+content=["']([^"']+)["']/gi);
  attrs('meta', /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:(?:video|audio)["']/gi);
  for (const m of html.matchAll(/"(https?:[^"\\]+?\.(?:m3u8|mpd|mp4|webm|mp3|m4a)(?:\?[^"\\]*)?)"/gi)) {
    push(m[1], { source: 'script' });
  }
  for (const m of html.matchAll(/'(https?:[^'\\]+?\.(?:m3u8|mpd|mp4|webm|mp3|m4a)(?:\?[^'\\]*)?)'/gi)) {
    push(m[1], { source: 'script' });
  }
  for (const m of html.matchAll(/<a\b[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
    const abs = absolutize(m[1], pageUrl);
    if (abs && MEDIA_EXT.test(abs.split('?')[0]) && classifyUrl(abs) !== 'unknown') {
      push(m[1], { source: 'link' });
    }
  }
  return [...found.values()].filter((item) => item.kind !== 'unknown');
}

export function parseAttributes(line) {
  const out = {};
  for (const m of line.matchAll(/([A-Za-z0-9_-]+)=("([^"]*)"|'([^']*)'|[^,\s]+)/g)) {
    const raw = m[3] ?? m[4] ?? m[2];
    out[m[1].toLowerCase()] = String(raw).replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

/** Parse an HLS master playlist into variants; a media playlist yields one stream. */
export function parseM3u8(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const variants = [];
  const segments = [];
  let pending = null;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      continue;
    }
    if (pending && !line.startsWith('#')) {
      const attrs = pending;
      pending = null;
      const resolution = attrs.resolution || '';
      const [width, height] = resolution.split('x').map(Number);
      variants.push({
        url: absolutize(line, baseUrl),
        bandwidth: Number(attrs['average-bandwidth'] || attrs.bandwidth || 0),
        resolution,
        width: width || null,
        height: height || null,
        codecs: attrs.codecs || null,
      });
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      if (attrs.uri) segments.push({ init: absolutize(attrs.uri, baseUrl) });
      continue;
    }
    if (!line.startsWith('#')) {
      const url = absolutize(line, baseUrl);
      if (url) segments.push({ url });
    }
  }
  const isMaster = variants.length > 0;
  return {
    type: isMaster ? 'master' : 'media',
    variants: variants.sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth),
    segments,
    live: /#EXT-X-ENDLIST/.test(text) ? false : true,
    encrypted: /#EXT-X-KEY:METHOD=(?!NONE)/.test(text),
  };
}

/** Parse a DASH MPD into adaptation sets + representations. */
export function parseMpd(xml, baseUrl) {
  const docBase = /<BaseURL>\s*([^<]+?)\s*<\/BaseURL>/i.exec(xml)?.[1];
  const root = docBase ? absolutize(docBase, baseUrl) : baseUrl;
  const sets = [];
  for (const block of xml.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi)) {
    const setAttrs = parseAttributes(block[1]);
    const reps = [];
    for (const rep of block[2].matchAll(/<Representation\b([^>]*?)(\/>|>([\s\S]*?)<\/Representation>)/gi)) {
      const attrs = parseAttributes(rep[1]);
      const body = rep[3] ?? '';
      const base = /<BaseURL>\s*([^<]+?)\s*<\/BaseURL>/i.exec(body)?.[1];
      reps.push({
        id: attrs.id ?? null,
        bandwidth: Number(attrs.bandwidth || 0),
        width: Number(attrs.width || 0) || null,
        height: Number(attrs.height || 0) || null,
        codecs: attrs.codecs || null,
        mimeType: attrs.mimetype || setAttrs.mimetype || null,
        url: base ? absolutize(base, root) : null,
      });
    }
    sets.push({
      mimeType: setAttrs.mimetype || null,
      contentType: setAttrs.contenttype || null,
      lang: setAttrs.lang || null,
      representations: reps.sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth),
    });
  }
  return { type: 'dash', sets, drm: /<ContentProtection\b/i.test(xml) };
}

/**
 * Expand a manifest into a "virtual size" plan: total byte length is unknown
 * until fetched, so the caller downloads fragments sequentially and reports
 * fragment progress instead of bytes.
 */
export async function resolveManifest(url, { headers, signal } = {}) {
  const res = await fetch(url, { headers, signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`Manifest HTTP ${res.status}`);
  const text = await res.text();
  const finalUrl = res.url || url;
  if (/\.m3u8(\?|$)/i.test(finalUrl) || /^#EXTM3U/m.test(text.trim())) {
    return { kind: 'hls', ...parseM3u8(text, finalUrl), manifestUrl: finalUrl };
  }
  if (/\.mpd(\?|$)/i.test(finalUrl) || /<MPD\b/i.test(text)) {
    return { kind: 'dash', ...parseMpd(text, finalUrl), manifestUrl: finalUrl };
  }
  throw new Error('Not a recognised HLS/DASH manifest');
}

/** Choose the best variant for a user preference (height cap, else highest). */
export function pickVariant(variants, { maxHeight = Infinity, prefer = 'best' } = {}) {
  const usable = variants.filter((v) => v.url);
  if (!usable.length) return null;
  if (prefer === 'worst') return usable.at(-1);
  const capped = usable.filter((v) => !v.height || v.height <= maxHeight);
  return capped[0] ?? usable.at(-1);
}

/** Build a .m3u8 index that concatenates segments, for players/archival. */
export function buildMediaPlaylist(segments, { init } = {}) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10', '#EXT-X-PLAYLIST-TYPE:VOD'];
  if (init) lines.push(`#EXT-X-MAP:URI="${init}"`);
  for (const seg of segments) {
    if (!seg.url) continue;
    lines.push('#EXTINF:10,', seg.url);
  }
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

export function guessNameFromUrl(url, fallback = 'media') {
  return sanitizeFilename(filenameFromUrl(url, fallback));
}

export { makeId };
