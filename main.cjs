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

// ── IPC ───────────────────────────────────────────────────────────────────
ipcMain.handle('kraken:pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select the folder Kraken should work in',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
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
          'User-Agent': 'Kraken-Updater/5.0.0',
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
    const child = spawn(installerPath, [], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    setTimeout(() => {
      app.quit();
    }, 800);
  } catch (err) {
    console.error('Failed to spawn installer:', err);
    throw err;
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
      urlToDownload = 'https://github.com/Calvras/calvras/releases/download/v5.0.0/Kraken.Setup.5.0.0.exe';
    }

    const tempInstaller = path.join(app.getPath('temp'), `Kraken-Setup-${targetVersion || '5.0.0'}-${Date.now()}.exe`);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:status', { status: 'downloading', version: targetVersion || '5.0.0' });
    }

    await downloadFileWithRedirects(urlToDownload, tempInstaller, (percent) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:progress', { percent });
      }
    });

    updateDownloadedPath = tempInstaller;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:status', { status: 'installing', version: targetVersion || '5.0.0' });
    }

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
        const authData = { ...user, accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
        Store.set(authData);

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
    // Already signed in — go straight to app
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
