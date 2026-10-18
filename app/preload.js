'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Strip Electron's "Error invoking remote method 'x': Error: " prefix so the UI shows clean messages.
const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a).catch(e => {
  throw new Error(String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
});

contextBridge.exposeInMainWorld('native', {
  base: () => call('base'),
  info: () => call('info'),
  list: dir => call('list', dir),
  cut: opts => call('cut', opts),
  status: () => call('status'),
  cancel: () => call('cancel'),
  reveal: p => call('reveal', p),
  openDialog: () => call('open-dialog'),
  initialFile: () => call('initial-file'),
  trash: p => call('trash', p),
  ocr: png => call('ocr', png),
  feedback: m => call('feedback', m),
  probe: p => call('probe', p),
  playable: (p, mode) => call('playable', p, mode),
  playableStatus: () => call('playable-status'),
  playableCancel: () => call('playable-cancel'),
  media: () => call('media'),
  rescan: () => call('rescan'),
  onMedia: cb => ipcRenderer.on('media', (_, m) => cb(m)),
  onMediaProgress: cb => ipcRenderer.on('media-progress', (_, p) => cb(p)),
  getUpdate: () => call('get-update'),
  installUpdate: () => call('install-update'),
  onUpdate: cb => ipcRenderer.on('update', (_, u) => cb(u)),
  onShowUpdate: cb => ipcRenderer.on('show-update', () => cb()),
  onUpdateProgress: cb => ipcRenderer.on('update-progress', (_, p) => cb(p)),
  openSite: () => call('open-site'),
  copy: text => call('copy', text),
  thumb: p => call('thumb', p),
  chromeMode: mode => call('chrome-mode', mode),
  pathForFile: file => webUtils.getPathForFile(file),
  onOpenFile: cb => ipcRenderer.on('open-file', (_, p) => cb(p)),
});
