/**
 * Open Download Manager — dashboard client.
 * Vanilla ES module, no build step. Talks to the local REST API and
 * subscribes to the SSE stream for live segment progress.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  downloads: new Map(),
  filter: 'all',
  speedHistory: new Array(60).fill(0),
  maxSpeed: 1,
  paused: false,
};

const fmtBytes = (n) => {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
};

const fmtTime = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s left`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s left`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m left`;
};

function toast(message, kind = 'info', ttl = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 220);
  }, ttl);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ── rendering ─────────────────────────────────────────────── */

const template = $('#job-template');

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}

function renderJob(snap) {
  if (snap.kind === 'manifest') return renderStream(snap);
  let li = $(`[data-id="${CSS.escape(snap.id)}"]`);
  if (!li) {
    li = template.content.firstElementChild.cloneNode(true);
    li.dataset.id = snap.id;
    $('#jobs').append(li);
    li.style.animationDelay = `${Math.min(state.downloads.size, 6) * 30}ms`;
  }
  li.dataset.status = snap.status;
  $('.job-name', li).textContent = snap.filename;
  $('.job-name', li).title = snap.path;
  const pill = $('.status-pill', li);
  pill.dataset.s = snap.status;
  pill.textContent = snap.status;
  $('.host', li).textContent = hostOf(snap.url);
  $('.dims', li).textContent = snap.size ? `${fmtBytes(snap.size)} · ${snap.connections} conns` : `${snap.connections} conns`;

  const bar = $('.segbar', li);
  const wanted = Math.max(1, snap.segments?.length || snap.connections || 1);
  if (bar.children.length !== wanted) {
    bar.replaceChildren(
      ...Array.from({ length: wanted }, () => {
        const seg = document.createElement('span');
        seg.className = 'seg';
        seg.append(document.createElement('i'));
        return seg;
      }),
    );
  }
  const segs = snap.segments?.length ? snap.segments : null;
  [...bar.children].forEach((el, i) => {
    const seg = segs?.[i];
    let p = 0;
    if (seg) p = seg.progress;
    else if (snap.status === 'complete') p = 1;
    else p = snap.progress;
    const fill = $('i', el);
    fill.style.width = `${Math.max(0, Math.min(1, p)) * 100}%`;
    el.classList.toggle('active', seg ? seg.status === 'active' : snap.status === 'downloading');
  });

  $('.pct', li).textContent = `${(snap.progress * 100).toFixed(snap.progress === 1 ? 0 : 1)}%`;
  $('.amounts', li).textContent = `${fmtBytes(snap.downloaded)} / ${snap.size ? fmtBytes(snap.size) : 'unknown'}`;
  $('.speed', li).textContent = snap.speed ? `${fmtBytes(snap.speed)}/s` : '';
  $('.eta', li).textContent = snap.status === 'downloading' ? fmtTime(snap.eta) : snap.error?.message ? snap.error.message : '';

  const toggle = $('.act-toggle', li);
  toggle.hidden = snap.status === 'complete' || snap.status === 'canceled';
  toggle.title = snap.status === 'downloading' || snap.status === 'connecting' ? 'Pause' : 'Resume';
  toggle.onclick = async () => {
    const action = snap.status === 'downloading' || snap.status === 'connecting' || snap.status === 'queued' ? 'pause' : 'resume';
    try {
      await api(`/api/downloads/${snap.id}/${action}`, { method: 'POST' });
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('.act-remove', li).onclick = async () => {
    try {
      await api(`/api/downloads/${snap.id}`, { method: 'DELETE' });
      li.remove();
      state.downloads.delete(snap.id);
      updateSummary();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  li.hidden = !matchesFilter(snap);
}

function renderStream(snap) {
  let li = $(`[data-id="${CSS.escape(snap.id)}"]`);
  if (!li) {
    li = template.content.firstElementChild.cloneNode(true);
    li.dataset.id = snap.id;
    li.classList.add('stream');
    $('#jobs').append(li);
  }
  li.dataset.status = snap.status;
  $('.job-name', li).textContent = snap.filename || 'HLS stream';
  $('.job-name', li).title = snap.playlistUrl || snap.url;
  const pill = $('.status-pill', li);
  pill.dataset.s = snap.status;
  pill.textContent = snap.status === 'downloading' ? 'streaming' : snap.status;
  $('.host', li).textContent = (() => {
    try { return 'HLS · ' + new URL(snap.playlistUrl || snap.url).host.replace(/^www\./, ''); } catch { return 'HLS'; }
  })();
  $('.dims', li).textContent = `${snap.completedSegments}/${snap.segments} segments · ${
    (snap.filename || '').endsWith('.mp4') ? 'fMP4' : 'MPEG-TS'
  }`;

  // one cell per segment for playlists up to 120 parts, then a single aggregate bar
  const bar = $('.segbar', li);
  const cells = snap.segments <= 120 ? snap.segments : 1;
  if (bar.children.length !== cells) {
    bar.replaceChildren(...Array.from({ length: cells }, () => {
      const seg = document.createElement('span');
      seg.className = 'seg';
      seg.append(document.createElement('i'));
      return seg;
    }));
  }
  const doneCount = snap.status === 'complete' ? snap.segments : snap.completedSegments;
  [...bar.children].forEach((el, i) => {
    const p = cells === 1 ? snap.progress : (i < doneCount ? 1 : i === doneCount ? 0.4 : 0);
    $('i', el).style.width = `${p * 100}%`;
    el.classList.toggle('active', i === doneCount && snap.status === 'downloading');
  });

  $('.pct', li).textContent = `${(snap.progress * 100).toFixed(0)}%`;
  $('.amounts', li).textContent = `${fmtBytes(snap.bytesWritten)} written`;
  $('.speed', li).textContent = snap.speed ? `${fmtBytes(snap.speed)}/s` : '';
  $('.eta', li).textContent = snap.error?.message || '';

  const toggle = $('.act-toggle', li);
  toggle.hidden = snap.status === 'complete';
  toggle.onclick = async () => {
    const action = snap.status === 'downloading' ? 'pause' : 'resume';
    try { await api(`/api/downloads/${snap.id}/${action}`, { method: 'POST' }); } catch (e) { toast(e.message, 'err'); }
  };
  $('.act-remove', li).onclick = async () => {
    try {
      await api(`/api/downloads/${snap.id}`, { method: 'DELETE' });
      li.remove();
      state.downloads.delete(snap.id);
      updateSummary();
    } catch (e) { toast(e.message, 'err'); }
  };
  li.hidden = !matchesFilter(snap);
}

function matchesFilter(snap) {
  if (state.filter === 'all') return true;
  if (state.filter === 'downloading') return snap.status === 'downloading' || snap.status === 'connecting' || snap.status === 'queued';
  return snap.status === state.filter;
}

function applyFilters() {
  for (const snap of state.downloads.values()) {
    const li = $(`[data-id="${CSS.escape(snap.id)}"]`);
    if (li) li.hidden = !matchesFilter(snap);
  }
}

function updateSummary() {
  const all = [...state.downloads.values()];
  const active = all.filter((d) => d.status === 'downloading' || d.status === 'connecting').length;
  const done = all.filter((d) => d.status === 'complete');
  const totalSpeed = all.reduce((s, d) => s + (d.speed || 0), 0);
  const bytes = all.reduce((s, d) => s + (d.downloaded || 0), 0);

  $('#queue-count').textContent = all.length;
  $('#m-active').textContent = active;
  $('#m-done').textContent = done.length;
  $('#m-bytes').textContent = fmtBytes(bytes);
  $('#total-speed').textContent = fmtBytes(totalSpeed);
  $('#empty').hidden = all.length > 0;

  state.speedHistory.push(totalSpeed);
  state.speedHistory.shift();
  state.maxSpeed = Math.max(64 * 1024, ...state.speedHistory);
  drawSpark();
}

function drawSpark() {
  const w = 240;
  const h = 48;
  const pts = state.speedHistory.map((v, i) => {
    const x = (i / (state.speedHistory.length - 1)) * w;
    const y = h - (v / state.maxSpeed) * (h - 4) - 1;
    return [x, y];
  });
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  $('#spark-line').setAttribute('d', line);
  $('#spark-area').setAttribute('d', `${line} L${w},${h} L0,${h} Z`);
}

/* ── live stream ───────────────────────────────────────────── */

function connect() {
  const pill = $('#conn-pill');
  const text = $('#conn-text');
  const es = new EventSource('/api/events');

  es.addEventListener('hello', (ev) => {
    const data = JSON.parse(ev.data);
    data.downloads.forEach(upsert);
    pill.dataset.state = 'live';
    text.textContent = 'live';
  });
  es.addEventListener('progress', (ev) => upsert(JSON.parse(ev.data)));
  es.addEventListener('status', (ev) => upsert(JSON.parse(ev.data)));
  es.addEventListener('done', (ev) => {
    const snap = JSON.parse(ev.data);
    upsert(snap);
    toast(`Finished ${snap.filename}`, 'info');
  });
  es.addEventListener('failed', (ev) => {
    const snap = JSON.parse(ev.data);
    upsert(snap);
    toast(`${snap.filename}: ${snap.error?.message || 'failed'}`, 'err', 6000);
  });
  es.onopen = () => {
    pill.dataset.state = 'live';
    text.textContent = 'live';
  };
  es.onerror = () => {
    pill.dataset.state = 'down';
    text.textContent = 'reconnecting';
  };
}

function upsert(snap) {
  state.downloads.set(snap.id, snap);
  renderJob(snap);
  updateSummary();
}

/* ── composer ──────────────────────────────────────────────── */

let probeTimer = null;
async function probe() {
  const url = $('#url').value.split(/\s+/).filter(Boolean)[0];
  const box = $('#probe');
  if (!url || !/^https?:/i.test(url)) {
    box.innerHTML = '<span class="probe-idle">Paste a link to see size, range support and resume capability.</span>';
    return;
  }
  box.innerHTML = '<span class="probe-idle">Probing…</span>';
  try {
    const info = await api('/api/probe', { method: 'POST', body: { url } });
    const ranges = info.acceptRanges
      ? '<span class="ok">byte ranges supported → segmented resume</span>'
      : '<span class="no">no byte ranges → single stream, cannot resume</span>';
    box.innerHTML = `<strong>${info.humanSize}</strong> · ${info.contentType?.split(';')[0] || 'unknown type'} · ${ranges}${info.filename ? ` · <strong>${info.filename}</strong>` : ''}`;
  } catch (err) {
    box.innerHTML = `<span class="no">${err.message}</span>`;
  }
}

$('#url').addEventListener('input', () => {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(probe, 550);
});

$$('.step').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $('#connections');
    input.value = Math.min(32, Math.max(1, Number(input.value) + Number(btn.dataset.step)));
  });
});

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const urls = $('#url').value.split(/\s*\n\s*/).map((s) => s.trim()).filter(Boolean);
  if (!urls.length) return;
  const btn = $('#submit-btn');
  btn.disabled = true;
  try {
    const body = {
      urls,
      connections: Number($('#connections').value) || 8,
      limit: $('#limit').value.trim() || undefined,
      dir: $('#dir').value.trim() || undefined,
      checksum: $('#checksum').value.trim() || undefined,
    };
    const { created } = await api('/api/downloads', { method: 'POST', body });
    created.forEach(upsert);
    toast(`Queued ${created.length} download${created.length > 1 ? 's' : ''}`);
    $('#url').value = '';
    $('#checksum').value = '';
    probe();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('#demo-btn').addEventListener('click', async () => {
  try {
    const { seeded } = await api('/demo/seed', { method: 'POST', body: {} });
    toast(`Queued ${seeded.length} demo transfers`);
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#grab-btn').addEventListener('click', async () => {
  const url = $('#url').value.split(/\s+/).filter(Boolean)[0];
  if (!url) return toast('Paste a page URL first', 'warn');
  try {
    const { items } = await api('/api/grab', { method: 'POST', body: { url } });
    if (!items?.length) return toast('No media or files found on that page', 'warn');
    $('#url').value = items.map((i) => i.url).join('\n');
    toast(`Found ${items.length} candidate${items.length > 1 ? 's' : ''} — review, then start`);
    probe();
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* ── filters, queue policy, theme ──────────────────────────── */

$$('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    $$('.chip').forEach((c) => {
      c.classList.toggle('active', c === chip);
      c.setAttribute('aria-selected', String(c === chip));
    });
    state.filter = chip.dataset.filter;
    applyFilters();
  });
});

const conc = $('#conc');
const paintRange = () => conc.style.setProperty('--fill', `${((conc.value - conc.min) / (conc.max - conc.min)) * 100}%`);
conc.addEventListener('input', () => {
  paintRange();
  $('#conc-out').textContent = conc.value;
});
conc.addEventListener('change', async () => {
  try {
    await api('/api/queue', { method: 'PATCH', body: { maxConcurrent: Number(conc.value) } });
    toast(`Running at most ${conc.value} download${conc.value > 1 ? 's' : ''} at once`);
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#global-rate').addEventListener('change', async (e) => {
  try {
    const data = await api('/api/queue', { method: 'PATCH', body: { globalRate: e.target.value.trim() || '0' } });
    toast(data.globalRate ? `Global cap ${fmtBytes(data.globalRate)}/s` : 'Global cap removed');
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#pause-all').addEventListener('click', async () => {
  await api('/api/queue', { method: 'PATCH', body: { paused: true } });
  toast('All transfers paused', 'warn');
});
$('#resume-all').addEventListener('click', async () => {
  await api('/api/queue', { method: 'PATCH', body: { paused: false } });
  const paused = [...state.downloads.values()].filter((d) => d.status === 'paused' || d.status === 'error');
  await Promise.all(paused.map((d) => api(`/api/downloads/${d.id}/resume`, { method: 'POST' }).catch(() => {})));
  toast('Resumed');
});

$('#copy-snippet').addEventListener('click', async () => {
  const text = $('.snippet code').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('MCP config copied');
  } catch {
    toast('Copy failed — select the text manually', 'warn');
  }
});

const themeBtn = $('#theme-toggle');
const savedTheme = localStorage.getItem('odm-theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('odm-theme', next);
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/input|textarea/i.test(document.activeElement.tagName)) {
    e.preventDefault();
    $('#url').focus();
  }
});

/* ── parity checklist (facts from the reference APK manifest) ─ */
const parity = [
  ['Multi-connection segmented transfers', true],
  ['Crash-safe resume from segment cursor', true],
  ['Byte-range probing & no-range fallback', true],
  ['Per-download + global bandwidth caps', true],
  ['Queue with priority & concurrency limit', true],
  ['Scheduled off-peak windows (HH:MM)', true],
  ['Media sniffing (HTML, HLS, DASH)', true],
  ['Checksum verification (sha256/sha1/md5)', true],
  ['Retry with exponential backoff + jitter', true],
  ['MCP server for agent control', true],
  ['Browser extension hand-off (WebExtension)', false],
  ['Android foreground service + SAF storage', false],
];
$('#parity').replaceChildren(
  ...parity.map(([text, done]) => {
    const li = document.createElement('li');
    li.textContent = text;
    if (!done) li.className = 'todo';
    return li;
  }),
);

/* ── boot ──────────────────────────────────────────────────── */
(async function boot() {
  paintRange();
  try {
    const health = await api('/api/health').catch(() => ({}));
    if (health.demo) $('#demo-btn').hidden = false;
    const data = await api('/api/downloads');
    data.downloads.forEach(upsert);
    if (data.queue) {
      $('#conc').value = data.queue.maxConcurrent;
      $('#conc-out').textContent = data.queue.maxConcurrent;
      paintRange();
      if (data.queue.globalRate) $('#global-rate').value = fmtBytes(data.queue.globalRate);
    }
    updateSummary();
  } catch {
    /* SSE hello will fill it in */
  }
  connect();
  setInterval(async () => {
    // Fallback poll keeps the UI honest if SSE is blocked by a proxy.
    if ($('#conn-pill').dataset.state === 'live') return;
    try {
      const data = await api('/api/downloads');
      data.downloads.forEach(upsert);
    } catch {
      /* ignore */
    }
  }, 4000);
  setInterval(updateSummary, 1000);
})();
