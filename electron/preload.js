'use strict';

// Preload — context-isolated bridge from renderer to main process
// contextIsolation: true, sandbox: true, nodeIntegration: false

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__electron', {
  // Window controls
  minimize:    () => ipcRenderer.send('window-minimize'),
  maximize:    () => ipcRenderer.send('window-maximize'),
  close:       () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('is-maximized'),

  // Secure API key storage (OS credential store)
  safeGet: (key)        => ipcRenderer.invoke('safe-get', key),
  safeSet: (key, value) => ipcRenderer.invoke('safe-set', key, value),

  // Native folder picker
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  // Server URL
  getServerUrl: () => ipcRenderer.invoke('get-server-url'),

  // Platform info
  platform: process.platform,
});
