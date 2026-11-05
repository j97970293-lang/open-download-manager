/**
 * DASH (MPEG-DASH) segment expansion.
 *
 * `media.js` parses an MPD into adaptation sets and representations; this module
 * turns the chosen representation into an ordered list of URLs that can be
 * concatenated byte-for-byte. It covers the three addressing modes the format
 * defines, which is what every non-DRM MPD in the wild uses:
 *
 *   1. SegmentTemplate + $Number$   (numbered segments: seg-1.m4s, seg-2.m4s …)
 *   2. SegmentTemplate + $Time$     (time-addressed: the common on-demand form)
 *   3. SegmentTemplate with $RepresentationID$ / $Bandwidth$ substitutions
 *   4. SegmentList                   (explicit <SegmentURL media="…"/> list)
 *   5. the trivial case              (one file per representation via BaseURL)
 *
 * Timelines are honoured: SegmentTimeline /@t and /@d with the /@r repeat count
 * (including r="-1", "repeat until Period end"), so the generated URL count
 * matches what the encoder produced instead of guessing.
 *
 * No DRM: a manifest carrying <ContentProtection> is refused upstream.
 */

import { parseAttributes, parseMpd } from './media.js';

const fill = (template, vars) =>
  template.replace(/\$(\w+)(?:%0(\d+)d)?\$/g, (whole, name, width) => {
    if (name === 'RepresentationID') return vars.id ?? '';
    if (name === 'Bandwidth') return String(vars.bandwidth ?? 0);
    if (name === 'Number') return String(vars.number ?? 0).padStart(Number(width) || 1, '0');
    if (name === 'Time') return String(vars.time ?? 0);
    return whole;
  });

function readIsoDuration(value) {
  const m = /^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(value || '');
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m.map((v) => (v ? Number(v) : 0));
  return (((y * 365 + mo * 30 + d) * 24 + h) * 60 + mi) * 60 + s;
}

/** Expand <SegmentTimeline> into [{ time, duration }] honouring @r repeats. */
export function expandTimeline(timelineXml, periodDuration = 0) {
  const out = [];
  let cursor = null;
  for (const seg of timelineXml.matchAll(/<S\b([^>]*)\/?>/gi)) {
    const attrs = parseAttributes(seg[1]);
    const d = Number(attrs.d || 0);
    let t = attrs.t != null ? Number(attrs.t) : cursor ?? 0;
    if (attrs.t != null || cursor == null) cursor = t;
    const repeat = Number(attrs.r ?? 0);
    if (!d) continue;
    if (repeat === -1) {
      // "repeat until the end of the period"
      const limit = periodDuration ? periodDuration * 1000 : t + d;
      let guard = 0;
      while (t < limit && guard < 100_000) {
        out.push({ time: t, duration: d });
        t += d;
        guard += 1;
      }
    } else {
      for (let i = 0; i <= repeat; i += 1) {
        out.push({ time: t, duration: d });
        t += d;
      }
    }
    cursor = t;
  }
  return out;
}

const attr = (xml, name, fallback = undefined) => {
  const r = new RegExp(`<${name}\\b([^>]*)>`, 'i').exec(xml);
  return r ? parseAttributes(r[1]) : fallback;
};
const single = (xml, tag) => new RegExp(`<${tag}\\b([^>]*?)\\/?>`, 'i').exec(xml)?.[1];

/**
 * Pick the representation to download and return its ordered segment URLs.
 *
 * @param {string} xml            the raw MPD text
 * @param {string} baseUrl        the URL the MPD was fetched from
 * @param {{maxHeight?:number, prefer?:'best'|'worst', content?:'video'|'audio'|'any'}} opts
 * @returns {{segments:{url:string,init?:string|null}[], init:string|null, representation:object, duration:number}}
 */
export function planDash(xml, baseUrl, { maxHeight = Infinity, prefer = 'best', content = 'any' } = {}) {
  const mpd = parseMpd(xml, baseUrl);
  const periodXml = /<Period\b[^>]*>([\s\S]*?)<\/Period>/i.exec(xml)?.[1] ?? xml;
  // The MPD attribute is `mediaPresentationDuration` (CamelCase); Periods use `duration`.
  const mpdAttrs = attr(xml, 'MPD', {});
  const periodDuration = readIsoDuration(attr(xml, 'Period', {}).duration || '');
  const mpdDuration = readIsoDuration(mpdAttrs.mediapresentationduration || mpdAttrs.duration || '');

  const wanted = (set) => {
    const kind = (set.contentType || set.mimeType || '').toLowerCase();
    if (content === 'video') return kind.includes('video');
    if (content === 'audio') return kind.includes('audio');
    return true;
  };
  const sets = mpd.sets.filter(wanted);
  const pool = sets.length ? sets : mpd.sets;

  // Flatten reps, keep the set they came from so we can read its templating.
  const reps = [];
  for (const set of pool) for (const rep of set.representations) reps.push({ ...rep, set });
  if (!reps.length) throw new Error('DASH manifest exposes no representation');
  const sorted = [...reps].sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth);
  const capped = prefer === 'worst' ? sorted.at(-1) : (sorted.filter((r) => !r.height || r.height <= maxHeight)[0] ?? sorted.at(-1));

  // Representation-level XML block (templating may live inside it or in the set).
  const repBlock =
    new RegExp(`<Representation\\b[^>]*\\b(?:id="${capped.id}"|bandwidth="${capped.bandwidth}")[^>]*>([\\s\\S]*?)<\\/Representation>`, 'i').exec(xml)?.[1] ?? '';
  let setXml = '';
  for (const m of xml.matchAll(/<AdaptationSet\b[^>]*>([\s\S]*?)<\/AdaptationSet>/gi)) {
    if (m[1].includes(`id="${capped.id}"`) || m[1].includes(`bandwidth="${capped.bandwidth}"`)) {
      setXml = m[1];
      break;
    }
  }
  const scope = repBlock || setXml;

  // Every URL in an MPD is relative to <BaseURL> (MPD → Period → Set → Rep), which
  // is itself relative to the manifest URL.
  const abs = (u) => (u ? new URL(u, root).href : null);
  const docBase = /<BaseURL>\s*([^<]+?)\s*<\/BaseURL>/i.exec(xml)?.[1];
  const root = docBase ? new URL(docBase, baseUrl).href : baseUrl;

  const tmpl = attr(scope, 'SegmentTemplate', {});
  const init = (() => {
    if (tmpl.initialization) return abs(fill(tmpl.initialization, { id: capped.id, bandwidth: capped.bandwidth }));
    const el = attr(scope, 'Initialization', {})?.sourceurl;
    if (el) return abs(fill(el, { id: capped.id, bandwidth: capped.bandwidth }));
    const sb = attr(scope, 'SegmentBase', {})?.initialization;
    if (sb) return abs(sb);
    return null;
  })();
  const base = capped.url ? abs(capped.url) : null;
  const segments = [];

  if (tmpl && (tmpl.media || tmpl.initialization)) {
    const timeline = /<SegmentTimeline\b[^>]*>([\s\S]*?)<\/SegmentTimeline>/i.exec(scope)?.[1];
    const startNumber = Number(tmpl.startnumber || 1);
    const media = tmpl.media || '';
    if (timeline) {
      const entries = expandTimeline(timeline, periodDuration || mpdDuration);
      entries.forEach((entry, i) => {
        segments.push({
          url: abs(fill(media, { id: capped.id, bandwidth: capped.bandwidth, number: startNumber + i, time: entry.time })),
        });
      });
    } else {
      const duration = Number(tmpl.duration || 0);
      const total = periodDuration || mpdDuration;
      const count = duration && total ? Math.ceil(total / duration) : 1;
      for (let i = 0; i < count; i += 1) {
        const number = startNumber + i;
        segments.push({
          url: abs(fill(media, { id: capped.id, bandwidth: capped.bandwidth, number, time: (number - startNumber) * duration })),
        });
      }
    }
  } else {
    const list = /<SegmentList\b[^>]*>([\s\S]*?)<\/SegmentList>/i.exec(scope)?.[1];
    if (list) {
      for (const m of list.matchAll(/<SegmentURL\b([^>]*)\/?>/gi)) {
        const u = parseAttributes(m[1]).media;
        if (u) segments.push({ url: abs(u) });
      }
    } else if (base) {
      segments.push({ url: base });
    }
  }

  if (!segments.length) throw new Error('DASH representation did not yield any segment URL');
  return {
    segments: segments.map((s) => (s.init ? s : { ...s, init })),
    init,
    duration: periodDuration || mpdDuration,
    representation: { id: capped.id, bandwidth: capped.bandwidth, width: capped.width, height: capped.height, codecs: capped.codecs, mimeType: capped.mimeType },
  };
}

/** Human summary used by `odm manifest --json` and the MCP tools. */
export function describeDash(xml, baseUrl) {
  const mpd = parseMpd(xml, baseUrl);
  return {
    kind: 'dash',
    duration: (() => {
      const a = attr(xml, 'MPD', {});
      return readIsoDuration(a.mediapresentationduration || a.duration || '');
    })(),
    drm: mpd.drm,
    sets: mpd.sets.map((s) => ({
      type: s.contentType || s.mimeType,
      lang: s.lang,
      representations: s.representations.map((r) => `${r.height ? `${r.height}p ` : ''}${r.codecs || ''} ${Math.round((r.bandwidth || 0) / 1000)}kbps`.trim()),
    })),
  };
}
