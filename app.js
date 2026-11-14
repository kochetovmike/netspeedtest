'use strict';

/* =========================================================================
   Config
   ========================================================================= */
const CF = 'https://speed.cloudflare.com';

const CFG = {
  latencySamples: 20,
  warmupFrac: 0.25, // fraction of each transfer phase excluded from the final result (TCP ramp-up)
  windowMs: 800,    // sliding window used for the live gauge reading
  down: { duration: 10000, streams: 6, startBytes: 1e6, maxBytes: 1e8 },
  up:   { duration: 10000, streams: 4, startBytes: 5e5, maxBytes: 5e7 },
};

// Non-linear gauge scale (Mbps), evenly spaced along the arc.
const SCALE = [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000];

const $ = (id) => document.getElementById(id);
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================================================================
   Gauge
   ========================================================================= */
const G = { N: 48, CX: 120, CY: 116, R_IN: 82, A0: -120, A1: 120 };

function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [G.CX + r * Math.sin(a), G.CY - r * Math.cos(a)];
}

function sectorPath(r1, r2, a, b) {
  const f = (n) => n.toFixed(2);
  const [x1, y1] = polar(r2, a), [x2, y2] = polar(r2, b);
  const [x3, y3] = polar(r1, b), [x4, y4] = polar(r1, a);
  return `M${f(x1)} ${f(y1)}A${r2} ${r2} 0 0 1 ${f(x2)} ${f(y2)}L${f(x3)} ${f(y3)}A${r1} ${r1} 0 0 0 ${f(x4)} ${f(y4)}Z`;
}

function valueToFrac(v) {
  if (!(v > 0)) return 0;
  const n = SCALE.length - 1;
  for (let i = 1; i <= n; i++) {
    if (v <= SCALE[i]) return (i - 1 + (v - SCALE[i - 1]) / (SCALE[i] - SCALE[i - 1])) / n;
  }
  return 1;
}

function fracToValue(f) {
  const n = SCALE.length - 1;
  const x = Math.min(Math.max(f, 0), 1) * n;
  const i = Math.min(Math.floor(x), n - 1);
  return SCALE[i] + (x - i) * (SCALE[i + 1] - SCALE[i]);
}

function fmtSpeed(v) {
  if (!(v > 0)) return '0.00';
  if (v < 10) return v.toFixed(2);
  if (v < 100) return v.toFixed(1);
  return v.toFixed(0);
}

function fmtBytes(b) {
  if (b < 1e6) return (b / 1e3).toFixed(0) + ' kB';
  if (b < 1e9) return (b / 1e6).toFixed(1) + ' MB';
  return (b / 1e9).toFixed(2) + ' GB';
}

class Gauge {
  constructor(el) {
    this.el = el;
    this.value = 0;      // latest reading (Mbps)
    this.shownFrac = 0;  // eased arc position
    this.shownNum = 0;   // eased numeric readout
    this.peak = 0;
    this.lit = -1;
    this.build();
    this.el.classList.add('idle');
  }

  build() {
    const { N, A0, A1, R_IN, CX, CY } = G;
    const span = (A1 - A0) / N;
    const gap = 1.3;
    const redFrom = Math.floor(N * 0.89);
    let segs = '';
    for (let i = 0; i < N; i++) {
      const a = A0 + i * span + gap / 2;
      const rOut = 93 + (i / (N - 1)) * 9; // segments grow taller toward the top end
      segs += `<path class="seg${i >= redFrom ? ' red' : ''}" d="${sectorPath(R_IN, rOut, a, a + span - gap)}"/>`;
    }
    let labels = '';
    SCALE.forEach((v, i) => {
      const [x, y] = polar(70, A0 + (i / (SCALE.length - 1)) * (A1 - A0));
      labels += `<text class="scale-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}">${v}</text>`;
    });
    const label = this.el.dataset.label.toUpperCase();
    const arrow = this.el.dataset.arrow;
    this.el.innerHTML = `
      <svg viewBox="0 0 240 196" role="img" aria-label="${this.el.dataset.label} speed gauge">
        <g class="segs">${segs}</g>
        ${labels}
        <line class="peak" x1="${CX}" y1="${CY - 106}" x2="${CX}" y2="${CY - 113}"/>
        <text class="readout" x="${CX}" y="${CY + 12}">0.00</text>
        <text class="unit" x="${CX}" y="${CY + 32}">MBPS</text>
        <text class="glabel" x="${CX}" y="${CY + 70}">${arrow} ${label}</text>
      </svg>
      <figcaption><span>Peak <b data-f="peak">—</b></span><span>Data <b data-f="bytes">—</b></span></figcaption>`;
    this.segs = [...this.el.querySelectorAll('.seg')];
    this.readout = this.el.querySelector('.readout');
    this.peakEl = this.el.querySelector('.peak');
    this.peakText = this.el.querySelector('[data-f="peak"]');
    this.bytesText = this.el.querySelector('[data-f="bytes"]');
  }

  set(v) {
    this.value = Math.max(0, v || 0);
    this.el.classList.toggle('idle', this.value === 0);
  }

  setPeak(v) {
    if (v <= this.peak) return;
    this.peak = v;
    const deg = G.A0 + valueToFrac(v) * (G.A1 - G.A0);
    this.peakEl.setAttribute('transform', `rotate(${deg.toFixed(2)} ${G.CX} ${G.CY})`);
    this.peakEl.classList.add('show');
    this.peakText.textContent = fmtSpeed(v) + ' Mbps';
  }

  setBytes(b) { this.bytesText.textContent = b ? fmtBytes(b) : '—'; }

  reset() {
    this.set(0);
    this.peak = 0;
    this.peakEl.classList.remove('show');
    this.peakText.textContent = '—';
    this.setBytes(0);
  }

  tick() {
    const target = valueToFrac(this.value);
    this.shownFrac += (target - this.shownFrac) * 0.16;
    this.shownNum += (this.value - this.shownNum) * 0.2;
    if (Math.abs(this.value - this.shownNum) < 0.005) this.shownNum = this.value;
    this.render();
  }

  // Draw at an explicit arc position, bypassing easing (used for the load sweep).
  force(frac) {
    this.shownFrac = frac;
    this.shownNum = fracToValue(frac);
    this.render();
  }

  render() {
    const lit = Math.round(this.shownFrac * G.N);
    if (lit !== this.lit) {
      for (let i = 0; i < G.N; i++) this.segs[i].classList.toggle('on', i < lit);
      this.lit = lit;
    }
    const text = fmtSpeed(this.shownNum);
    if (this.readout.textContent !== text) this.readout.textContent = text;
  }
}

/* =========================================================================
   Measurement
   ========================================================================= */
async function measureLatency(n, onSample) {
  const samples = [];
  for (let i = 0; i <= n; i++) {
    const t0 = now();
    const r = await fetch(`${CF}/__down?bytes=0`, { cache: 'no-store' });
    await r.arrayBuffer();
    const dt = now() - t0;
    if (i === 0) { readCfMeta(r.headers); continue; } // first request pays for connection setup
    samples.push(dt);
    onSample(i / n, summarizeLatency(samples));
  }
  return summarizeLatency(samples);
}

function summarizeLatency(s) {
  const sorted = [...s].sort((a, b) => a - b);
  const ping = sorted[Math.floor((sorted.length - 1) / 2)];
  let jitter = 0;
  for (let i = 1; i < s.length; i++) jitter += Math.abs(s[i] - s[i - 1]);
  jitter = s.length > 1 ? jitter / (s.length - 1) : 0;
  return { ping, jitter };
}

let uploadBase = null;
function makeUploadBlob(size) {
  if (!uploadBase) {
    uploadBase = new Uint8Array(1 << 20);
    for (let o = 0; o < uploadBase.length; o += 65536) crypto.getRandomValues(uploadBase.subarray(o, o + 65536));
  }
  const parts = [];
  let left = size;
  while (left > 0) {
    const n = Math.min(left, uploadBase.length);
    parts.push(n === uploadBase.length ? uploadBase : uploadBase.subarray(0, n));
    left -= n;
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

/**
 * Runs a multi-stream transfer for a fixed duration.
 * Bytes are counted as they arrive (download: stream reader; upload: XHR progress events),
 * so the live gauge reflects real throughput rather than per-request completions.
 */
async function runTransfer(kind, { onLive, onProgress }) {
  const c = CFG[kind];
  const start = now();
  const end = start + c.duration;
  let total = 0;
  let errors = 0;
  const aborters = new Set();
  const samples = [{ t: start, b: 0 }];

  async function downStream() {
    let size = c.startBytes;
    while (now() < end) {
      const ac = new AbortController();
      const abort = () => ac.abort();
      aborters.add(abort);
      const t0 = now();
      try {
        const r = await fetch(`${CF}/__down?bytes=${size}`, { cache: 'no-store', signal: ac.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
        }
      } catch (e) {
        if (now() >= end) break;
        errors++;
        await sleep(250);
      }
      aborters.delete(abort);
      if (now() - t0 < 1500) size = Math.min(size * 2, c.maxBytes);
    }
  }

  function upOnce(size) {
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      let sent = 0;
      const abort = () => x.abort();
      aborters.add(abort);
      x.open('POST', `${CF}/__up`);
      x.upload.onprogress = (e) => { total += e.loaded - sent; sent = e.loaded; };
      x.onloadend = () => {
        aborters.delete(abort);
        if (x.status === 200) { total += size - sent; sent = size; }
        else if (now() < end) errors++;
        resolve();
      };
      x.send(makeUploadBlob(size));
    });
  }

  async function upStream() {
    let size = c.startBytes;
    while (now() < end) {
      const t0 = now();
      await upOnce(size);
      if (now() - t0 < 1500) size = Math.min(size * 2, c.maxBytes);
      if (errors > 20) break;
    }
  }

  const streams = Array.from({ length: c.streams }, (_, i) => sleep(i * 60).then(kind === 'down' ? downStream : upStream));

  const sampler = setInterval(() => {
    const t = now();
    samples.push({ t, b: total });
    let j = samples.length - 1;
    while (j > 0 && t - samples[j - 1].t <= CFG.windowMs) j--;
    const ref = samples[Math.max(0, j - 1)];
    const mbps = t > ref.t ? ((total - ref.b) * 8) / (t - ref.t) / 1000 : 0;
    onLive(mbps, total);
    onProgress(Math.min(1, (t - start) / c.duration));
    if (t >= end) for (const a of aborters) a();
  }, 100);

  await Promise.all(streams);
  clearInterval(sampler);
  for (const a of aborters) a();

  const tEnd = now();
  samples.push({ t: tEnd, b: total });
  if (total === 0) throw new Error(`${kind === 'down' ? 'Download' : 'Upload'} failed: speed.cloudflare.com unreachable (network or content blocker?)`);

  const warmT = start + c.duration * CFG.warmupFrac;
  const warm = samples.find((s) => s.t >= warmT) || samples[0];
  const result = ((total - warm.b) * 8) / (tEnd - warm.t) / 1000;
  return { mbps: result, bytes: total };
}

/* =========================================================================
   Connection info
   ========================================================================= */
const conn = {};

function readCfMeta(h) {
  const get = (k) => h.get('cf-meta-' + k) || undefined;
  const meta = {
    ip: get('ip'), city: get('city'), country: get('country'), colo: get('colo'),
    asn: get('asn'), lat: get('latitude'), lon: get('longitude'), tz: get('timezone'),
  };
  for (const [k, v] of Object.entries(meta)) if (v && !conn[k]) conn[k] = v;
  renderConn();
}

const countryName = (cc) => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc); } catch (_) { return cc; } };
const splitOrg = (org) => { const m = /^AS(\d+)\s+(.*)$/.exec(org || ''); return m ? { asn: m[1], isp: m[2] } : { isp: org || undefined }; };

// Free, keyless, CORS-enabled geo-IP providers, tried in order until one answers.
const GEO_PROVIDERS = [
  ['https://ipwho.is/', (d) => {
    if (!d.success) throw new Error(d.message);
    return {
      ip: d.ip, type: d.type, city: d.city, region: d.region, country: d.country, cc: d.country_code,
      isp: d.connection && (d.connection.isp || d.connection.org),
      asn: d.connection && d.connection.asn && String(d.connection.asn),
      lat: d.latitude, lon: d.longitude,
      tz: d.timezone && d.timezone.id, tzUtc: d.timezone && d.timezone.utc,
    };
  }],
  ['https://ipinfo.io/json', (d) => {
    if (!d.ip || d.bogon) throw new Error('no data');
    const [lat, lon] = (d.loc || '').split(',');
    return { ip: d.ip, city: d.city, region: d.region, country: countryName(d.country), cc: d.country,
      ...splitOrg(d.org), lat, lon, tz: d.timezone };
  }],
  ['https://get.geojs.io/v1/ip/geo.json', (d) => ({
    ip: d.ip, city: d.city, region: d.region, country: d.country, cc: d.country_code,
    isp: d.organization_name, asn: d.asn && String(d.asn), lat: d.latitude, lon: d.longitude, tz: d.timezone,
  })],
];

async function loadConnection() {
  for (const [url, normalize] of GEO_PROVIDERS) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const info = normalize(await r.json());
      for (const [k, v] of Object.entries(info)) if (v !== undefined && v !== null && v !== '') conn[k] = v;
      renderConn();
      break;
    } catch (_) { /* try the next provider */ }
  }

  if (!conn.ip || !conn.city) {
    try {
      const r = await fetch(`${CF}/__down?bytes=0`, { cache: 'no-store' });
      readCfMeta(r.headers);
    } catch (_) {}
  }
  if (!conn.ip) {
    try {
      const d = await (await fetch('https://api.ipify.org?format=json')).json();
      conn.ip = d.ip;
    } catch (_) {}
  }
  conn.done = true;
  renderConn();
}

function renderConn() {
  const dash = conn.done ? 'Unavailable' : '…';
  $('ip').textContent = conn.ip || dash;
  const type = conn.type || (conn.ip ? (conn.ip.includes(':') ? 'IPv6' : 'IPv4') : '');
  $('ip-type').hidden = !type;
  $('ip-type').textContent = type;

  const place = [conn.city, conn.region !== conn.city ? conn.region : null, conn.country].filter(Boolean).join(', ');
  $('location').textContent = place || dash;
  $('isp').textContent = conn.isp || dash;
  $('asn').textContent = conn.asn ? 'AS' + conn.asn : dash;
  $('timezone').textContent = conn.tz ? conn.tz + (conn.tzUtc ? ` (UTC${conn.tzUtc})` : '') : dash;

  const coords = $('coords');
  if (conn.lat != null && conn.lon != null) {
    const lat = Number(conn.lat), lon = Number(conn.lon);
    coords.innerHTML = '';
    const a = document.createElement('a');
    a.href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=10/${lat}/${lon}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    coords.appendChild(a);
  } else {
    coords.textContent = dash;
  }
}

/* =========================================================================
   Commands
   ========================================================================= */
const TARGET = '1.1.1.1';
const COMMANDS = [
  { t: 'Network configuration', d: 'Interfaces, local IP, gateway, DNS servers',
    win: 'ipconfig /all', mac: 'ifconfig', linux: 'ip addr show' },
  { t: 'Public IP from terminal', d: 'What the internet sees you as',
    win: 'curl.exe -s ifconfig.me', mac: 'curl -s ifconfig.me', linux: 'curl -s ifconfig.me' },
  { t: 'Ping', d: 'Reachability and round-trip time',
    win: `ping -n 10 ${TARGET}`, mac: `ping -c 10 ${TARGET}`, linux: `ping -c 10 ${TARGET}` },
  { t: 'Trace route', d: 'Every hop between you and a host',
    win: `tracert ${TARGET}`, mac: `traceroute ${TARGET}`, linux: `traceroute ${TARGET}` },
  { t: 'Packet loss per hop', d: 'Combined ping + traceroute over time',
    win: `pathping ${TARGET}`, mac: `sudo mtr ${TARGET}`, linux: `mtr -rw ${TARGET}` },
  { t: 'DNS lookup', d: 'Resolve a hostname via a specific resolver',
    win: `nslookup example.com ${TARGET}`, mac: `dig @${TARGET} example.com`, linux: `dig @${TARGET} example.com` },
  { t: 'Flush DNS cache', d: 'Clear stale DNS entries',
    win: 'ipconfig /flushdns', mac: 'sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder', linux: 'resolvectl flush-caches' },
  { t: 'Routing table', d: 'Default gateway and routes',
    win: 'route print', mac: 'netstat -rn', linux: 'ip route' },
  { t: 'Listening ports & connections', d: 'What is open and talking on this machine',
    win: 'netstat -ano', mac: 'lsof -i -P -n | grep LISTEN', linux: 'ss -tulpn' },
  { t: 'Test a TCP port', d: 'Check if a remote port is reachable',
    win: 'Test-NetConnection example.com -Port 443', mac: 'nc -vz example.com 443', linux: 'nc -vz example.com 443' },
  { t: 'Wi-Fi details', d: 'Signal, channel, link rate',
    win: 'netsh wlan show interfaces', mac: 'system_profiler SPAirPortDataType', linux: 'nmcli dev wifi' },
  { t: 'Renew DHCP lease', d: 'Get a fresh IP from the router',
    win: 'ipconfig /release; ipconfig /renew', mac: 'sudo ipconfig set en0 DHCP', linux: 'sudo dhclient -r; sudo dhclient' },
  { t: 'ARP table', d: 'Devices seen on your local network',
    win: 'arp -a', mac: 'arp -a', linux: 'ip neigh' },
  { t: 'Terminal speed test', d: 'Download throughput (macOS: full test)',
    win: 'curl.exe -o NUL -w "%{speed_download} bytes/s" "https://speed.cloudflare.com/__down?bytes=100000000"',
    mac: 'networkQuality -v',
    linux: 'curl -o /dev/null -w "%{speed_download} bytes/s\\n" "https://speed.cloudflare.com/__down?bytes=100000000"' },
];

function detectOS() {
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent;
  if (/win/i.test(p)) return 'win';
  if (/mac|iphone|ipad/i.test(p)) return 'mac';
  return 'linux';
}

function renderCommands(os) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.os === os)));
  const list = $('cmds');
  list.innerHTML = '';
  for (const c of COMMANDS) {
    const li = document.createElement('li');
    li.innerHTML = '<div class="cmd-title"></div><div class="cmd-desc"></div><div class="cmd-line"><code></code><button class="copy" type="button">copy</button></div>';
    li.querySelector('.cmd-title').textContent = c.t;
    li.querySelector('.cmd-desc').textContent = c.d;
    li.querySelector('code').textContent = c[os];
    li.querySelector('.copy').dataset.copy = c[os];
    list.appendChild(li);
  }
  try { localStorage.setItem('ns-os', os); } catch (_) {}
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    ta.remove();
  }
  btn.textContent = 'copied';
  btn.classList.add('ok');
  setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('ok'); }, 1200);
}

/* =========================================================================
   Wiring
   ========================================================================= */
const gDown = new Gauge($('gauge-down'));
const gUp = new Gauge($('gauge-up'));
const startBtn = $('start');
const statusEl = $('status');
const progressEl = $('progress-fill');

// Ignition sweep on load: gauges go to full scale and back within SWEEP_MS.
const SWEEP_MS = 280;
let sweepStart = matchMedia('(prefers-reduced-motion: reduce)').matches ? null : now();
if (sweepStart !== null) document.documentElement.classList.add('sweep');
let running = false;

(function loop() {
  const p = sweepStart === null ? 1 : (now() - sweepStart) / SWEEP_MS;
  if (p < 1 && !running) {
    const f = Math.sin(Math.PI * p);
    gDown.force(f);
    gUp.force(f);
  } else {
    if (sweepStart !== null) {
      sweepStart = null;
      gDown.force(0); gUp.force(0);
      document.documentElement.classList.remove('sweep');
    }
    gDown.tick();
    gUp.tick();
  }
  requestAnimationFrame(loop);
})();

function setStatus(text, error) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', !!error);
}

function setStep(step) {
  const order = ['latency', 'down', 'up'];
  const idx = order.indexOf(step);
  document.querySelectorAll('.steps li').forEach((li) => {
    const i = order.indexOf(li.dataset.step);
    li.classList.toggle('active', i === idx);
    li.classList.toggle('done', idx === -1 ? step === 'done' : i < idx);
  });
}

// Phase weights for the overall progress bar.
function phaseProgress(phase, frac) {
  const w = { latency: [0, 0.08], down: [0.08, 0.54], up: [0.54, 1] }[phase];
  progressEl.style.width = ((w[0] + (w[1] - w[0]) * frac) * 100).toFixed(1) + '%';
}

async function runTest() {
  if (running) return;
  running = true;
  startBtn.disabled = true;
  startBtn.classList.add('running');
  startBtn.textContent = '';
  gDown.reset(); gUp.reset();
  $('ping').textContent = '—';
  $('jitter').textContent = '—';
  progressEl.style.width = '0';

  try {
    setStep('latency');
    setStatus('Measuring latency…');
    const lat = await measureLatency(CFG.latencySamples, (f, s) => {
      phaseProgress('latency', f);
      $('ping').textContent = s.ping.toFixed(0);
      $('jitter').textContent = s.jitter.toFixed(1);
    });
    $('ping').textContent = lat.ping.toFixed(0);
    $('jitter').textContent = lat.jitter.toFixed(1);

    for (const [kind, gauge, label] of [['down', gDown, 'download'], ['up', gUp, 'upload']]) {
      setStep(kind);
      setStatus(`Testing ${label} · ${CFG[kind].streams} parallel streams…`);
      const res = await runTransfer(kind, {
        onLive: (mbps, bytes) => { gauge.set(mbps); gauge.setPeak(mbps); gauge.setBytes(bytes); },
        onProgress: (f) => phaseProgress(kind, f),
      });
      gauge.set(res.mbps);
      gauge.setBytes(res.bytes);
    }

    setStep('done');
    progressEl.style.width = '100%';
    setStatus(`Done · ↓ ${fmtSpeed(gDown.value)} / ↑ ${fmtSpeed(gUp.value)} Mbps${conn.colo ? ' · via Cloudflare ' + conn.colo : ''}`);
  } catch (e) {
    setStatus(e && e.message ? e.message : 'Test failed', true);
    setStep('none');
  } finally {
    running = false;
    startBtn.disabled = false;
    startBtn.classList.remove('running');
    startBtn.textContent = 'Again';
  }
}

startBtn.addEventListener('click', runTest);

document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-os]');
  if (b) renderCommands(b.dataset.os);
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('.copy');
  if (!b) return;
  const text = b.dataset.copy || (b.dataset.copyTarget && $(b.dataset.copyTarget).textContent);
  if (text) copyText(text, b);
});

let savedOS = null;
try { savedOS = localStorage.getItem('ns-os'); } catch (_) {}
renderCommands(['win', 'mac', 'linux'].includes(savedOS) ? savedOS : detectOS());
renderConn();
loadConnection();
