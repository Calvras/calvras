const { app, BrowserWindow, ipcMain, dialog, shell, Menu, net, webContents, nativeImage, screen } = require('electron');
const { createBrowserTools } = require('./electron/browser-tools.cjs');
const { createExecutionPolicy } = require('./electron/execution-policy.cjs');
const { createGitHubConnection } = require('./electron/github-connection.cjs');
const { createPetWindow } = require('./electron/pet-window.cjs');
const { createDocument } = require('./electron/document-tools.cjs');
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

const APP_VERSION = '9.4.0';
const previousUserData = app.getPath('userData');
app.setName('Calvras');
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const profile = path.join(app.getPath('appData'), 'Calvras');
  const hasProfileData = dir => ['kraken-auth.json', 'calvras-auth.json', 'Local Storage'].some(entry => fs.existsSync(path.join(dir, entry)));
  const legacyProfile = !hasProfileData(profile) && [previousUserData, path.join(app.getPath('appData'), 'Kraken'), path.join(app.getPath('appData'), 'tanstack_start_ts')]
    .find(dir => dir !== profile && hasProfileData(dir));
  // Keep the existing Chromium profile so an upgrade cannot strand chats or cookies.
  app.setPath('userData', legacyProfile || profile);
}

const Store = (() => {
  const storePath = path.join(app.getPath('userData'), 'calvras-auth.json');
  const legacyPath = path.join(app.getPath('userData'), 'kraken-auth.json');
  try {
    if (!fs.existsSync(storePath) && fs.existsSync(legacyPath)) {
      const data = fs.readFileSync(legacyPath, 'utf8');
      JSON.parse(data);
      fs.writeFileSync(storePath, data, { flag: 'wx', mode: 0o600 });
      fs.unlinkSync(legacyPath);
    }
  } catch (error) {
    console.warn('[Calvras] Saved sign-in migration could not complete:', error.code || 'invalid data');
  }
  return {
    get() {
      try { return JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch { return null; }
    },
    set(data) {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify(data), { mode: 0o600 });
    },
    clear() {
      fs.rmSync(storePath, { force: true });
      fs.rmSync(legacyPath, { force: true });
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
      signal: AbortSignal.timeout(12000),
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
        'User-Agent': 'Calvras/9.4.0',
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
      console.warn('[Calvras] Cannot sync: token expired and refresh failed');
      return;
    }
  }
  const delays = [0, 1500, 5000];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await new Promise(r => setTimeout(r, delays[attempt]));
    try {
      const body = await postSession(JSON.stringify({
        idToken: authData.idToken || '',
        accessToken: authData.accessToken || '',
        platform: process.platform,
        version: APP_VERSION,
      }));
      if (body.session && authData.session !== body.session) {
        authData.session = body.session;
        Store.set(authData);
      }
      console.log('[Calvras] Account synced.');
      return;
    } catch (err) {
      console.warn(`[Calvras] Account sync attempt ${attempt + 1} failed: ${err.message}`);
      // On token error, try refreshing and retry
      if (attempt === 0 && /401|token|expired|invalid/i.test(err.message)) {
        await refreshGoogleTokens(authData);
      }
    }
  }
  console.error('[Calvras] Account sync failed after 3 attempts — the admin ledger will not show this sign-in yet.');
}

// ── IPC ───────────────────────────────────────────────────────────────────
let currentWorkspaceDir = '';

// ── Workspace preview server ──────────────────────────────────────────────
// Serves the active workspace over loopback so preview:index.html works even
// when the user has no dev server running.
const PREVIEW_MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const previewServer = http.createServer((req, res) => {
  if (!currentWorkspaceDir) { res.writeHead(404); res.end('No workspace open'); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end(); return; }
  const root = path.resolve(currentWorkspaceDir);
  let fullPath = path.resolve(root, '.' + pathname);
  if (fullPath !== root && !fullPath.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    if (fs.statSync(fullPath).isDirectory()) fullPath = path.join(fullPath, 'index.html');
    const body = fs.readFileSync(fullPath);
    res.writeHead(200, { 'Content-Type': PREVIEW_MIME[path.extname(fullPath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});
previewServer.listen(0, '127.0.0.1');
const previewOriginReady = new Promise((resolve) => {
  previewServer.once('listening', () => resolve(`http://127.0.0.1:${previewServer.address().port}`));
});
ipcMain.handle('workspace:preview-origin', () => previewOriginReady);

function requireAppSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== url.pathToFileURL(path.join(__dirname, 'app.html')).href) throw new Error('Only the Calvras app can use this action.');
}

const executionPolicy = createExecutionPolicy({
  onRequest: request => mainWindow.webContents.send('approval:request', request),
  onSettled: result => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('approval:settled', result); },
});
const runningCommands = new Set();
let commandGeneration = 0;
ipcMain.handle('approval:mode', (event, mode) => {
  requireAppSender(event);
  return mode === undefined ? executionPolicy.getMode() : executionPolicy.setMode(mode);
});
ipcMain.handle('approval:respond', (event, response) => {
  requireAppSender(event);
  return executionPolicy.respond(response);
});
ipcMain.handle('agent:cancel', event => {
  requireAppSender(event);
  commandGeneration++;
  executionPolicy.cancel();
  for (const stop of runningCommands) stop();
});
let githubConnection;
function getGitHubConnection() {
  if (!githubConnection) githubConnection = createGitHubConnection({
    statePath: path.join(app.getPath('userData'), 'github-consent.json'),
    onStatus: state => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('github:status', state); },
  });
  return githubConnection;
}
for (const method of ['status', 'connect', 'cancel', 'disconnect']) {
  ipcMain.handle('github:' + method, (event) => {
    requireAppSender(event);
    return getGitHubConnection()[method]();
  });
}

let desktopPet;
function getDesktopPet() {
  if (!desktopPet) desktopPet = createPetWindow({ BrowserWindow, ipcMain, Menu, screen, getMainWindow: () => mainWindow,
    positionPath: path.join(app.getPath('userData'), 'pet-position.json'),
    onEnabledChange: state => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pet:status', state); } });
  return desktopPet;
}
ipcMain.handle('pet:status', event => { requireAppSender(event); return getDesktopPet().status(); });
ipcMain.handle('pet:enabled', (event, enabled) => {
  requireAppSender(event);
  if (typeof enabled !== 'boolean') throw new Error('Pet visibility must be true or false.');
  return getDesktopPet().setEnabled(enabled);
});
ipcMain.handle('pet:activity', (event, activity) => { requireAppSender(event); return getDesktopPet().setActivity(activity); });

let browserTools;
function getBrowserTools() {
  if (!browserTools) browserTools = createBrowserTools({ BrowserWindow, webContents, nativeImage, getMainWindow: () => mainWindow,
    beforeAction: async action => {
      const generation = commandGeneration;
      // Full access (Turbo) dispatches browser actions without asking; other modes confirm each mutation.
      if (executionPolicy.getMode() !== 'Turbo') {
        const detail = `${action.action} ${action.selector || 'page'}\n${action.url}\n${action.text || (typeof action.value === 'string' ? action.value : '')}`.trim();
        await executionPolicy.authorize(detail, { force: true, title: 'Allow browser action?', reason: 'This interaction may change an account or submit information. Page label: ' + action.target.label });
      }
      if (generation !== commandGeneration) throw new Error('Browser action cancelled before dispatch.');
    } });
  return browserTools;
}

for (const method of ['inspect', 'action', 'capture', 'diagnostics', 'compare']) {
  ipcMain.handle('browser:' + method, async (event, payload) => {
    requireAppSender(event);
    const result = await getBrowserTools()[method](payload);
    if (!result.ok) throw new Error(result.summary);
    return result;
  });
}
ipcMain.handle('browser:login', async (event, payload) => {
  requireAppSender(event);
  const inspected = await getBrowserTools().inspect(payload);
  if (!inspected.ok) throw new Error(inspected.summary);
  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'question', title: 'Sign in to this site',
    message: 'Open a private sign-in window for ' + new URL(inspected.url).hostname + '?',
    detail: 'Enter credentials yourself. Calvras does not read passwords or sign you in automatically. Pages and images you later ask it to inspect are sent to the AI provider. This session is separate from your normal browser.',
    buttons: ['Open sign-in', 'Cancel'], defaultId: 1, cancelId: 1,
  });
  if (answer.response !== 0) throw new Error('Site sign-in was cancelled.');
  const result = await getBrowserTools().login(payload);
  if (!result.ok) throw new Error(result.summary);
  return result;
});

ipcMain.handle('workspace:replace', (event, payload) => {
  requireAppSender(event);
  const { filePath, oldText, newText } = payload || {};
  if (!currentWorkspaceDir) throw new Error('Select a workspace first.');
  if (typeof filePath !== 'string' || path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes('.git')) throw new Error('Use a workspace-relative source file.');
  if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string') throw new Error('Provide nonempty oldText and string newText.');
  const root = fs.realpathSync(currentWorkspaceDir);
  const target = fs.realpathSync(path.resolve(root, filePath));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('The file must stay inside the workspace.');
  if (fs.statSync(target).size > 2 * 1024 * 1024) throw new Error('Exact edits support text files up to 2 MB.');
  const before = fs.readFileSync(target, 'utf8');
  const index = before.indexOf(oldText);
  if (index < 0 || before.indexOf(oldText, index + 1) >= 0) throw new Error('oldText must match exactly once; read the file and include more context.');
  const after = before.slice(0, index) + newText + before.slice(index + oldText.length);
  fs.writeFileSync(target, after, 'utf8');
  return { path: relative, replaced: 1, bytes: Buffer.byteLength(after) };
});

ipcMain.handle('document:create', async (event, input) => {
  requireAppSender(event);
  const generation = commandGeneration;
  return createDocument({ BrowserWindow, root: currentWorkspaceDir || path.join(app.getPath('documents'), 'Calvras'), input,
    isCancelled: () => generation !== commandGeneration || !mainWindow || mainWindow.isDestroyed() });
});
ipcMain.handle('document:reveal', (event, filePath) => {
  requireAppSender(event);
  if (typeof filePath !== 'string' || !['.pdf', '.docx'].includes(path.extname(filePath).toLowerCase())) throw new Error('Only generated document files can be revealed.');
  const target = fs.realpathSync(filePath);
  const roots = [currentWorkspaceDir, path.join(app.getPath('documents'), 'Calvras')].filter(root => root && fs.existsSync(root));
  if (!roots.some(root => { const relative = path.relative(fs.realpathSync(root), target); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); })) throw new Error('Document is outside the current output folders.');
  shell.showItemInFolder(target);
  return { revealed: true };
});

ipcMain.handle('browser:open-external', async (event, target) => {
  requireAppSender(event);
  if (!isSitePreviewUrl(target)) throw new Error('Only HTTP or HTTPS pages can open in your browser.');
  await shell.openExternal(new URL(target).href);
  return { opened: true };
});

// Search providers send no CORS headers, so fetch them from the main process.
ipcMain.handle('web:fetch', async (_event, payload) => {
  const url = String((payload && payload.url) || '');
  if (!/^https:\/\//i.test(url)) return { ok: false, status: 0, text: '' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = (await res.text()).slice(0, 2000000);
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: '', error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
});

ipcMain.handle('calvras:pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select the folder Calvras should work in',
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

ipcMain.handle('workspace:open-explorer', async () => {
  if (!currentWorkspaceDir) return { ok: false, error: 'No workspace folder is open.' };
  const err = await shell.openPath(currentWorkspaceDir);
  return { ok: !err, error: err || '' };
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

ipcMain.handle('workspace:git-inspect', async (event, kind) => {
  requireAppSender(event);
  const commands = {
    branch: ['rev-parse', '--abbrev-ref', 'HEAD'],
    status: ['status', '--porcelain'],
    stats: ['diff', '--no-ext-diff', '--no-textconv', '--numstat', 'HEAD'],
    diff: ['diff', '--no-ext-diff', '--no-textconv'],
    staged: ['diff', '--no-ext-diff', '--no-textconv', '--cached'],
    pr: ['pr', 'view', '--json', 'number,state,title'],
  };
  if (!Object.hasOwn(commands, kind) || !currentWorkspaceDir) throw new Error('Select a workspace and a supported Git inspection.');
  if (kind === 'pr' && !(await getGitHubConnection().status()).connected) return { stdout: '', stderr: 'Connect GitHub to view pull requests.', success: false, exitCode: 1 };
  const env = { ...process.env, GH_PROMPT_DISABLED: '1' };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[key];
  return new Promise(resolve => {
    const proc = spawn(kind === 'pr' ? 'gh' : 'git', commands[kind], { cwd: currentWorkspaceDir, env, windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => proc.kill(), 15000);
    proc.stdout.on('data', data => { stdout = (stdout + data).slice(0, 2 * 1024 * 1024); });
    proc.stderr.on('data', data => { stderr = (stderr + data).slice(0, 4096); });
    proc.once('error', () => { clearTimeout(timer); resolve({ stdout: '', stderr: 'Git inspection could not start.', success: false, exitCode: 1 }); });
    proc.once('close', code => { clearTimeout(timer); resolve({ stdout, stderr, success: code === 0, exitCode: code }); });
  });
});

ipcMain.handle('workspace:exec', async (event, payload) => {
  requireAppSender(event);
  const cmd = typeof payload === 'string' ? payload : (payload && payload.command);
  const generation = commandGeneration;
  const cwd = (payload && payload.cwd) || currentWorkspaceDir || process.cwd();
  await executionPolicy.authorize(cmd, { reason: 'Run in ' + cwd + '. Review the exact command before allowing it.' });
  let commandEnv = process.env;
  if ((await getGitHubConnection().status()).connected) commandEnv = await getGitHubConnection().credentialEnvironment();
  requireAppSender(event);
  if (generation !== commandGeneration) throw new Error('Command cancelled before execution.');
  return new Promise((resolve) => {
    const timeoutMs = Math.max(1000, Number(payload && payload.timeoutMs) || 30000);
    const background = Boolean(payload && payload.background);
    const startTime = Date.now();
    const isWin = process.platform === 'win32';
    const shellCmd = isWin ? 'powershell.exe' : '/bin/sh';
    const shellArgs = isWin ? ['-NoProfile', '-Command', cmd] : ['-c', cmd];

    // On Windows, detached:true makes console apps (powershell) exit instantly,
    // so background servers stay attached + hidden and are unref'd after drain.
    const proc = spawn(shellCmd, shellArgs, { cwd, env: commandEnv, detached: background && !isWin, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer = null;
    let drainTimer = null;
    const stop = () => {
      if (proc.exitCode !== null) return;
      if (isWin) spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
      else proc.kill('SIGKILL');
    };
    runningCommands.add(stop);
    proc.once('close', () => runningCommands.delete(stop));
    proc.once('error', () => runningCommands.delete(stop));

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const settle = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      resolve({
        stdout,
        stderr,
        exitCode: code == null ? 0 : code,
        success: !timedOut && (code == null || code === 0),
        durationMs: Date.now() - startTime,
        timedOut,
        background: code == null && background,
      });
    };

    proc.on('close', settle);
    proc.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: err.message,
        exitCode: 1,
        success: false,
        durationMs: Date.now() - startTime,
        timedOut,
        background: false,
      });
    });

    // Explicit background (run:bg:) — drain 5 s so the server can bind, then
    // let it keep running for the live preview.
    if (background) {
      proc.unref();
      drainTimer = setTimeout(() => settle(null), 5000);
      return;
    }

    // Timer: at zero the whole process tree is stopped and the AI receives
    // everything captured up to that point.
    timer = setTimeout(() => {
      timedOut = true;
      if (isWin) {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
      } else {
        proc.kill('SIGKILL');
      }
      setTimeout(() => settle(1), 3000);
    }, timeoutMs);
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
          'User-Agent': 'Calvras-Updater/9.4.0',
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
      console.warn('[Calvras] Installer spawn failed, falling back to shell open:', err.message);
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
    console.error('[Calvras] Failed to spawn installer:', err);
    // Last-resort: open via shell (triggers UAC via Windows shell)
    try {
      const { shell } = require('electron');
      shell.openPath(installerPath);
      setTimeout(() => app.quit(), 1500);
    } catch (shellErr) {
      console.error('[Calvras] Shell open also failed:', shellErr);
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
      urlToDownload = 'https://github.com/Calvras/calvras/releases/download/v9.4.0/Calvras.Setup.9.4.0.exe';
    }

    const tempInstaller = path.join(app.getPath('temp'), `Calvras-Setup-${targetVersion || '9.4.0'}-${Date.now()}.exe`);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:status', { status: 'downloading', version: targetVersion || '9.4.0' });
    }

    await downloadFileWithRedirects(urlToDownload, tempInstaller, (percent) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:progress', { percent });
      }
    });

    updateDownloadedPath = tempInstaller;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:status', { status: 'installing', version: targetVersion || '9.4.0' });
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
  return APP_VERSION;
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

ipcMain.handle('quota:status', async (event) => {
  requireAppSender(event);
  const auth = Store.get();
  if (!auth || !auth.session) return { ok: false, signedIn: false };
  try {
    const res = await fetch('https://calvras.com/api/site/quota', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: auth.session }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return { ok: res.ok, signedIn: true, ...data };
  } catch { return { ok: false, signedIn: true, error: 'Could not reach calvras.com' }; }
});

ipcMain.handle('quota:session', (event) => {
  requireAppSender(event);
  const auth = Store.get();
  return auth?.session || '';
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
        <title>Calvras — Signed in</title>
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
          <p>You can close this tab and return to Calvras.</p>
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
  if (!res.ok || !data.email || !data.sub || data.email_verified !== true) throw new Error('Google did not return a verified email address.');
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
    title: 'Calvras',
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
    mainWindow.on('closed', () => { commandGeneration++; executionPolicy.cancel(); desktopPet?.dispose(); desktopPet = null; githubConnection?.dispose(); githubConnection = null; browserTools?.dispose(); browserTools = null; mainWindow = null; });
  }
  getBrowserTools();
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
    mainWindow.on('closed', () => { commandGeneration++; executionPolicy.cancel(); desktopPet?.dispose(); desktopPet = null; githubConnection?.dispose(); githubConnection = null; browserTools?.dispose(); browserTools = null; mainWindow = null; });
  }
  getBrowserTools();
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

function isSitePreviewUrl(value) {
  try {
    const parsed = new URL(value);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event, preferences, params) => {
    if (!isSitePreviewUrl(params.src)) {
      event.preventDefault();
      return;
    }
    delete preferences.preload;
    preferences.nodeIntegration = false;
    preferences.nodeIntegrationInSubFrames = false;
    preferences.contextIsolation = true;
    preferences.sandbox = true;
    preferences.webSecurity = true;
    preferences.allowRunningInsecureContent = false;
  });
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guardNavigation = (event, target) => {
    if (!isSitePreviewUrl(target)) event.preventDefault();
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.on('will-download', event => event.preventDefault());
});

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
