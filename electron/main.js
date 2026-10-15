'use strict';

// Electron Main Process — Calvras Desktop
// Spawns the Nitro node-server, opens a frameless BrowserWindow.

const {
  app, BrowserWindow, shell, dialog, ipcMain, Tray, Menu,
  globalShortcut, nativeImage, screen, safeStorage,
} = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const net  = require('net');
const fs   = require('fs');
const os   = require('os');

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
const PUBLIC_DIR = IS_DEV
  ? path.join(ROOT, '.output', 'public')
  : path.join(ROOT, 'public');

const BOUNDS_FILE = path.join(app.getPath('userData'), 'window-bounds.json');
const KEY_FILE    = path.join(app.getPath('userData'), 'secure.bin');

// ─── State ───────────────────────────────────────────────────────────────────
let mainWindow   = null;
let tray         = null;
let serverProcess = null;
let serverPort   = 3344;

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
function waitForServer(port, retries = 60, delayMs = 500) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      const req = http.get(`http://127.0.0.1:${port}`, (res) => {
        // Any non-5xx response means the server is alive
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

// ─── Start Nitro server ───────────────────────────────────────────────────────
function startServer(port) {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`Server entry not found: ${SERVER_ENTRY}\nRun "npm run build:electron" first.`);
  }

  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      NITRO_PRESET: 'node-server',
    },
    stdio: 'pipe',
    windowsHide: true,
  });

  serverProcess.stdout?.on('data', (d) => console.log('[nitro]', d.toString().trim()));
  serverProcess.stderr?.on('data', (d) => console.error('[nitro]', d.toString().trim()));

  serverProcess.on('exit', (code, signal) => {
    console.error(`[nitro] Server exited (code=${code}, signal=${signal})`);
    if (mainWindow && !app.isQuitting) {
      restartServer();
    }
  });
}

async function restartServer() {
  serverProcess = null;
  try {
    serverPort = await findFreePort(serverPort + 1);
    startServer(serverPort);
    await waitForServer(serverPort);
    if (mainWindow) mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  } catch (e) {
    if (mainWindow) {
      mainWindow.loadURL('about:blank');
      mainWindow.webContents.executeJavaScript(
        `document.body.style.cssText="background:#0d0d0d;color:#e0e0e0;font:15px/1.6 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0";document.body.innerHTML='<div style="text-align:center"><h1>Server error</h1><p>${String(e.message).replace(/'/g, "\\'")} </p><button onclick="location.reload()" style="margin-top:12px;padding:8px 20px;border-radius:8px;border:0;background:#e0e0e0;cursor:pointer">Retry</button></div>'`
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
    width: Math.max(savedBounds?.width ?? 1280, 980),
    height: Math.max(savedBounds?.height ?? 820, 620),
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 980,
    minHeight: 620,
    frame: false,           // frameless — custom title bar drag region in renderer
    titleBarStyle: 'hidden',
    backgroundColor: '#0d0d0d',
    show: false,
    icon: path.join(ROOT, 'public', 'calvras-logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: IS_DEV,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  };

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  // ── Show when ready ───────────────────────────────────────────────────────
  mainWindow.once('ready-to-show', () => {
    
    if (savedBounds?.maximized) mainWindow.maximize();
    mainWindow.show();
    mainWindow.focus();
  });

  // ── Persist bounds ────────────────────────────────────────────────────────
  mainWindow.on('close', () => {
    const b = mainWindow.getBounds();
    saveBounds({ ...{ ...b }, maximized: mainWindow.isMaximized() });
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // ── Block external navigation — open in OS browser ───────────────────────
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

  // ── Content Security Policy ───────────────────────────────────────────────
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
          `font-src 'self' data:;`
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
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]));

  tray.on('double-click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

// ─── Application menu ─────────────────────────────────────────────────────────
function buildAppMenu() {
  const template = [
    {
      label: 'Calvras',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(IS_DEV ? [{ role: 'toggleDevTools' }] : []),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── IPC: Window controls (title bar buttons in renderer) ─────────────────────
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());

// ─── IPC: Secure storage (API keys via OS credential store) ──────────────────
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

// ─── IPC: Open project folder dialog ─────────────────────────────────────────
ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Open project folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

// ─── IPC: Get server URL ──────────────────────────────────────────────────────
ipcMain.handle('get-server-url', () => `http://127.0.0.1:${serverPort}`);

// ─── IPC: Is maximized ────────────────────────────────────────────────────────
ipcMain.handle('is-maximized', () => mainWindow?.isMaximized() ?? false);

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  buildAppMenu();

  // Find free port & start server
  try {
    serverPort = await findFreePort(3344);
    startServer(serverPort);
    await waitForServer(serverPort, 60, 500);
  } catch (err) {
    
    dialog.showErrorBox(
      'Calvras — Server Error',
      'The local server failed to start.\n\n' + err.message +
      '\n\nMake sure you have run "npm run build:electron" first.'
    );
    app.quit();
    return;
  }

  createTray();
  createMainWindow(serverPort);

  // ── Global shortcuts ───────────────────────────────────────────────────────
  globalShortcut.register('CommandOrControl+N', () => {
    if (mainWindow) {
      mainWindow.webContents.executeJavaScript(
        `window.__calvrasNewChat && window.__calvrasNewChat()`
      ).catch(() => {});
    }
  });

  globalShortcut.register('CommandOrControl+O', () => {
    ipcMain.emit('pick-folder-shortcut');
  });

  app.on('activate', () => {
    if (!mainWindow) createMainWindow(serverPort);
    else { mainWindow.show(); mainWindow.focus(); }
  });
});

// ── Second instance: focus existing window ────────────────────────────────────
app.on('second-instance', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
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
    try { serverProcess.kill('SIGTERM'); } catch {}
    serverProcess = null;
  }
});

app.on('will-quit', () => {
  if (serverProcess) {
    try { serverProcess.kill('SIGTERM'); } catch {}
    serverProcess = null;
  }
});
