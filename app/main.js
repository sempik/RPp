'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu, clipboard, systemPreferences } = require('electron');
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
function fetchLatestVersion() {
  return new Promise(resolve => {
    const req = https.get(`https://api.github.com/repos/${REPO}/releases/latest`,
      { timeout: 8000, headers: { 'User-Agent': 'RPp', Accept: 'application/vnd.github+json' } }, res => {
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => {
          try { resolve(String(JSON.parse(body).tag_name || '').replace(/^v/, '') || null); } catch { resolve(null); }
        });
      });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
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
  ipcMain.handle('copy', (_, text) => clipboard.writeText(String(text).slice(0, 100)));
  ipcMain.handle('check-update', async () => {
    const v = await fetchLatestVersion();
    return v && newerThan(v, app.getVersion()) ? v : null;
  });
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

    // Build smoke test: OBSP_SCREENSHOT=<png> captures the window a few seconds after load, then exits.
    const shot = process.env.OBSP_SCREENSHOT;
    if (shot) {
      win.webContents.once('did-finish-load', () => setTimeout(async () => {
        // optional UI script for the smoke test (may return a promise)
        if (process.env.OBSP_EVAL) await win.webContents.executeJavaScript(process.env.OBSP_EVAL).catch(e => console.error(e));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(shot, img.toPNG());
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
    if (fs.existsSync(ffmpegPath) || ffmpegPath === 'ffmpeg') setTimeout(pickEncoder, 3000);
  });

  app.on('window-all-closed', () => {
    if (job && job.state === 'running') { job.cancelled = true; job.proc.kill(); }
    server.close();
    app.quit();
  });
}

function findVideoArg(argv) {
  return argv.slice(1).find(a => isVideo(a) && fs.existsSync(a)) || null;
}
