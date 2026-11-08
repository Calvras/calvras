const { app, BrowserWindow, ipcMain, dialog, shell, Menu, net } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { spawn } = require('child_process');
const url = require('url');
const crypto = require('crypto');

// ── Google OAuth config ───────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = '83662494822-odr981k7f1qs7ga63kht7a8bcv31s45v.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || (() => {
  try { return require('./oauth.config.json').clientSecret; } catch { return ''; }
})();
const REDIRECT_PORT = 9876;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

let mainWindow = null;
let authServer = null;

// ── Persist signed-in user ────────────────────────────────────────────────
const Store = (() => {
  const fs = require('fs');
  const storePath = path.join(app.getPath('userData'), 'kraken-auth.json');
  return {
    get() {
      try { return JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch { return null; }
    },
    set(data) {
      try { fs.writeFileSync(storePath, JSON.stringify(data), 'utf8'); } catch {}
    },
    clear() {
      try { fs.unlinkSync(storePath); } catch {}
    }
  };
})();


// ── Sync signed-in account with calvras.com ledger ────────────────────────
function idTokenExpired(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return !payload.exp || payload.exp * 1000 < Date.now() + 60000;
  } catch { return true; }
}

async function refreshGoogleTokens(authData) {
  if (!authData.refreshToken) return false;
  try {
    const body = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: authData.refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) return false;
    authData.accessToken = data.access_token;
    if (data.id_token) authData.idToken = data.id_token;
    Store.set(authData);
    return true;
  } catch { return false; }
}

function postSession(payload) {
  return new Promise((resolve, reject) => {
    const req = https.request('https://calvras.com/api/site/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'Kraken/9.0.0',
      },
      timeout: 12000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(data); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300 && body && body.ok) resolve(body);
        else reject(new Error((body && body.error) || `HTTP ${res.statusCode}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function syncAccountWithCalvras(authData) {
  if (!authData || !authData.email) return;
  // Ensure the idToken is fresh before trying to record the sign-in
  if (idTokenExpired(authData.idToken)) {
    const refreshed = await refreshGoogleTokens(authData);
    if (!refreshed && !authData.accessToken) {
      console.warn('[Kraken] Cannot sync: token expired and refresh failed');
      return;
    }
  }
  const payload = JSON.stringify({
    idToken: authData.idToken || '',
    accessToken: authData.accessToken || '',
    email: authData.email,
    name: authData.name || authData.email.split('@')[0],
    picture: authData.picture || '',
    platform: process.platform || 'win32',
    version: '9.0.0',
  });
  const delays = [0, 1500, 5000];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await new Promise(r => setTimeout(r, delays[attempt]));
    try {
      const body = await postSession(payload);
      if (body.session && authData.session !== body.session) {
        authData.session = body.session;
        Store.set(authData);
      }
      console.log(`[Kraken] Account synced: ${authData.email} (plan: ${body.plan || 'free'})`);
      return;
    } catch (err) {
      console.warn(`[Kraken] Account sync attempt ${attempt + 1} failed: ${err.message}`);
      // On token error, try refreshing and retry
      if (attempt === 0 && /401|token|expired|invalid/i.test(err.message)) {
        await refreshGoogleTokens(authData);
      }
    }
  }
  console.error('[Kraken] Account sync failed after 3 attempts — the admin ledger will not show this sign-in yet.');
}

// ── IPC ───────────────────────────────────────────────────────────────────
let currentWorkspaceDir = '';

ipcMain.handle('kraken:pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select the folder Kraken should work in',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  currentWorkspaceDir = result.filePaths[0];
  return currentWorkspaceDir;
});

ipcMain.handle('workspace:get-info', async () => {
  return {
    selected: Boolean(currentWorkspaceDir),
    dir: currentWorkspaceDir || '',
    name: currentWorkspaceDir ? path.basename(currentWorkspaceDir) : '',
    reachable: true,
  };
});

ipcMain.handle('workspace:set-folder', async (_event, folderPath) => {
  if (!folderPath) {
    currentWorkspaceDir = '';
    return { selected: false, dir: '', name: '', reachable: true };
  }
  if (!fs.existsSync(folderPath)) {
    throw new Error(`Directory does not exist: ${folderPath}`);
  }
  currentWorkspaceDir = folderPath;
  return {
    selected: true,
    dir: currentWorkspaceDir,
    name: path.basename(currentWorkspaceDir),
    reachable: true,
  };
});

ipcMain.handle('workspace:read', async (_event, relativeOrFullPath) => {
  if (!currentWorkspaceDir) throw new Error('No workspace folder is currently open.');
  const fullPath = path.isAbsolute(relativeOrFullPath)
    ? relativeOrFullPath
    : path.join(currentWorkspaceDir, relativeOrFullPath);
  if (!fs.existsSync(fullPath)) throw new Error(`File not found: ${relativeOrFullPath}`);
  const content = fs.readFileSync(fullPath, 'utf8');
  const stat = fs.statSync(fullPath);
  return {
    path: path.relative(currentWorkspaceDir, fullPath).replace(/\\/g, '/'),
    content,
    bytes: stat.size,
  };
});

ipcMain.handle('workspace:write', async (_event, payload) => {
  if (!currentWorkspaceDir) throw new Error('No workspace folder is currently open.');
  const targetPath = typeof payload === 'string' ? payload : (payload && payload.filePath);
  const content = typeof payload === 'object' && payload.content !== undefined ? payload.content : '';
  const fullPath = path.isAbsolute(targetPath)
    ? targetPath
    : path.join(currentWorkspaceDir, targetPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return {
    success: true,
    path: path.relative(currentWorkspaceDir, fullPath).replace(/\\/g, '/'),
    bytes: Buffer.byteLength(content, 'utf8'),
  };
});

ipcMain.handle('workspace:tree', async (_event, max = 500) => {
  if (!currentWorkspaceDir || !fs.existsSync(currentWorkspaceDir)) {
    return { entries: [] };
  }
  const entries = [];
  function scan(dir, rel = '') {
    if (entries.length >= max) return;
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (entries.length >= max) break;
        if (['node_modules', '.git', 'dist', 'build', '.cache', '.turbo'].includes(item.name)) continue;
        const itemRel = rel ? `${rel}/${item.name}` : item.name;
        if (item.isDirectory()) {
          entries.push({ path: itemRel + '/', isDir: true });
          scan(path.join(dir, item.name), itemRel);
        } else {
          entries.push({ path: itemRel, isDir: false });
        }
      }
    } catch {}
  }
  scan(currentWorkspaceDir);
  return { entries };
});

ipcMain.handle('workspace:search', async (_event, query) => {
  if (!currentWorkspaceDir || !query) return { matches: [] };
  const matches = [];
  const qLower = String(query).toLowerCase();
  function searchDir(dir, rel = '') {
    if (matches.length >= 100) return;
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (matches.length >= 100) break;
        if (['node_modules', '.git', 'dist', 'build', '.cache'].includes(item.name)) continue;
        const full = path.join(dir, item.name);
        const itemRel = rel ? `${rel}/${item.name}` : item.name;
        if (item.isDirectory()) {
          searchDir(full, itemRel);
        } else {
          try {
            const text = fs.readFileSync(full, 'utf8');
            const lines = text.split('\n');
            lines.forEach((l, idx) => {
              if (matches.length >= 100) return;
              if (l.toLowerCase().includes(qLower)) {
                matches.push({ file: itemRel, line: idx + 1, text: l.trim().slice(0, 200) });
              }
            });
          } catch {}
        }
      }
    } catch {}
  }
  searchDir(currentWorkspaceDir);
  return { matches };
});

ipcMain.handle('workspace:exec', async (_event, payload) => {
  return new Promise((resolve) => {
    const cmd = typeof payload === 'string' ? payload : (payload && payload.command);
    const cwd = (payload && payload.cwd) || currentWorkspaceDir || process.cwd();
    const startTime = Date.now();
    const isWin = process.platform === 'win32';
    const shellCmd = isWin ? 'powershell.exe' : '/bin/sh';
    const shellArgs = isWin ? ['-NoProfile', '-Command', cmd] : ['-c', cmd];
    const proc = spawn(shellCmd, shellArgs, { cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      resolve({
        stdout,
        stderr,
        exitCode: code || 0,
        success: code === 0,
        durationMs: Date.now() - startTime,
      });
    });
    proc.on('error', err => {
      resolve({
        stdout,
        stderr: err.message,
        exitCode: 1,
        success: false,
        durationMs: Date.now() - startTime,
      });
    });
  });
});

// ── In-App Auto-Update & Installer Runner ──────────────────────────────────
let isDownloadingUpdate = false;
let updateDownloadedPath = null;

function downloadFileWithRedirects(fileUrl, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    function get(currentUrl, redirectCount = 0) {
      if (redirectCount > 10) {
        return reject(new Error('Too many redirects while downloading update'));
      }
      const client = currentUrl.startsWith('https:') ? https : http;
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (err) {
        return reject(err);
      }
      const req = client.get(parsed, {
        headers: {
          'User-Agent': 'Kraken-Updater/9.0.0',
          'Accept': 'application/octet-stream, */*'
        }
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const nextUrl = new URL(res.headers.location, currentUrl).toString();
          res.resume();
          return get(nextUrl, redirectCount + 1);
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed with status ${res.statusCode}`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let receivedBytes = 0;
        let lastReportedPercent = -1;

        const fileStream = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (totalBytes > 0) {
            const percent = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
            if (percent !== lastReportedPercent) {
              lastReportedPercent = percent;
              if (onProgress) onProgress(percent, receivedBytes, totalBytes);
            }
          }
        });

        res.on('error', (err) => {
          try { fs.unlinkSync(destPath); } catch {}
          reject(err);
        });

        fileStream.on('finish', () => {
          fileStream.close(() => resolve(destPath));
        });

        fileStream.on('error', (err) => {
          try { fs.unlinkSync(destPath); } catch {}
          reject(err);
        });
      });

      req.on('error', (err) => {
        try { fs.unlinkSync(destPath); } catch {}
        reject(err);
      });
    }

    get(fileUrl);
  });
}

function runInstallerAndExit(installerPath) {
  try {
    // Use shell: true so Windows properly handles UAC elevation for NSIS installers.
    // openPath would be cleaner but does not support custom NSIS args; shell is reliable.
    const child = spawn(installerPath, [], {
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: false,
    });
    child.on('error', (err) => {
      // spawn itself errored (e.g. access denied) — try via shell as fallback
      console.warn('[Kraken] Installer spawn failed, falling back to shell open:', err.message);
      try {
        const { shell } = require('electron');
        shell.openPath(installerPath);
      } catch {}
      setTimeout(() => app.quit(), 1200);
    });
    child.unref();
    // Give the installer a moment to start before quitting
    setTimeout(() => {
      app.quit();
    }, 1000);
  } catch (err) {
    console.error('[Kraken] Failed to spawn installer:', err);
    // Last-resort: open via shell (triggers UAC via Windows shell)
    try {
      const { shell } = require('electron');
      shell.openPath(installerPath);
      setTimeout(() => app.quit(), 1500);
    } catch (shellErr) {
      console.error('[Kraken] Shell open also failed:', shellErr);
      throw err;
    }
  }
}

async function performDirectUpdate(targetUrl, targetVersion) {
  if (isDownloadingUpdate) return { status: 'already_downloading' };
  isDownloadingUpdate = true;

  try {
    let urlToDownload = targetUrl;
    if (!urlToDownload || typeof urlToDownload !== 'string') {
      try {
        const res = await fetch('https://api.github.com/repos/Calvras/calvras/releases/latest');
        if (res.ok) {
          const release = await res.json();
          const asset = (release.assets || []).find(a => a.name && a.name.endsWith('.exe'));
          if (asset && asset.browser_download_url) {
            urlToDownload = asset.browser_download_url;
          }
        }
      } catch {}
    }

    if (!urlToDownload) {
      urlToDownload = 'https://github.com/Calvras/calvras/releases/download/v9.0.0/Kraken.Setup.9.0.0.exe';
    }

    const tempInstaller = path.join(app.getPath('temp'), `Kraken-Setup-${targetVersion || '9.0.0'}-${Date.now()}.exe`);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:status', { status: 'downloading', version: targetVersion || '9.0.0' });
    }

    await downloadFileWithRedirects(urlToDownload, tempInstaller, (percent) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:progress', { percent });
      }
    });

    updateDownloadedPath = tempInstaller;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:status', { status: 'installing', version: targetVersion || '9.0.0' });
    }

    // Don't wrap in try/catch here — runInstallerAndExit handles its own fallbacks
    // and queues app.quit(), so we just need to return success and let the app die.
    runInstallerAndExit(tempInstaller);
    return { success: true };
  } catch (err) {
    isDownloadingUpdate = false;
    console.error('Direct update error:', err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:status', { status: 'error', message: err.message });
    }
    throw err;
  }
}

ipcMain.handle('updater:download-and-install', async (_event, payload) => {
  const targetUrl = typeof payload === 'string' ? payload : (payload && payload.url);
  const targetVer = typeof payload === 'object' ? payload.version : null;
  return performDirectUpdate(targetUrl, targetVer);
});

ipcMain.handle('updater:install', async (_event, directUrl) => {
  if (updateDownloadedPath && fs.existsSync(updateDownloadedPath)) {
    runInstallerAndExit(updateDownloadedPath);
    return { success: true };
  }

  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.quitAndInstall(false, true);
    return { success: true };
  } catch (err) {
    console.warn('autoUpdater.quitAndInstall threw, downloading directly:', err);
    return performDirectUpdate(directUrl);
  }
});

ipcMain.handle('app:get-version', () => {
  return app.getVersion();
});

ipcMain.handle('auth:google-signin', async () => {
  return startGoogleOAuth();
});

ipcMain.handle('auth:get-user', () => {
  return Store.get();
});

ipcMain.handle('auth:sign-out', () => {
  Store.clear();
  loadSignIn();
});

// ── Google OAuth flow ─────────────────────────────────────────────────────
function startGoogleOAuth() {
  return new Promise((resolve) => {
    // Generate PKCE code verifier + challenge
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');

    // Start local HTTP server to receive the callback
    stopAuthServer();
    authServer = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);
      if (parsed.pathname !== '/callback') {
        res.end();
        return;
      }

      // Send a nice close-page response to the browser
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
        <title>Kraken — Signed in</title>
        <style>
          body { font-family: -apple-system, sans-serif; background: #f7f6f3;
                 display: flex; align-items: center; justify-content: center;
                 min-height: 100vh; margin: 0; }
          .card { text-align: center; }
          .logo { font-size: 32px; font-weight: 800; letter-spacing: -0.03em; margin-bottom: 8px; }
          p { color: #6b7280; font-size: 15px; }
        </style></head>
        <body><div class="card">
          <div class="logo">✓ Signed in</div>
          <p>You can close this tab and return to Kraken.</p>
        </div></body></html>`);

      stopAuthServer();

      const { code, state: returnedState, error } = parsed.query;

      if (error || returnedState !== state) {
        const msg = error || 'State mismatch — possible CSRF.';
        if (mainWindow) mainWindow.webContents.send('auth:error', msg);
        resolve({ success: false, error: msg });
        return;
      }

      // Exchange code for tokens
      try {
        const tokens = await exchangeCode(code, codeVerifier);
        const user = await fetchUserInfo(tokens.access_token);
        const authData = { ...user, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token || '' };
        Store.set(authData);
        syncAccountWithCalvras(authData);

        if (mainWindow) mainWindow.webContents.send('auth:success', authData);
        loadMainApp(authData);
        resolve({ success: true, user: authData });
      } catch (err) {
        if (mainWindow) mainWindow.webContents.send('auth:error', err.message);
        resolve({ success: false, error: err.message });
      }
    });

    authServer.listen(REDIRECT_PORT, '127.0.0.1', () => {
      // Build the Google authorization URL
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'openid email profile');
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'select_account');

      // Open in the user's default browser
      shell.openExternal(authUrl.toString());
    });

    authServer.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

function stopAuthServer() {
  if (authServer) {
    try { authServer.close(); } catch {}
    authServer = null;
  }
}

async function exchangeCode(code, codeVerifier) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token exchange failed');
  return data;
}

async function fetchUserInfo(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Failed to fetch user info');
  return { name: data.name, email: data.email, picture: data.picture, sub: data.sub };
}

// ── Window helpers ────────────────────────────────────────────────────────
function windowDefaults() {
  return {
    width: 1380,
    height: 880,
    minWidth: 1000,
    minHeight: 650,
    backgroundColor: '#f7f6f3',
    title: 'Kraken',
    center: true,
    show: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      webviewTag: true,
    },
    autoHideMenuBar: true,
  };
}

function loadSignIn() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = new BrowserWindow(windowDefaults());
    Menu.setApplicationMenu(null);
    mainWindow.on('closed', () => { mainWindow = null; });
  }
  mainWindow.loadFile(path.join(__dirname, 'signin.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

function loadMainApp(user) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = new BrowserWindow(windowDefaults());
    Menu.setApplicationMenu(null);
    mainWindow.on('closed', () => { mainWindow = null; });
  }
  mainWindow.loadFile(path.join(__dirname, 'app.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(true);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(false);
        // Pass user info to the renderer
        mainWindow.webContents.send('auth:user', user);
      }
    }, 1500);

    // Auto-updater
    try {
      const { autoUpdater } = require('electron-updater');
      const log = require('electron-log');
      autoUpdater.logger = log;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('update-available', (info) => {
        if (mainWindow) mainWindow.webContents.send('updater:status', { status: 'available', version: info.version });
      });
      autoUpdater.on('download-progress', (p) => {
        if (mainWindow) mainWindow.webContents.send('updater:progress', { percent: Math.round(p.percent) });
      });
      autoUpdater.on('update-downloaded', (info) => {
        if (mainWindow) mainWindow.webContents.send('updater:status', { status: 'downloaded', version: info.version });
      });
      setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
      setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 2 * 60 * 60 * 1000);
    } catch {}
  });
}

// ── App startup ───────────────────────────────────────────────────────────
function createWindow() {
  Menu.setApplicationMenu(null);

  const saved = Store.get();
  if (saved && saved.email) {
    // Already signed in — refresh stale tokens, sync to calvras.com, go straight to app
    (async () => {
      if (idTokenExpired(saved.idToken)) await refreshGoogleTokens(saved);
      await syncAccountWithCalvras(saved);
    })();
    loadMainApp(saved);
  } else {
    // Not signed in — show sign-in page
    loadSignIn();
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopAuthServer();
  if (process.platform !== 'darwin') app.quit();
});
