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

  // Google sign-in through the system browser, answering when the account comes back
  googleSignIn: () => ipcRenderer.invoke('google-sign-in'),

  // Agent-controlled browser: set a real file on a page's <input type=file>
  browserSetFileInput: (webContentsId, selector, projectRoot, relativePath) => ipcRenderer.invoke('browser-set-file-input', webContentsId, selector, projectRoot, relativePath),
  // Bring a document the user named (outside the workspace) into the project, with their confirmation
  importUserFile: (projectRoot, sourcePath) => ipcRenderer.invoke('import-user-file', projectRoot, sourcePath),
  // Read a file that is already inside the workspace back as a data URL
  readWorkspaceFile: (projectRoot, relativePath) => ipcRenderer.invoke('read-workspace-file', projectRoot, relativePath),
  // Agent-controlled browser: capture the visible page (or the whole document) as a data URL
  browserCapturePage: (webContentsId, fullPage) => ipcRenderer.invoke('browser-capture-page', webContentsId, fullPage),

  // One-click desktop screenshot for "Look at my screen"
  captureScreen: () => ipcRenderer.invoke('capture-screen'),

  // Server URL
  getServerUrl: () => ipcRenderer.invoke('get-server-url'),

  // Settings the main process applies: sleep, menu bar, LAN binding, OS panels
  setPreventSleep: (on) => ipcRenderer.invoke('app-set-prevent-sleep', on),
  setKeepInMenuBar: (on) => ipcRenderer.invoke('app-set-tray', on),
  setRemoteControl: (on) => ipcRenderer.invoke('app-set-remote-control', on),
  setDeviceName: (name) => ipcRenderer.invoke('app-set-device-name', name),
  networkInfo: () => ipcRenderer.invoke('app-network-info'),
  openSystemNotifications: () => ipcRenderer.invoke('app-open-system-notifications'),
  openExternal: (url) => ipcRenderer.invoke('app-open-url', url),

  // Updates: the page reads the published feed, then asks here to write the installer and start it.
  appVersion: () => ipcRenderer.invoke('app-version'),
  updateDownload: (payload) => ipcRenderer.invoke('update-download', payload),
  updateInstall: (file) => ipcRenderer.invoke('update-install', file),
  onUpdateState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('update-state', listener);
    return () => ipcRenderer.removeListener('update-state', listener);
  },

  // Platform info
  platform: process.platform,
  chromeVersion: process.versions.chrome,
});
