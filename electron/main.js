'use strict';

// Electron Main Process — Calvras Desktop
// Uses utilityProcess to spawn the Nitro server (works in packaged app).

const {
  app, BrowserWindow, shell, dialog, ipcMain, Tray, Menu,
  globalShortcut, nativeImage, screen, safeStorage, utilityProcess, webContents, desktopCapturer, powerSaveBlocker,
} = require('electron');
const path = require('path');
const http = require('http');
const net  = require('net');
const os   = require('os');
const fs   = require('fs');
const { signInWithGoogle } = require('./google-oauth.cjs');

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
// Settings the renderer cannot apply by itself: which address the local server binds
// to, and whether the app lives in the menu bar. Read once at boot, written live.
const APP_SETTINGS_FILE = path.join(app.getPath('userData'), 'app-settings.json');

function readAppSettings() {
  try { return JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function writeAppSettings(patch) {
  const next = { ...readAppSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(APP_SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(APP_SETTINGS_FILE + '.tmp', JSON.stringify(next));
    fs.renameSync(APP_SETTINGS_FILE + '.tmp', APP_SETTINGS_FILE);
  } catch (error) { console.error('[MAIN] Could not persist app settings:', error.message); }
  return next;
}
function lanAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const entry of addresses || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '';
}

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
    let settled = false;
    const attempt = (remaining) => {
      if (settled) return;
      let retried = false;
      const retryOnce = () => {
        if (settled || retried) return;
        retried = true;
        retry(remaining);
      };
      const req = http.get(`http://127.0.0.1:${port}/api/agent/providers`, (res) => {
        req.setTimeout(0);
        res.resume();
        if (res.statusCode < 500) {
          settled = true;
          resolve();
        } else {
          retryOnce();
        }
      });
      req.on('error', retryOnce);
      req.setTimeout(800, () => { req.destroy(); retryOnce(); });
    };
    const retry = (remaining) => {
      if (settled) return;
      if (remaining <= 0) { settled = true; return reject(new Error('Nitro server did not start in time')); }
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
      // Remote control is the only reason to answer on the LAN; everything else stays loopback.
      HOST:          readAppSettings().remoteControl ? '0.0.0.0' : '127.0.0.1',
      CALVRAS_REMOTE: readAppSettings().remoteControl ? '1' : '0',
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
    if (mainWindow) mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
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
    width:    1280,
    height:   820,
    center:   true,
    frame:         false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0d0d0d',
    show: true,
    icon: path.join(ROOT, 'public', 'calvras-logo.png'),
    webPreferences: {
      preload:         path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
      devTools:         IS_DEV,
      webSecurity:      true,
      webviewTag:       true,
      allowRunningInsecureContent: false,
    },
  };

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  mainWindow.show();
  mainWindow.restore();
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(true);
  setTimeout(() => {
    if (mainWindow) mainWindow.setAlwaysOnTop(false);
  }, 1000);

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[MAIN] Window finished loading the workspace');
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    console.error('[MAIN] Window failed to load:', code, desc);
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

  // In-app browser: never let a page attach a preload or Node privileges.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (params.src && !/^(https?:|about:blank)/i.test(params.src)) event.preventDefault();
  });

  // Links that request a new window open in the same agent browser tab instead.
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void contents.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Content Security Policy — only the Calvras app needs it. External pages inside
  // the agent browser must keep their own headers or they will not load.
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    let appOrigin = false;
    try { appOrigin = new URL(details.url).origin === `http://127.0.0.1:${port}`; } catch {}
    if (!appOrigin) return callback({ responseHeaders: details.responseHeaders });
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self' http://127.0.0.1:${port};` +
          `script-src 'self' 'unsafe-inline' 'unsafe-eval' http://127.0.0.1:${port};` +
          `style-src 'self' 'unsafe-inline';` +
          `img-src 'self' data: blob: https: http://127.0.0.1:${port};` +
          `connect-src 'self' http://127.0.0.1:${port} https:;` +
          `font-src 'self' data:;` +
          `frame-src https: http:;`,
        ],
      },
    });
  });

  return mainWindow;
}

// ─── System Tray ─────────────────────────────────────────────────────────────
function trayLabel() {
  const name = String(readAppSettings().deviceName || '').trim();
  return name ? `Calvras — ${name}` : 'Calvras';
}
function createTray() {
  if (tray) return;
  const iconPath = path.join(ROOT, 'public', 'calvras-logo.png');
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip(trayLabel());
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

function destroyTray() {
  if (!tray) return;
  tray.destroy();
  tray = null;
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

// ─── IPC: Google sign-in ──────────────────────────────────────────────────────
// Both values live beside the provider keys rather than in the bundle, so the same install
// can be repointed at another Google project without a rebuild. Google issues a secret for
// desktop clients and its token endpoint insists on it; PKCE remains the real proof that the
// browser and this process are the same app.
const googleOAuthConfig = () => {
  try {
    const dir = path.join(process.env['LOCALAPPDATA'] || path.join(os.homedir(), '.local', 'share'), 'Calvras');
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'google-oauth.json'), 'utf8'));
    return { clientId: stored.clientId || null, clientSecret: stored.clientSecret || undefined };
  } catch { return { clientId: null }; }
};

/** Chrome holds the foreground after the redirect, so a plain focus() can be ignored by
 *  Windows. Bouncing always-on-top is what actually drags the window back over the browser. */
const raiseMainWindow = () => {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(false);
};

/**
 * The page used to tell calvras.com about its own sign-in. The window reloads into the
 * workspace the moment a sign-in succeeds and Chromium drops whatever request was still in flight,
 * which is how accounts signed in for a day without a single one reaching the owner's ledger. The
 * shell does it now: it has the ID token anyway, never navigates, and can keep trying — and a sign-in
 * the site never confirmed is replayed on the next launch. See electron/site-report.cjs.
 */
const PENDING_SIGNIN_FILE = path.join(app.getPath('userData'), 'pending-signin.bin');
const { createSignInReport } = require('./site-report.cjs');
const signInReport = createSignInReport({
  fs,
  file: PENDING_SIGNIN_FILE,
  storage: safeStorage,
  getInfo: () => ({ platform: process.platform, version: app.getVersion() }),
});

ipcMain.handle('google-sign-in', async () => {
  try {
    const { clientId, clientSecret } = googleOAuthConfig();
    const profile = await signInWithGoogle({
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      openBrowser: (url) => shell.openExternal(url),
      // Come back the moment Google answers, not only on success — otherwise a cancelled or
      // failed sign-in leaves the user stranded in the browser with no window to return to.
      onReturn: raiseMainWindow,
    });
    raiseMainWindow();
    return { ok: true, ...profile, site: await signInReport.report(profile.idToken) };
  } catch (error) {
    raiseMainWindow();
    return { ok: false, error: error instanceof Error ? error.message : 'Google sign-in failed.' };
  }
});

// ─── IPC: Agent browser ───────────────────────────────────────────────────────
const MIME_BY_EXT = {
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

/**
 * Resolves a document the user pointed at into something the workspace can attach.
 * A path already inside the project is used as-is; anything else needs the user's
 * explicit approval in a native dialog, then is copied in. The page never receives a
 * path the user did not confirm, so a hostile site cannot have Calvras read their disk.
 */
async function importUserFile(projectRoot, sourcePath) {
  let root;
  try { root = await fs.promises.realpath(projectRoot); } catch { throw new Error('The workspace folder is not available.'); }
  const requested = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(root, sourcePath);
  let source;
  try { source = await fs.promises.realpath(requested); } catch {
    throw new Error(`Nothing exists at "${requested}". Re-check the path with the user, or ask them to drop the file into the project.`);
  }
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw new Error(`"${source}" is a folder, not a file.`);
  if (stat.size > 25 * 1024 * 1024) throw new Error('That file is larger than 25 MB.');
  const inside = path.relative(root, source);
  if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) {
    return { source, relativePath: inside.split(path.sep).join('/'), copied: false, size: stat.size };
  }
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Allow', 'Don\'t allow'],
    defaultId: 0,
    cancelId: 1,
    title: 'Calvras wants to use a file',
    message: 'Allow Calvras to use this file for the task?',
    detail: `${source}\n\nCalvras copies it into the project so the page can receive it. It is not sent anywhere except the page you are looking at.`,
  });
  if (choice.response !== 0) throw new Error(`The user did not allow "${path.basename(source)}". Ask them which file to use instead.`);
  const staged = path.join(root, '.calvras', 'uploads', path.basename(source));
  await fs.promises.mkdir(path.dirname(staged), { recursive: true });
  await fs.promises.copyFile(source, staged);
  return { source: await fs.promises.realpath(staged), relativePath: `.calvras/uploads/${path.basename(source)}`, copied: true, size: (await fs.promises.stat(staged)).size };
}

ipcMain.handle('import-user-file', async (_e, projectRoot, sourcePath) => {
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) throw new Error('Select a workspace folder first.');
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new Error('Give the file to import.');
  const result = await importUserFile(projectRoot, sourcePath);
  return { ok: true, ...result };
});

/** Reads a file already inside the workspace back as a data URL so the renderer can
 *  run its existing PDF/text extraction on a document the user pointed at on disk. */
ipcMain.handle('read-workspace-file', async (_e, projectRoot, relativePath) => {
  if (typeof projectRoot !== 'string' || typeof relativePath !== 'string' || !relativePath.trim()) throw new Error('Provide the workspace folder and the file to read.');
  const root = await fs.promises.realpath(projectRoot).catch(() => { throw new Error('The workspace folder is not available.'); });
  const file = await fs.promises.realpath(path.resolve(root, relativePath)).catch(() => { throw new Error(`Nothing exists at "${relativePath}" inside the workspace.`); });
  const inside = path.relative(root, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Only files inside the workspace can be read this way.');
  const stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw new Error('That path is not a file.');
  if (stat.size > 25 * 1024 * 1024) throw new Error('That file is larger than 25 MB.');
  const mime = MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return { ok: true, dataUrl: `data:${mime};base64,${(await fs.promises.readFile(file)).toString('base64')}`, name: path.basename(file), size: stat.size };
});

ipcMain.handle('browser-set-file-input', async (_e, id, selector, projectRoot, relativePath) => {
  if (!Number.isInteger(id) || typeof selector !== 'string' || !selector.trim() || selector.length > 2000) throw new Error('Invalid browser upload request.');
  const target = webContents.fromId(id);
  if (!target || target.isDestroyed()) throw new Error('The in-app browser is not open.');
  if (typeof projectRoot !== 'string' || typeof relativePath !== 'string' || !relativePath.trim()) throw new Error('Provide the workspace folder and the file to upload.');
  const { source: resolved, relativePath: attached } = await importUserFile(projectRoot, relativePath);
  const dbg = target.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
    await dbg.sendCommand('DOM.enable');
    const { root: document } = await dbg.sendCommand('DOM.getDocument');
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: document.nodeId, selector });
    if (!nodeId) throw new Error('No file input matched that selector.');
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [resolved] });
    return { ok: true, path: attached };
  } finally {
    // detach() is synchronous in this Electron version — it returns void, so .catch() on it
    // threw a TypeError that replaced whatever the upload had just done.
    if (dbg.isAttached()) dbg.detach();
  }
});

ipcMain.handle('browser-capture-page', async (_e, id, fullPage = false) => {
  if (!Number.isInteger(id)) throw new Error('Invalid browser capture request.');
  const target = webContents.fromId(id);
  if (!target || target.isDestroyed()) throw new Error('The in-app browser is not open.');
  if (fullPage) {
    const dbg = target.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
      await dbg.sendCommand('Page.enable');
      const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      return { image: `data:image/png;base64,${shot.data}` };
    } catch { /* fall back to a viewport capture below */ }
    finally { if (dbg.isAttached()) dbg.detach(); }
  }
  const image = await target.capturePage();
  const size = image.getSize();
  return { image: image.toDataURL(), width: size.width, height: size.height };
});

// ─── IPC: Screen capture for "Look at my screen" ─────────────────────────────
ipcMain.handle('capture-screen', async () => {
  const primary = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(primary.size.width * primary.scaleFactor), height: Math.round(primary.size.height * primary.scaleFactor) },
  });
  if (!sources.length) throw new Error('No screen is available to capture.');
  const source = sources.find((item) => String(item.display_id) === String(primary.id)) || sources[0];
  const image = source.thumbnail;
  const size = image.getSize();
  if (!size.width || !size.height) throw new Error('The screen capture came back empty.');
  return { image: image.toDataURL(), width: size.width, height: size.height };
});

// ─── IPC: Misc ────────────────────────────────────────────────────────────────
ipcMain.handle('get-server-url', () => `http://127.0.0.1:${serverPort}`);

// ─── IPC: Settings that only the main process can apply ──────────────────────
let sleepBlockerId = null;
function applyPreventSleep(on) {
  if (on) {
    if (sleepBlockerId === null || !powerSaveBlocker.isStarted(sleepBlockerId)) sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
  return sleepBlockerId !== null;
}
ipcMain.handle('app-set-prevent-sleep', (_event, on) => {
  writeAppSettings({ preventSleep: Boolean(on) });
  return applyPreventSleep(Boolean(on));
});

ipcMain.handle('app-set-tray', (_event, on) => {
  writeAppSettings({ keepInMenuBar: Boolean(on) });
  if (on) createTray(); else destroyTray();
  return Boolean(tray);
});

/** The device name is the label the menu-bar icon carries, so the main process owns it. */
ipcMain.handle('app-set-device-name', (_event, name) => {
  writeAppSettings({ deviceName: String(name || '').slice(0, 64) });
  tray?.setToolTip(trayLabel());
  return { label: trayLabel(), inMenuBar: Boolean(tray) };
});

/** Binding the LAN address happens when the server process is spawned, so the renderer
 * reports honestly that a restart is what applies it. */
ipcMain.handle('app-set-remote-control', (_event, on) => {
  writeAppSettings({ remoteControl: Boolean(on) });
  return { saved: readAppSettings().remoteControl === true, lanUrl: `http://${lanAddress() || 'this-computer'}:${serverPort}/`, needsRestart: true };
});

ipcMain.handle('app-network-info', () => ({ lanAddress: lanAddress(), port: serverPort, remoteControl: readAppSettings().remoteControl === true }));

ipcMain.handle('app-open-system-notifications', async () => {
  const target = process.platform === 'win32' ? 'ms-settings:notifications'
    : process.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.preference.notifications' : '';
  if (!target) return { ok: false, message: 'This platform has no notification panel to open.' };
  try { await shell.openExternal(target); return { ok: true }; }
  catch (error) { return { ok: false, message: error.message }; }
});

ipcMain.handle('app-open-url', async (_event, url) => {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return { ok: false, message: 'Not a valid URL.' }; }
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return { ok: false, message: 'Only web and mail links can be opened.' };
  try { await shell.openExternal(parsed.toString()); return { ok: true }; }
  catch (error) { return { ok: false, message: error.message }; }
});
ipcMain.handle('is-maximized',   () => mainWindow?.isMaximized() ?? false);

// ─── Updates ──────────────────────────────────────────────────────────────────
// The page reads the published feed at calvras.com/update.json and decides whether a newer build
// exists. This process carries only the two steps a sandboxed page cannot do: write the installer
// to disk, then start it. The feed's answer is never trusted — a download has to come back as a
// Windows program, and the only file that may be launched is one written into the updates folder.
const { spawn: spawnUpdate } = require('child_process');
const { downloadInstaller } = require('./update-core.cjs');
const UPDATE_DIR = path.join(app.getPath('userData'), 'updates');
const sendUpdateState = (payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-state', payload); };

ipcMain.handle('app-version', () => app.getVersion());

// Two downloads of the same file write over each other: the second opens the half-written
// installer again, the first can no longer read back its own magic bytes, and the page is left
// showing a percentage nobody is finishing. One installer download is allowed at a time, and a
// repeated request joins the one already running.
let activeDownload = null;

async function runUpdateDownload(url, destination) {
  // A streamed installer arrives in 16 KB pieces, so the byte-level progress is reported far more
  // often than the bar can show. Only a changed percentage crosses IPC.
  let lastPercent = -1;
  try {
    const { file, bytes } = await downloadInstaller(url, destination, {
      onProgress: (progress) => {
        if (progress.percent === lastPercent) return;
        lastPercent = progress.percent;
        sendUpdateState({ state: 'downloading', ...progress });
      },
    });
    sendUpdateState({ state: 'ready', file, bytes });
    return { ok: true, file, bytes };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The update could not be downloaded.';
    sendUpdateState({ state: 'failed', error: message });
    return { ok: false, error: message };
  }
}

ipcMain.handle('update-download', async (_event, payload) => {
  const url = String((payload && payload.url) || '');
  const version = String((payload && payload.version) || '').replace(/[^\d.]/g, '');
  if (!/^https:\/\//i.test(url)) return { ok: false, error: 'The published download link is not a secure address.' };
  const destination = path.join(UPDATE_DIR, `Calvras-Setup-${version || 'new'}.exe`);
  if (activeDownload && activeDownload.destination === destination) return activeDownload.promise;
  const promise = runUpdateDownload(url, destination).finally(() => {
    if (activeDownload && activeDownload.promise === promise) activeDownload = null;
  });
  activeDownload = { destination, promise };
  return promise;
});
ipcMain.handle('update-install', async (_event, file) => {
  const resolved = path.resolve(String(file || ''));
  if (path.dirname(resolved) !== UPDATE_DIR || !/\.exe$/i.test(resolved)) return { ok: false, error: 'That is not a Calvras update file.' };
  if (!fs.existsSync(resolved)) return { ok: false, error: 'The downloaded update is no longer on this disk.' };
  try {
    // Silent, always. An interactive wizard let the person pick a folder, and Setup's default folder
    // moves with elevation, so updating from a machine-wide copy installed a second per-user copy and
    // the icon reopened the old one — the update looked like it had been thrown away.
    //
    // This process has to be gone before Setup can replace these files, so the app cannot relaunch
    // itself: a detached shell waits for the installer to finish and then opens the copy Setup wrote.
    // Setup always writes the per-user folder now, so that is the copy to open afterwards even on the
    // first update from an old machine-wide install, which has not created it yet.
    const relaunch = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Calvras', 'Calvras.exe')
      : process.execPath;
    const script = `Start-Process -FilePath '${resolved.replace(/'/g, "''")}' -ArgumentList '/SILENT','/NORESTART','/SUPPRESSMSGBOXES' -Wait; Start-Process -FilePath '${relaunch.replace(/'/g, "''")}'`;
    const child = spawnUpdate('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (error) {
    return { ok: false, error: `The installer could not start: ${error.message}` };
  }
  // The installer replaces these files, so this process has to get out of the way.
  app.quit();
  return { ok: true };
});

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Frameless — no native menu bar
  Menu.setApplicationMenu(null);

  try {
    serverPort = await findFreePort(3344);
    console.log('[MAIN] Starting server on port', serverPort);
    startServer(serverPort);
    console.log('[MAIN] Waiting for server...');
    await waitForServer(serverPort, 80, 500);
    console.log('[MAIN] Server ready!');
  } catch (err) {
    console.error('[MAIN] Server failed:', err);
    dialog.showErrorBox(
      'Calvras — Server Error',
      'The local server failed to start.\n\n' + err.message
    );
    app.quit();
    return;
  }

  console.log('[MAIN] Creating tray and main window...');
  // A sign-in the site never got round to answering is reported again here, in the background, so the
  // boot is never held up by a network that was down on the first try.
  void signInReport.replay();
  if (readAppSettings().keepInMenuBar) createTray();
  // The renderer keeps its switch state in localStorage, so the main process has to re-apply
  // the sleep blocker here or the setting only works until the next restart.
  applyPreventSleep(readAppSettings().preventSleep === true);
  createMainWindow(serverPort);
  console.log('[MAIN] createMainWindow completed.');

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
