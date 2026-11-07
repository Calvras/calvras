const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = 8080;
const APP_DIR = __dirname;

// The agent only works inside a folder the user explicitly selected.
// No silent fallback to the app's own directory.
let workspaceDir = null;

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache',
  'coverage', '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'target',
]);

const MAX_READ_BYTES = 1024 * 1024;
const MAX_EXEC_OUTPUT = 200000;

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function workspaceInfo() {
  return {
    selected: Boolean(workspaceDir),
    dir: workspaceDir,
    name: workspaceDir ? path.basename(workspaceDir) : null,
  };
}

function requireWorkspace() {
  if (!workspaceDir) {
    const err = new Error('No workspace folder is selected.');
    err.code = 'NO_WORKSPACE';
    throw err;
  }
  return workspaceDir;
}

// Resolve a user-supplied path inside the workspace. Absolute paths and ../
// escapes are rejected — the agent can only touch the selected folder.
function resolveInWorkspace(relPath) {
  const base = path.resolve(requireWorkspace());
  const target = path.resolve(base, relPath || '.');
  const inside = target === base || target.startsWith(base + path.sep);
  if (!inside) {
    const err = new Error(`Path is outside the workspace: ${relPath}`);
    err.code = 'OUTSIDE_WORKSPACE';
    throw err;
  }
  return target;
}

function relativeToWorkspace(fullPath) {
  const rel = path.relative(requireWorkspace(), fullPath);
  return rel.split(path.sep).join('/');
}

function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return false;
  }
  return true;
}

function walkWorkspace(options = {}) {
  const root = requireWorkspace();
  const maxEntries = options.maxEntries || 600;
  const maxDepth = options.maxDepth === undefined ? 4 : options.maxDepth;
  const files = [];

  function walk(dir, depth) {
    if (files.length >= maxEntries || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (files.length >= maxEntries) return;
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        files.push({ path: rel + '/', type: 'dir' });
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch (err) { size = 0; }
        files.push({ path: rel, type: 'file', size });
      }
    }
  }

  walk(root, 0);
  return files;
}

function searchWorkspace(query, limit = 100) {
  const root = requireWorkspace();
  const needle = String(query || '');
  if (!needle) return [];
  const lower = needle.toLowerCase();
  const matches = [];

  function walk(dir) {
    if (matches.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= limit) return;
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try { stat = fs.statSync(full); } catch (err) { continue; }
      if (stat.size > 1024 * 1024) continue;
      let buffer;
      try { buffer = fs.readFileSync(full); } catch (err) { continue; }
      if (!isProbablyText(buffer)) continue;
      const lines = buffer.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toLowerCase().includes(lower)) {
          matches.push({
            file: path.relative(root, full).split(path.sep).join('/'),
            line: i + 1,
            text: lines[i].trim().slice(0, 300),
          });
          if (matches.length >= limit) break;
        }
      }
    }
  }

  walk(root);
  return matches;
}

function runCommand(command) {
  return new Promise((resolve) => {
    if (!command.trim()) {
      resolve({
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: 'No command was provided.',
        durationMs: 0,
        cwd: workspaceDir,
      });
      return;
    }
    const startedAt = Date.now();
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { cwd: requireWorkspace(), timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        let out = stdout || '';
        let err = stderr || '';
        if (out.length > MAX_EXEC_OUTPUT) out = out.slice(0, MAX_EXEC_OUTPUT) + '\n… output truncated';
        if (err.length > MAX_EXEC_OUTPUT) err = err.slice(0, MAX_EXEC_OUTPUT) + '\n… output truncated';

        let exitCode = 0;
        if (error) {
          exitCode = typeof error.code === 'number' ? error.code : 1;
          if (error.killed) {
            exitCode = 124;
            err = (err ? err + '\n' : '') + 'Command timed out after 60 seconds.';
          }
        }
        resolve({
          success: exitCode === 0,
          exitCode,
          stdout: out,
          stderr: err,
          durationMs,
          cwd: workspaceDir,
        });
      }
    );
    child.stdin && child.stdin.end();
  });
}

function pickFolderDialog() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ path: null, error: 'The folder picker is only implemented for Windows.' });
      return;
    }
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dialog.Description = 'Select the folder Kraken should work in'",
      '$dialog.ShowNewFolderButton = $false',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
    ].join('; ');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', script],
      { timeout: 180000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ path: null, error: (stderr || error.message || 'Folder picker failed.').trim() });
          return;
        }
        const picked = (stdout || '').trim();
        resolve({ path: picked || null, error: null });
      }
    );
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  if (pathname.startsWith('/api/workspace/')) {
    res.setHeader('Content-Type', 'application/json');

    try {
      if (pathname === '/api/workspace/info') {
        sendJson(res, 200, workspaceInfo());
        return;
      }

      if (pathname === '/api/workspace/pick-folder' && req.method === 'POST') {
        const result = await pickFolderDialog();
        if (result.error) {
          sendJson(res, 500, { error: result.error });
          return;
        }
        sendJson(res, 200, { path: result.path, cancelled: !result.path });
        return;
      }

      if (pathname === '/api/workspace/set-folder' && req.method === 'POST') {
        const data = await parseJsonBody(req);
        const folderPath = (data.folderPath || '').trim();
        if (!folderPath) {
          sendJson(res, 400, { error: 'folderPath is required.' });
          return;
        }
        const resolved = path.resolve(folderPath);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          sendJson(res, 404, { error: `Folder does not exist: ${resolved}` });
          return;
        }
        workspaceDir = resolved;
        sendJson(res, 200, { success: true, ...workspaceInfo() });
        return;
      }

      if (pathname === '/api/workspace/clear-folder' && req.method === 'POST') {
        workspaceDir = null;
        sendJson(res, 200, { success: true, ...workspaceInfo() });
        return;
      }

      // Every endpoint below needs a selected folder.
      requireWorkspace();

      if (pathname === '/api/workspace/files') {
        const files = fs.readdirSync(workspaceDir)
          .filter(name => !name.startsWith('.') && !IGNORED_DIRS.has(name))
          .map(name => {
            const full = path.join(workspaceDir, name);
            const stat = fs.statSync(full);
            return { name, isDirectory: stat.isDirectory(), size: stat.size };
          });
        sendJson(res, 200, { files, dir: workspaceDir, name: path.basename(workspaceDir) });
        return;
      }

      if (pathname === '/api/workspace/tree') {
        const maxEntries = Math.min(Number(urlObj.searchParams.get('max')) || 600, 2000);
        sendJson(res, 200, { entries: walkWorkspace({ maxEntries }), dir: workspaceDir });
        return;
      }

      if (pathname === '/api/workspace/search') {
        const query = urlObj.searchParams.get('q') || '';
        const matches = searchWorkspace(query, 100);
        sendJson(res, 200, { query, matches, count: matches.length });
        return;
      }

      if (pathname === '/api/workspace/read' && req.method === 'POST') {
        const data = await parseJsonBody(req);
        const target = resolveInWorkspace(data.filePath);
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          sendJson(res, 404, { error: `File not found: ${data.filePath}` });
          return;
        }
        const stat = fs.statSync(target);
        if (stat.size > MAX_READ_BYTES) {
          sendJson(res, 413, { error: `File is too large to read (${stat.size} bytes, limit ${MAX_READ_BYTES}).` });
          return;
        }
        const content = fs.readFileSync(target, 'utf8');
        sendJson(res, 200, {
          success: true,
          content,
          path: relativeToWorkspace(target),
          absolutePath: target,
          bytes: stat.size,
          lines: content.split('\n').length,
        });
        return;
      }

      if (pathname === '/api/workspace/write' && req.method === 'POST') {
        const data = await parseJsonBody(req);
        const target = resolveInWorkspace(data.filePath);
        const existed = fs.existsSync(target);
        if (existed && fs.statSync(target).isDirectory()) {
          sendJson(res, 400, { error: `Path is a directory: ${data.filePath}` });
          return;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data.content == null ? '' : String(data.content), 'utf8');
        const written = fs.readFileSync(target, 'utf8');
        sendJson(res, 200, {
          success: true,
          path: relativeToWorkspace(target),
          absolutePath: target,
          created: !existed,
          lines: written.split('\n').length,
        });
        return;
      }

      if (pathname === '/api/workspace/exec' && req.method === 'POST') {
        const data = await parseJsonBody(req);
        const result = await runCommand(String(data.command || ''));
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: `Unknown workspace endpoint: ${pathname}` });
      return;
    } catch (err) {
      const status = err.code === 'NO_WORKSPACE' ? 409
        : err.code === 'OUTSIDE_WORKSPACE' ? 403
        : 500;
      sendJson(res, status, { error: err.message });
      return;
    }
  }

  // ---- Static files (the app itself + the preview iframe) ----
  let reqPath = pathname === '/' || pathname === '' ? '/app.html' : pathname;
  const safeDecoded = decodeURIComponent(reqPath);
  let filePath = null;

  if (workspaceDir) {
    try {
      const candidate = path.resolve(workspaceDir, '.' + safeDecoded);
      if (candidate.startsWith(path.resolve(workspaceDir) + path.sep) &&
          fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        filePath = candidate;
      }
    } catch (err) { /* fall through to app dir */ }
  }

  if (!filePath) {
    const candidate = path.resolve(APP_DIR, '.' + safeDecoded);
    if (candidate.startsWith(APP_DIR + path.sep) &&
        fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      filePath = candidate;
    }
  }

  if (filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`Kraken agent server listening on http://localhost:${PORT}`);
  console.log(`Workspace: ${workspaceDir || 'none selected yet'}`);
});
