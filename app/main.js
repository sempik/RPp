'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu, clipboard, systemPreferences, Notification } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.flv', '.ts', '.webm', '.m4v']);
// Chromium plays Matroska through its WebM demuxer, so mkv is served as webm.
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.mkv': 'video/webm',
  '.webm': 'video/webm', '.ts': 'video/mp2t', '.flv': 'video/x-flv',
};
const isVideo = p => typeof p === 'string' && VIDEO_EXT.has(path.extname(p).toLowerCase());
const REPO = 'sempik/RPp';
const SITE_URL = `https://github.com/${REPO}/releases/latest`;

const newerThan = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
// GET with redirects (release assets live behind a 302 to GitHub's CDN); resolves to the response stream.
function httpsGet(url, timeout = 15000, hops = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout, headers: { 'User-Agent': 'RPp', Accept: 'application/vnd.github+json, */*' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        res.resume();
        resolve(httpsGet(new URL(res.headers.location, url).href, timeout, hops - 1));
      } else if (res.statusCode !== 200) {
        res.resume(); reject(new Error('HTTP ' + res.statusCode));
      } else resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('Нет ответа от GitHub')));
    req.on('error', reject);
  });
}
async function httpsText(url) {
  const res = await httpsGet(url);
  const parts = []; let size = 0;
  for await (const d of res) { parts.push(d); if ((size += d.length) > 2e6) throw new Error('too large'); }
  return Buffer.concat(parts).toString('utf8'); // decode once: chunks can split a Cyrillic character
}
async function fetchLatestRelease() {
  const r = JSON.parse(await httpsText(`https://api.github.com/repos/${REPO}/releases/latest`));
  const asset = n => (r.assets || []).find(a => a.name === n);
  const setup = asset('RPp-Setup.exe'), sums = asset('SHA256SUMS.txt');
  // the first bullet list of the release notes is "Что нового"; the rest (VirusTotal, hashes) is for the web page
  const lines = String(r.body || '').split(/\r?\n/), isItem = l => /^\s*[-*] /.test(l);
  const first = lines.findIndex(isItem), notes = [];
  for (let i = first; first >= 0 && i < lines.length && isItem(lines[i]) && notes.length < 8; i++)
    notes.push(lines[i].replace(/^\s*[-*] /, '').replace(/\*\*|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
  return {
    version: String(r.tag_name || '').replace(/^v/, ''),
    notes,
    setup: setup && sums ? { url: setup.browser_download_url, size: setup.size, sums: sums.browser_download_url } : null,
  };
}

// ---------- complaints and suggestions ----------
// Sent to the author's server, which keeps them and forwards them to his Telegram.
// The server has its own self-signed certificate; trusting only it means nobody can sit in between.
const FEEDBACK_URL = 'https://148.253.209.182:8097/feedback';
const FEEDBACK_CERT = `-----BEGIN CERTIFICATE-----
MIIBlTCCATqgAwIBAgIUANrIvn0knyhkQBLfg9WUFPi37zMwCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMUlBwIGZlZWRiYWNrMB4XDTI2MTAxODIyMTM1MVoXDTM2MTAx
NTIyMTM1MVowFzEVMBMGA1UEAwwMUlBwIGZlZWRiYWNrMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEyFcyXHSZnvkcXMvk1bbu00bR1RwRB2dVvrBK1akWtCQ45nIZ
UDhhctqvQTzrKzAogtMnfHubY22f6GLfv4sLqqNkMGIwHQYDVR0OBBYEFEARP+UA
h1S2IQ8QNCt+ttsZrF6MMB8GA1UdIwQYMBaAFEARP+UAh1S2IQ8QNCt+ttsZrF6M
MA8GA1UdEwEB/wQFMAMBAf8wDwYDVR0RBAgwBocElP3RtjAKBggqhkjOPQQDAgNJ
ADBGAiEA/VwZqwNo6kfaVMG66Bl1GYpuXaMYfpAcVo3r1rgDMyICIQCYvi8kGJNu
TwiBYHMiDSWgvPcvDNwJBUbC4xQZUZzE6A==
-----END CERTIFICATE-----`;
function sendFeedback({ kind, text, contact, withSystem }) {
  const body = JSON.stringify({
    kind, text: String(text || '').slice(0, 4000), contact: String(contact || '').slice(0, 200),
    ...(withSystem ? { version: app.getVersion(), os: `Windows ${os.release()}` } : {}),
  });
  return new Promise((resolve, reject) => {
    const req = https.request(FEEDBACK_URL, {
      method: 'POST', ca: FEEDBACK_CERT, timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'RPp' },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => { data += d; });
      res.on('end', () => {
        let r = {}; try { r = JSON.parse(data); } catch { }
        res.statusCode === 200 ? resolve(r) : reject(new Error(r.error || 'Сервер ответил ошибкой ' + res.statusCode));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.')));
    req.on('error', e => reject(/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/.test(e.code || '') ? new Error('Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.') : e));
    req.end(body);
  });
}

// The app used to be called "OBS Player": carry its settings and thumbnails over once.
try {
  const oldData = path.join(app.getPath('appData'), 'OBS Player');
  const newData = app.getPath('userData');
  if (!fs.existsSync(newData) && fs.existsSync(oldData)) fs.cpSync(oldData, newData, { recursive: true });
} catch { /* old profile locked or partly copied: start fresh */ }

app.setAppUserModelId('com.rpp.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  init();
}

function init() {
  let win = null;
  let pendingFile = findVideoArg(process.argv);

  // ---------- ffmpeg ----------
  const ffmpegPath = [
    path.join(process.resourcesPath || '', 'ffmpeg.exe'),     // packaged build
    path.join(__dirname, '..', 'vendor', 'ffmpeg.exe'),        // running from source
  ].find(p => fs.existsSync(p)) || 'ffmpeg';

  // Hardware encoders first; the first one that actually works on this PC wins.
  const ENCODERS = [
    { name: 'NVENC', args: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '19', '-b:v', '0', '-pix_fmt', 'yuv420p'] },
    { name: 'AMF', args: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '18', '-qp_p', '20', '-pix_fmt', 'nv12'] },
    { name: 'QuickSync', args: ['-c:v', 'h264_qsv', '-global_quality', '20', '-pix_fmt', 'nv12'] },
    { name: 'x264', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'] },
  ];
  let encoderPromise = null;
  function pickEncoder() {
    if (!encoderPromise) {
      encoderPromise = (async () => {
        for (const enc of ENCODERS.slice(0, -1)) {
          const ok = await new Promise(resolve => {
            const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=0.2',
              '-frames:v', '3', ...enc.args, '-f', 'null', '-'], { windowsHide: true });
            p.on('error', () => resolve(false));
            p.on('close', code => resolve(code === 0));
          });
          if (ok) return enc;
        }
        return ENCODERS[ENCODERS.length - 1];
      })();
    }
    return encoderPromise;
  }

  // ---------- local video server (Range requests -> seeking in huge files) ----------
  const token = crypto.randomBytes(16).toString('hex');
  let videoBase = '';
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const file = u.searchParams.get('path');
    if (u.pathname !== '/video' || u.searchParams.get('t') !== token || !isVideo(file)) {
      res.writeHead(403); res.end(); return;
    }
    let st;
    try { st = await fsp.stat(file); } catch { st = null; }
    if (!st || !st.isFile()) { res.writeHead(404); res.end(); return; }
    const size = st.size;
    let start = 0, end = size - 1;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      if (m[1]) { start = +m[1]; if (m[2]) end = Math.min(+m[2], size - 1); }
      else if (m[2]) start = Math.max(0, size - m[2]);
    }
    if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()],
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Cache-Control': 'no-store',
      // lets the page read frames (minimap, "text from the frame"); the random token still guards access
      'Access-Control-Allow-Origin': '*',
    };
    if (m) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(m ? 206 : 200, headers);
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
  const serverReady = new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    videoBase = `http://127.0.0.1:${server.address().port}/video?t=${token}&path=`;
    resolve();
  }));

  // ---------- trimming ----------
  let job = null;
  function stamp(t) {
    const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t % 60);
    return [h, m, s].map(x => String(x).padStart(2, '0')).join('-');
  }
  async function startCut({ path: src, start, end, mode }) {
    if (job && job.state === 'running') throw new Error('Уже идёт вырезание');
    if (!isVideo(src) || !fs.existsSync(src)) throw new Error('Файл не найден: ' + src);
    start = Number(start); end = Number(end);
    if (!(end > start)) throw new Error('Конец должен быть позже начала');
    const encode = mode === 'encode';
    const enc = encode ? await pickEncoder() : null;

    const dir = path.dirname(src);
    const base = path.basename(src, path.extname(src));
    const ext = encode ? '.mp4' : path.extname(src);
    const name = `${base} cut ${stamp(start)} - ${stamp(end)}`;
    let out = path.join(dir, name + ext);
    for (let k = 2; fs.existsSync(out); k++) out = path.join(dir, `${name} (${k})${ext}`);

    const duration = end - start;
    const args = ['-hide_banner', '-nostats', '-y', '-ss', start.toFixed(3), '-i', src, '-t', duration.toFixed(3)];
    if (encode) args.push('-map', '0:v:0', '-map', '0:a?', ...enc.args, '-c:a', 'aac', '-b:a', '192k');
    else args.push('-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'make_zero');
    if (/\.(mp4|mov|m4v)$/i.test(out)) args.push('-movflags', '+faststart');
    args.push('-progress', 'pipe:1', out);

    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    const j = job = { proc, out, duration, state: 'running', percent: 0, log: '', cancelled: false, encoder: enc && enc.name };
    proc.stdout.on('data', d => {
      const all = [...String(d).matchAll(/out_time_us=(\d+)/g)];
      if (all.length) j.percent = Math.min(100, Number(all[all.length - 1][1]) / 1e6 / duration * 100);
    });
    proc.stderr.on('data', d => { j.log = (j.log + d).slice(-6000); });
    proc.on('error', e => { j.state = 'error'; j.log += '\n' + e.message; });
    proc.on('close', code => {
      j.state = j.cancelled ? 'cancelled' : code === 0 ? 'done' : 'error';
      if (j.state !== 'done') fs.rm(out, { force: true }, () => {});
    });
    return { output: out, encoder: j.encoder };
  }
  function cutStatus() {
    if (!job) return { state: 'idle' };
    const { state, out, encoder } = job;
    if (state === 'running') return { state, percent: Math.round(job.percent * 10) / 10, output: out, encoder };
    if (state === 'done') return { state, percent: 100, output: out, encoder };
    if (state === 'error') return { state, error: job.log.trim().split(/\r?\n/).slice(-6).join('\n') };
    return { state };
  }

  // ---------- library thumbnails (one ffmpeg call gives a frame and the duration) ----------
  const thumbDir = path.join(app.getPath('userData'), 'thumbs');
  const indexFile = path.join(thumbDir, 'index.json');
  let thumbIndex = null, saveTimer = null;
  const loadIndex = () => thumbIndex || (thumbIndex = (() => { try { return JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { return {}; } })());
  const saveIndex = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => fs.writeFile(indexFile, JSON.stringify(thumbIndex), () => {}), 1000);
  };
  const dataUrl = f => 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64');
  const thumbQueue = [];
  let thumbActive = 0;

  async function getThumb(p) {
    let st;
    try { st = await fsp.stat(p); } catch { return null; }
    const key = crypto.createHash('sha1').update(`${p}|${st.size}|${st.mtimeMs}`).digest('hex');
    const hit = loadIndex()[key];
    const file = path.join(thumbDir, key + '.jpg');
    if (hit && fs.existsSync(file)) return { duration: hit.duration, img: dataUrl(file) };
    return new Promise(resolve => { thumbQueue.push({ p, key, file, resolve }); pumpThumbs(); });
  }
  function pumpThumbs() {
    while (thumbActive < 2 && thumbQueue.length) {
      const j = thumbQueue.shift();
      thumbActive++;
      extractThumb(j).catch(() => j.resolve(null)).finally(() => { thumbActive--; pumpThumbs(); });
    }
  }
  async function extractThumb({ p, key, file, resolve }) {
    await fsp.mkdir(thumbDir, { recursive: true });
    const run = ss => new Promise(res => {
      fs.rmSync(file, { force: true });
      const pr = spawn(ffmpegPath, ['-hide_banner', '-ss', String(ss), '-i', p, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', '-y', file], { windowsHide: true });
      let err = '';
      pr.stderr.on('data', d => { err += d; });
      pr.on('error', () => res(err));
      pr.on('close', () => res(err));
    });
    let log = await run(8);
    if (!fs.existsSync(file) || !fs.statSync(file).size) log = await run(0);
    const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
    const duration = m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
    const ok = fs.existsSync(file) && fs.statSync(file).size > 0;
    // failures are not cached: the file may still be recording
    if (ok) { loadIndex()[key] = { duration }; saveIndex(); }
    resolve({ duration, img: ok ? dataUrl(file) : null });
  }

  function accentColor() {
    try { const c = systemPreferences.getAccentColor(); if (/^[0-9a-f]{6}/i.test(c)) return '#' + c.slice(0, 6); } catch { }
    return '#0078d4';
  }

  // ---------- file browser ----------
  async function listDir(dir) {
    if (!dir) dir = app.getPath('videos');
    try { if ((await fsp.stat(dir)).isFile()) dir = path.dirname(dir); }
    catch { throw new Error('Папка не найдена: ' + dir); }
    dir = path.resolve(dir);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const dirs = [], files = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) dirs.push({ name: e.name, path: full });
      else if (e.isFile() && isVideo(e.name)) {
        try {
          const st = await fsp.stat(full);
          files.push({ name: e.name, path: full, size: st.size, mtime: st.mtimeMs });
        } catch { /* locked or vanished */ }
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
    files.sort((a, b) => b.mtime - a.mtime);
    const parent = path.dirname(dir);
    return { dir, parent: parent === dir ? null : parent, dirs, files };
  }

  // ---------- "all videos": background scan of local disks ----------
  // Runs once per launch, a few directories at a time (fs work happens on libuv threads, the UI never waits).
  // The last result is cached, so the tab shows instantly and is refreshed when the new scan finishes.
  const SKIP_DIRS = new Set(['windows', 'program files', 'program files (x86)', 'programdata', 'appdata', 'system volume information',
    'recovery', 'perflogs', 'msocache', 'windowsapps', 'xboxgames', 'steamapps', 'steamlibrary', 'epic games', 'riot games',
    'node_modules', 'onedrivetemp', 'intel', 'amd', 'nvidia', 'drivers', 'temp', 'tmp', 'cache', 'caches']);
  const MIN_VIDEO = 1024 * 1024;     // smaller files are UI animations, previews and the like
  const MAX_VIDEOS = 20000;
  const mediaFile = path.join(app.getPath('userData'), 'media.json');
  let media = (() => { try { return JSON.parse(fs.readFileSync(mediaFile, 'utf8')); } catch { return null; } })();
  let scan = null;

  function localDrives() {
    return new Promise(resolve => {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3").DeviceID'], { windowsHide: true });
      let out = '';
      p.stdout.on('data', d => { out += d; });
      p.on('error', () => resolve(['C:']));
      p.on('close', () => { const l = out.match(/[A-Z]:/g); resolve(l && l.length ? l : ['C:']); });
    });
  }
  async function scanMedia() {
    if (scan) return;
    scan = { dirs: 0, found: 0 };
    const found = [], queue = (await localDrives()).map(d => d + '\\');
    const sendProgress = () => win && win.webContents.send('media-progress', { dirs: scan.dirs, found: found.length });
    let lastSent = 0;
    async function visit(dir) {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      scan.dirs++;
      for (const e of entries) {
        const n = e.name, full = path.join(dir, n);
        if (e.isDirectory()) {   // junctions/symlinks report as links, not directories: no loops
          if (n[0] !== '$' && n[0] !== '.' && !SKIP_DIRS.has(n.toLowerCase())) queue.push(full);
        } else if (e.isFile() && isVideo(n) && found.length < MAX_VIDEOS) {
          try { const st = await fsp.stat(full); if (st.size >= MIN_VIDEO) found.push({ name: n, path: full, size: st.size, mtime: st.mtimeMs }); } catch { }
        }
      }
      if (Date.now() - lastSent > 500) { lastSent = Date.now(); sendProgress(); }
    }
    const worker = async () => { while (queue.length) await visit(queue.shift()); };
    try {
      await Promise.all([worker(), worker(), worker()]);
      media = { scanned: Date.now(), files: found };
      fs.writeFile(mediaFile, JSON.stringify(media), () => {});
      if (win) win.webContents.send('media', media);
    } finally { scan = null; }
  }

  // ---------- updates ----------
  // One small request to the GitHub API at start and every 6 hours; nothing is downloaded until the user asks.
  const CHECK_EVERY = 6 * 3600e3;
  const installed = !!process.env.OBSP_UPDATE_DRYRUN || app.isPackaged && fs.existsSync(path.join(path.dirname(process.execPath), 'unins000.exe'));
  const updFile = path.join(app.getPath('userData'), 'update.json');
  const updState = (() => { try { return JSON.parse(fs.readFileSync(updFile, 'utf8')); } catch { return {}; } })();
  const saveUpd = () => fs.writeFile(updFile, JSON.stringify(updState), () => {});
  let latest = null, dl = null;

  async function checkUpdates() {
    try {
      const r = await fetchLatestRelease();
      updState.checked = Date.now(); saveUpd();
      if (!r.version || !newerThan(r.version, app.getVersion())) return;
      latest = r;
      if (win) win.webContents.send('update', publicUpdate());
      if (updState.notified !== r.version && Notification.isSupported()) {
        updState.notified = r.version; saveUpd();
        const n = new Notification({ title: `Вышла RPp ${r.version}`, body: 'Нажмите, чтобы посмотреть, что нового, и обновиться.', icon: path.join(__dirname, 'icon.png') });
        n.on('click', () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); win.webContents.send('show-update'); });
        n.show();
      }
    } catch { /* offline or rate-limited: try again next round */ }
  }
  function scheduleChecks() {
    setTimeout(checkUpdates, 6000); // after the window and library have settled
    setInterval(checkUpdates, CHECK_EVERY);
  }
  const publicUpdate = () => latest && { version: latest.version, current: app.getVersion(), notes: latest.notes, size: latest.setup && latest.setup.size, canInstall: installed && !!latest.setup };

  function sendDl() { if (win) win.webContents.send('update-progress', { state: dl.state, percent: dl.percent, error: dl.error }); }
  async function downloadAndInstall() {
    if (!latest || !latest.setup || !installed) throw new Error('Обновление недоступно');
    if (job && job.state === 'running') throw new Error('Дождитесь, пока сохранится фрагмент');
    if (dl && dl.state === 'downloading') return;
    dl = { state: 'downloading', percent: 0 };
    sendDl();
    const dir = path.join(os.tmpdir(), 'RPp-update');
    const file = path.join(dir, `RPp-Setup-${latest.version}.exe`);
    try {
      const sums = await httpsText(latest.setup.sums);
      const want = (/^([0-9a-f]{64})\s+\*?RPp-Setup\.exe\s*$/mi.exec(sums) || [])[1];
      if (!want) throw new Error('В релизе нет контрольной суммы установщика');
      await fsp.mkdir(dir, { recursive: true });
      const res = await httpsGet(latest.setup.url, 30000);
      const total = Number(res.headers['content-length']) || latest.setup.size || 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(file);
      let got = 0, lastSent = 0;
      res.on('data', d => {
        hash.update(d); got += d.length;
        const now = Date.now();
        if (total && now - lastSent > 250) { lastSent = now; dl.percent = Math.round(got / total * 100); sendDl(); }
      });
      await new Promise((resolve, reject) => { res.pipe(out); out.on('finish', resolve); out.on('error', reject); res.on('error', reject); });
      if (hash.digest('hex') !== want.toLowerCase()) throw new Error('Файл скачался с ошибкой: контрольная сумма не совпала');
      dl = { state: 'installing', percent: 100 };
      sendDl();
      if (process.env.OBSP_UPDATE_DRYRUN) return; // smoke test: stop after the verified download
      // Quit first and give our processes ~2 s to release their files; the installer then starts RPp again (/RELAUNCH=1).
      spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `ping -n 3 127.0.0.1 >nul & start "" "${file}" /SILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /RELAUNCH=1`],
        { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
      setTimeout(() => app.quit(), 300);
    } catch (e) {
      fs.rm(file, { force: true }, () => {});
      dl = { state: 'error', percent: 0, error: e.message };
      sendDl();
    }
  }

  // ---------- IPC ----------
  ipcMain.handle('base', async () => { await serverReady; return videoBase; });
  ipcMain.handle('info', () => ({ ffmpeg: ffmpegPath === 'ffmpeg' ? null : ffmpegPath, version: app.getVersion(), accent: accentColor() }));
  ipcMain.handle('thumb', (_, p) => (isVideo(p) ? getThumb(p) : null));
  ipcMain.handle('chrome-mode', (_, mode) => {
    if (!win) return;
    try { win.setTitleBarOverlay(mode === 'player' ? { color: '#000000', symbolColor: '#ffffff' } : { color: '#202020', symbolColor: '#ffffff' }); } catch { }
  });
  ipcMain.handle('list', (_, dir) => listDir(dir));
  ipcMain.handle('cut', (_, opts) => startCut(opts));
  ipcMain.handle('status', () => cutStatus());
  ipcMain.handle('cancel', () => {
    if (job && job.state === 'running') { job.cancelled = true; job.proc.kill(); }
  });
  ipcMain.handle('reveal', (_, p) => { if (p) shell.showItemInFolder(p); });
  ipcMain.handle('open-site', () => shell.openExternal(SITE_URL));
  ipcMain.handle('copy', (_, text) => clipboard.writeText(String(text).slice(0, 20000)));
  // Why can't the player open a file? "growing" = OBS is still writing it; otherwise ffmpeg's first complaint.
  ipcMain.handle('probe', async (_, p) => {
    if (!isVideo(p)) return { error: 'not a video' };
    const size = async () => { try { return (await fsp.stat(p)).size; } catch { return -1; } };
    const a = await size();
    if (a < 0) return { missing: true };
    await new Promise(r => setTimeout(r, 1500));
    if ((await size()) !== a) return { growing: true };
    const error = await new Promise(resolve => {
      const pr = spawn(ffmpegPath, ['-hide_banner', '-v', 'error', '-i', p, '-t', '0.5', '-f', 'null', '-'], { windowsHide: true });
      let err = '';
      pr.stderr.on('data', d => { err += d; });
      pr.on('error', () => resolve(null));
      pr.on('close', () => resolve(err.trim().split(/\r?\n/)[0] || null));
    });
    return { error };
  });
  // ---------- playable copies of files the player can't read ----------
  // "remux": the codec is fine but the container isn't (FLV, MPEG-TS): copy streams into MP4, takes seconds.
  // "encode": the codec itself can't be decoded here (ProRes, HEVC without GPU support): re-encode to H.264.
  // Copies live in userData/playable, keyed by path+size+mtime; old ones are removed.
  const playDir = path.join(app.getPath('userData'), 'playable');
  let conv = null;
  async function startPlayable(src, mode) {
    if (conv && conv.state === 'running') { if (conv.src === src && conv.mode === mode) return; conv.proc.kill(); }
    const st = await fsp.stat(src);
    const key = crypto.createHash('sha1').update(`${src}|${st.size}|${st.mtimeMs}|${mode}`).digest('hex');
    const out = path.join(playDir, key + '.mp4');
    if (fs.existsSync(out)) { conv = { src, mode, state: 'done', percent: 100, out }; return; }
    await fsp.mkdir(playDir, { recursive: true });
    const tmp = out + '.part';
    const enc = mode === 'encode' ? await pickEncoder() : null;
    const args = ['-hide_banner', '-nostats', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a?',
      ...(enc ? enc.args : ['-c:v', 'copy']), '-c:a', 'aac', '-b:a', '192k', '-f', 'mp4', '-progress', 'pipe:1', tmp];
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    const c = conv = { src, mode, proc, state: 'running', percent: 0, out, duration: 0, log: '' };
    proc.stderr.on('data', d => {
      c.log = (c.log + d).slice(-4000);
      const m = !c.duration && /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(c.log);
      if (m) c.duration = +m[1] * 3600 + +m[2] * 60 + +m[3];
    });
    proc.stdout.on('data', d => {
      const all = [...String(d).matchAll(/out_time_us=(\d+)/g)];
      if (all.length && c.duration) c.percent = Math.min(99, Number(all[all.length - 1][1]) / 1e6 / c.duration * 100);
    });
    proc.on('error', e => { c.state = 'error'; c.log += e.message; });
    proc.on('close', code => {
      if (code === 0) { try { fs.renameSync(tmp, out); c.state = 'done'; c.percent = 100; } catch (e) { c.state = 'error'; c.log += e.message; } }
      else { fs.rm(tmp, { force: true }, () => {}); if (c.state === 'running') c.state = 'error'; }
    });
  }
  function cleanPlayable() {
    // keep a week of copies and at most 20 GB
    fs.readdir(playDir, (e, names) => {
      if (e) return;
      const files = names.map(n => { const f = path.join(playDir, n); try { const s = fs.statSync(f); return { f, t: s.mtimeMs, size: s.size }; } catch { return null; } })
        .filter(Boolean).sort((a, b) => b.t - a.t);
      let total = 0;
      for (const x of files) { total += x.size; if (Date.now() - x.t > 7 * 864e5 || total > 20 * 2 ** 30 || x.f.endsWith('.part')) fs.rm(x.f, { force: true }, () => {}); }
    });
  }
  ipcMain.handle('playable', (_, src, mode) => (isVideo(src) ? startPlayable(src, mode === 'encode' ? 'encode' : 'remux') : null));
  ipcMain.handle('playable-status', () => conv && { src: conv.src, mode: conv.mode, state: conv.state, percent: Math.round(conv.percent), out: conv.out,
    error: conv.state === 'error' ? conv.log.trim().split(/\r?\n/).slice(-2).join(' ') : null });
  ipcMain.handle('playable-cancel', () => { if (conv && conv.state === 'running') { conv.state = 'cancelled'; conv.proc.kill(); } });

  // ---------- text from the frame (Windows' built-in OCR, the one the Snipping Tool uses) ----------
  // Nothing runs until the button is pressed; then one short PowerShell call reads a PNG of the visible frame.
  // The script (ocr.ps1) is handed to PowerShell on stdin and run as one block, so no execution-policy
  // changes are needed; the image path comes via an environment variable.
  const OCR_RUN = '& ([scriptblock]::Create([Console]::In.ReadToEnd()))';
  async function ocr(dataUrl) {
    const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl));
    if (!m) throw new Error('Нет кадра');
    const img = path.join(os.tmpdir(), `rpp-ocr-${process.pid}.png`);
    await fsp.writeFile(img, Buffer.from(m[1], 'base64'));
    try {
      const out = await new Promise((resolve, reject) => {
        const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', OCR_RUN],
          { windowsHide: true, env: { ...process.env, RPP_OCR_IMAGE: img } });
        let so = '', se = '';
        p.stdout.on('data', d => { so += d; });
        p.stderr.on('data', d => { se += d; });
        p.on('error', () => reject(new Error('Не удалось запустить распознавание текста Windows')));
        p.on('close', () => resolve({ so, se }));
        const t = setTimeout(() => p.kill(), 20000);
        p.on('close', () => clearTimeout(t));
        p.stdin.end(fs.readFileSync(path.join(__dirname, 'ocr.ps1'), 'utf8'));
      });
      const json = out.so.split(/\r?\n/).reverse().find(l => l.startsWith('{'));
      if (!json) throw new Error('Распознавание текста Windows недоступно на этом компьютере. ' + (out.se.trim().split(/\r?\n/)[0] || ''));
      const r = JSON.parse(json);
      if (r.error === 'nolang') throw new Error('nolang');
      return { lang: r.lang, lines: [].concat(r.lines || []).filter(l => l && l.text) };
    } finally { fs.rm(img, { force: true }, () => {}); }
  }
  ipcMain.handle('ocr', (_, dataUrl) => ocr(dataUrl));

  // Delete = move to the Windows Recycle Bin. The player releases the file first; Windows may still hold it
  // for a moment (our video server, a thumbnail being made), so retry briefly.
  ipcMain.handle('trash', async (_, p) => {
    if (!isVideo(p) || !fs.existsSync(p)) throw new Error('Файл не найден');
    for (let i = 0; ; i++) {
      try { await shell.trashItem(p); break; }
      catch (e) { if (i >= 8) throw new Error('Не удалось удалить: файл занят другой программой (например, OBS ещё записывает его).'); await new Promise(r => setTimeout(r, 400)); }
    }
    if (media) { media.files = media.files.filter(f => f.path !== p); fs.writeFile(mediaFile, JSON.stringify(media), () => {}); }
    return true;
  });
  ipcMain.handle('feedback', (_, m) => sendFeedback(m));
  ipcMain.handle('media', () => ({ media, scanning: !!scan }));
  ipcMain.handle('rescan', () => { scanMedia(); });
  ipcMain.handle('get-update', () => publicUpdate());
  ipcMain.handle('install-update', () => downloadAndInstall());
  ipcMain.handle('initial-file', () => { const f = pendingFile; pendingFile = null; return f; });
  ipcMain.handle('open-dialog', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Открыть видео',
      defaultPath: app.getPath('videos'),
      properties: ['openFile'],
      filters: [{ name: 'Видео', extensions: [...VIDEO_EXT].map(e => e.slice(1)) }, { name: 'Все файлы', extensions: ['*'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // ---------- window ----------
  const stateFile = path.join(app.getPath('userData'), 'window.json');
  function loadState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } }
  function saveState() {
    if (!win) return;
    const s = { maximized: win.isMaximized(), bounds: win.getNormalBounds() };
    try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch { }
  }

  function createWindow() {
    const s = loadState();
    win = new BrowserWindow({
      width: 1400, height: 860, ...(s.bounds || {}),
      minWidth: 900, minHeight: 560,
      show: false,
      title: 'RPp',
      backgroundColor: '#202020',
      icon: path.join(__dirname, 'icon.ico'),
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#202020', symbolColor: '#ffffff', height: 32 },
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
    });
    if (s.maximized) win.maximize();
    win.once('ready-to-show', () => win.show());
    win.on('close', saveState);
    win.on('closed', () => { win = null; });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
    win.loadFile(path.join(__dirname, 'index.html'));

    // Dev hooks for smoke tests and site demos:
    //   OBSP_SCREENSHOT=<png>  capture the window after OBSP_EVAL finishes, then exit
    //   OBSP_RECORD=<dir>      capture frames (+ frames.txt with timings) while OBSP_EVAL runs, then exit
    //   OBSP_LOG=<file>        append the page's console output to a file
    if (process.env.OBSP_LOG) win.webContents.on('console-message', e => fs.appendFileSync(process.env.OBSP_LOG, (e.message || '') + '\n'));
    const shot = process.env.OBSP_SCREENSHOT, rec = process.env.OBSP_RECORD;
    if (shot || rec) {
      if (process.env.OBSP_SIZE) { const [w, h] = process.env.OBSP_SIZE.split('x').map(Number); win.setContentSize(w, h); }
      win.webContents.once('did-finish-load', () => setTimeout(async () => {
        let recording = !!rec;
        const frames = [];
        const loop = (async () => {
          let last = Date.now();
          while (recording) {
            const img = await win.webContents.capturePage();
            const name = String(frames.length).padStart(5, '0') + '.jpg';
            fs.writeFileSync(path.join(rec, name), img.toJPEG(92));
            const now = Date.now();
            frames.push([name, (now - last) / 1000]);
            last = now;
          }
        })();
        if (process.env.OBSP_EVAL) await win.webContents.executeJavaScript(process.env.OBSP_EVAL).catch(e => console.error(e));
        recording = false;
        await loop;
        if (rec) {
          // concat-demuxer list: each frame is shown until the next one was captured
          const list = frames.map(([n], i) => `file '${n}'\nduration ${(frames[i + 1] || frames[i])[1].toFixed(4)}`).join('\n');
          fs.writeFileSync(path.join(rec, 'frames.txt'), list + `\nfile '${frames[frames.length - 1][0]}'\n`);
        }
        if (shot) fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
        app.quit();
      }, Number(process.env.OBSP_SCREENSHOT_DELAY) || 5000));
    }
  }

  app.on('second-instance', (_, argv) => {
    const f = findVideoArg(argv);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (f) win.webContents.send('open-file', f);
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    Menu.setApplicationMenu(null);
    createWindow();
    if ((!process.env.OBSP_SCREENSHOT && !process.env.OBSP_RECORD) || process.env.OBSP_CHECK_UPDATES) scheduleChecks();
    setTimeout(scanMedia, 2000); // let the window and the first thumbnails go first
    setTimeout(cleanPlayable, 10000);
    if (fs.existsSync(ffmpegPath) || ffmpegPath === 'ffmpeg') setTimeout(pickEncoder, 3000);
  });

  app.on('window-all-closed', () => {
    if (job && job.state === 'running') { job.cancelled = true; job.proc.kill(); }
    if (conv && conv.state === 'running') { conv.state = 'cancelled'; conv.proc.kill(); }
    server.close();
    app.quit();
  });
}

function findVideoArg(argv) {
  return argv.slice(1).find(a => isVideo(a) && fs.existsSync(a)) || null;
}
