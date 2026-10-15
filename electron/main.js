'use strict';

// Electron Main Process — Calvras Desktop
// Uses utilityProcess to spawn the Nitro server (works in packaged app).

const {
  app, BrowserWindow, shell, dialog, ipcMain, Tray, Menu,
  globalShortcut, nativeImage, screen, safeStorage, utilityProcess,
} = require('electron');
const path = require('path');
const http = require('http');
const net  = require('net');
const fs   = require('fs');

// ─── Single-instance lock ─────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ─── Constants ───────────────────────────────────────────────────────────────
const IS_DEV = !app.isPackaged;
const ROOT   = IS_DEV
  ? path.join(__dirname, '..')
  : process.resourcesPath;
const SERVER_ENTRY = IS_DEV
  ? path.join(ROOT, '.output', 'server', 'index.mjs')
  : path.join(ROOT, 'server', 'index.mjs');

const BOUNDS_FILE = path.join(app.getPath('userData'), 'window-bounds.json');
const KEY_FILE    = path.join(app.getPath('userData'), 'secure.bin');

// ─── State ───────────────────────────────────────────────────────────────────
let mainWindow    = null;
let tray          = null;
let serverProcess = null;
let serverPort    = 3344;

// ─── Free-port finder ────────────────────────────────────────────────────────
function findFreePort(preferred = 3344) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(preferred, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', () => {
      const srv2 = net.createServer();
      srv2.listen(0, '127.0.0.1', () => {
        const { port } = srv2.address();
        srv2.close(() => resolve(port));
      });
      srv2.on('error', reject);
    });
  });
}

// ─── Server health poll ───────────────────────────────────────────────────────
function waitForServer(port, retries = 80, delayMs = 500) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      const req = http.get(`http://127.0.0.1:${port}`, (res) => {
        if (res.statusCode < 500) {
          resolve();
        } else {
          res.resume();
          retry(remaining);
        }
      });
      req.on('error', () => retry(remaining));
      req.setTimeout(800, () => { req.destroy(); retry(remaining); });
    };
    const retry = (remaining) => {
      if (remaining <= 0) return reject(new Error('Nitro server did not start in time'));
      setTimeout(() => attempt(remaining - 1), delayMs);
    };
    attempt(retries);
  });
}

// ─── Start Nitro server via utilityProcess ────────────────────────────────────
// utilityProcess runs the Electron Node.js runtime — works correctly in packaged
// apps where process.execPath is the app .exe, not a standalone node binary.
function startServer(port) {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`Server entry not found: ${SERVER_ENTRY}`);
  }

  serverProcess = utilityProcess.fork(SERVER_ENTRY, [], {
    env: {
      ...process.env,
      PORT:          String(port),
      HOST:          '127.0.0.1',
      NODE_ENV:      'production',
      NITRO_PRESET:  'node-server',
    },
    stdio: 'pipe',
  });

  serverProcess.stdout?.on('data', (d) => console.log('[nitro]', d.toString().trim()));
  serverProcess.stderr?.on('data', (d) => console.error('[nitro]', d.toString().trim()));

  serverProcess.on('exit', (code) => {
    console.error(`[nitro] exited (code=${code})`);
    if (mainWindow && !app.isQuitting) restartServer();
  });
}

async function restartServer() {
  serverProcess = null;
  try {
    serverPort = await findFreePort(serverPort + 1);
    startServer(serverPort);
    await waitForServer(serverPort);
    if (mainWindow) mainWindow.loadURL(`http://127.0.0.1:${serverPort}/app`);
  } catch (e) {
    if (mainWindow) {
      mainWindow.loadURL('about:blank');
      mainWindow.webContents.executeJavaScript(
        `document.body.style.cssText="background:#0d0d0d;color:#e0e0e0;font:15px/1.6 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0";` +
        `document.body.innerHTML='<div style="text-align:center"><h2>Server error</h2><p>${String(e.message).replace(/'/g, "\\'")} </p><button onclick="location.reload()" style="margin-top:12px;padding:8px 20px;border-radius:8px;border:0;background:#e0e0e0;cursor:pointer">Retry</button></div>'`
      ).catch(() => {});
    }
  }
}

// ─── Persisted window bounds ──────────────────────────────────────────────────
function loadBounds() {
  try {
    if (fs.existsSync(BOUNDS_FILE)) {
      const b = JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8'));
      const allBounds = screen.getAllDisplays().map((d) => d.bounds);
      const onScreen = allBounds.some(
        (db) =>
          b.x >= db.x && b.y >= db.y &&
          b.x + b.width <= db.x + db.width &&
          b.y + b.height <= db.y + db.height
      );
      if (onScreen) return b;
    }
  } catch {}
  return null;
}

function saveBounds(win) {
  try {
    fs.writeFileSync(BOUNDS_FILE, JSON.stringify(win.getBounds()), 'utf8');
  } catch {}
}

// ─── Main window ──────────────────────────────────────────────────────────────
function createMainWindow(port) {
  const savedBounds = loadBounds();
  const windowOptions = {
    width:    Math.max(savedBounds?.width  ?? 1280, 980),
    height:   Math.max(savedBounds?.height ?? 820,  620),
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth:  980,
    minHeight: 620,
    frame:         false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0d0d0d',
    show: false,
    icon: path.join(ROOT, 'public', 'calvras-logo.png'),
    webPreferences: {
      preload:         path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
      devTools:         IS_DEV,
      webSecurity:      true,
      allowRunningInsecureContent: false,
    },
  };

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.loadURL(`http://127.0.0.1:${port}/app`);

  mainWindow.once('ready-to-show', () => {
    if (savedBounds?.maximized) mainWindow.maximize();
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('close', () => {
    saveBounds({ ...mainWindow.getBounds(), maximized: mainWindow.isMaximized() });
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // Internal links stay in-app; external ones open in browser
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Content Security Policy
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self' http://127.0.0.1:${port};` +
          `script-src 'self' 'unsafe-inline' 'unsafe-eval' http://127.0.0.1:${port};` +
          `style-src 'self' 'unsafe-inline';` +
          `img-src 'self' data: blob: https: http://127.0.0.1:${port};` +
          `connect-src 'self' http://127.0.0.1:${port} https:;` +
          `font-src 'self' data:;`,
        ],
      },
    });
  });

  return mainWindow;
}

// ─── System Tray ─────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(ROOT, 'public', 'calvras-logo.png');
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('Calvras');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open Calvras',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        else createMainWindow(serverPort);
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));

  tray.on('double-click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

// ─── IPC: Window controls ─────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());

// ─── IPC: Secure storage ──────────────────────────────────────────────────────
ipcMain.handle('safe-get', async (_e, key) => {
  try {
    if (!fs.existsSync(KEY_FILE)) return null;
    const store = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    const encrypted = store[key];
    if (!encrypted) return null;
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
      : encrypted;
  } catch { return null; }
});

ipcMain.handle('safe-set', async (_e, key, value) => {
  try {
    let store = {};
    if (fs.existsSync(KEY_FILE)) store = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    const encrypted = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(value).toString('base64')
      : value;
    store[key] = encrypted;
    fs.writeFileSync(KEY_FILE, JSON.stringify(store), 'utf8');
    return true;
  } catch { return false; }
});

// ─── IPC: Native folder picker ────────────────────────────────────────────────
ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Open project folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

// ─── IPC: Misc ────────────────────────────────────────────────────────────────
ipcMain.handle('get-server-url', () => `http://127.0.0.1:${serverPort}`);
ipcMain.handle('is-maximized',   () => mainWindow?.isMaximized() ?? false);

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Frameless — no native menu bar
  Menu.setApplicationMenu(null);

  try {
    serverPort = await findFreePort(3344);
    startServer(serverPort);
    await waitForServer(serverPort, 80, 500);
  } catch (err) {
    dialog.showErrorBox(
      'Calvras — Server Error',
      'The local server failed to start.\n\n' + err.message
    );
    app.quit();
    return;
  }

  createTray();
  createMainWindow(serverPort);

  // Global shortcuts
  globalShortcut.register('CommandOrControl+N', () => {
    mainWindow?.webContents.executeJavaScript(
      `window.__calvrasNewChat && window.__calvrasNewChat()`
    ).catch(() => {});
  });

  app.on('activate', () => {
    if (!mainWindow) createMainWindow(serverPort);
    else { mainWindow.show(); mainWindow.focus(); }
  });
});

app.on('second-instance', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  else createMainWindow(serverPort);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.isQuitting = true;
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  if (serverProcess) {
    try { serverProcess.kill(); } catch {}
    serverProcess = null;
  }
});

app.on('will-quit', () => {
  if (serverProcess) {
    try { serverProcess.kill(); } catch {}
    serverProcess = null;
  }
});
