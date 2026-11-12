'use strict';

const fs = require('node:fs');
const childProcess = require('node:child_process');

const STATUS_ARGS = ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts',
  '--jq', '.hosts["github.com"] | map({active, state, login, scopes, tokenSource})'];
const LOGIN_ARGS = ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol',
  'https', '--skip-ssh-key', '--scopes', 'repo'];
const TOKEN_VARS = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']);
const LOGIN_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const LIMIT = 64 * 1024;
const fail = (message) => new Error(message);
const MESSAGES = {
  cancelled: 'GitHub connection cancelled.',
  disposed: 'GitHub connection is disposed.',
  cli: 'GitHub CLI could not complete the request.',
  missing: 'GitHub CLI (gh) is not installed or could not be started.',
  timeout: 'GitHub CLI timed out. Please try connecting again.',
  output: 'GitHub CLI exceeded the output limit.',
  unsafe: 'Unsafe credential storage: GitHub requires a secure keyring, not environment or plaintext credentials. Configure secure storage and reconnect.',
  changed: 'The active GitHub account changed or is no longer authorized. Reconnect to approve it.',
  scope: 'GitHub login requires a valid account with the repo scope.',
  consent: 'Unable to save or clear GitHub connection consent.',
  required: 'Connect and approve a secure GitHub account first.',
};
const safeMessages = new Set(Object.values(MESSAGES));
const cleanEnvironment = (source) => Object.fromEntries(Object.entries(source)
  .filter(([key]) => !TOKEN_VARS.has(key.toUpperCase())));

// Main-process only. Persist app consent, never gh credentials or CLI output.
function createGitHubConnection({ statePath, onStatus = () => {}, spawnImpl = childProcess.spawn, env = process.env }) {
  if (typeof statePath !== 'string' || !statePath) throw fail('A GitHub consent statePath is required.');
  let approved = null;
  let revision = 0;
  let disposed = false;
  let connecting = null;
  let checking = null;
  let loginProcess = null;
  const processes = new Set();
  let state = { connected: false, connecting: false, login: null, code: null, error: null, message: null };
  try {
    const fd = fs.openSync(statePath, 'r');
    try {
      const buffer = Buffer.alloc(1025);
      const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const value = size <= 1024 ? JSON.parse(buffer.subarray(0, size).toString('utf8')) : null;
      if (value && Object.keys(value).length === 1 && typeof value.login === 'string' && LOGIN_PATTERN.test(value.login)) approved = value.login;
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code !== 'ENOENT') state.error = 'Unable to read GitHub connection consent.';
  }
  const snapshot = () => ({ ...state });
  function publish(patch) {
    state = { ...state, ...patch };
    try { onStatus(snapshot()); } catch { /* UI observers cannot control authentication. */ }
    return snapshot();
  }
  function clearConsent() {
    approved = null;
    try { fs.unlinkSync(statePath); return true; } catch (error) { return error.code === 'ENOENT'; }
  }
  function live(id) {
    if (disposed || id !== revision) throw fail(disposed ? MESSAGES.disposed : MESSAGES.cancelled);
  }
  function disconnected(error, message = null) {
    return publish({ connected: false, connecting: false, login: null, code: null, error, message });
  }
  function invalidate(message) {
    revision += 1;
    return disconnected(clearConsent() ? message : MESSAGES.consent);
  }

  function run(args, source, timeout, id, isLogin = false) {
    live(id);
    return new Promise((resolve, reject) => {
      let child;
      let timer;
      let killTimer;
      let ended = false;
      let exited = false;
      let bytes = 0;
      let output = '';
      let sentEnter = false;
      const tails = { stdout: '', stderr: '' };
      function stopChild() {
        if (exited || !child) return;
        try { child.kill('SIGTERM'); } catch { /* Already gone. */ }
        if (!exited) {
          killTimer = setTimeout(() => {
            if (!exited) { try { child.kill('SIGKILL'); } catch { /* OS owns final cleanup. */ } }
          }, 250);
          killTimer.unref?.();
        }
      }
      function finish(error, code) {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        processes.delete(control);
        if (loginProcess === control) loginProcess = null;
        if (error) { stopChild(); reject(error); } else resolve({ code, output });
      }
      const control = { stop: (message) => finish(fail(message)) };
      try {
        child = spawnImpl('gh', args, {
          env: { ...cleanEnvironment(source), GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' },
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch { reject(fail(MESSAGES.missing)); return; }
      processes.add(control);
      if (isLogin) loginProcess = control;
      timer = setTimeout(() => finish(fail(MESSAGES.timeout)), timeout);
      child.on('error', (error) => finish(fail(error.code === 'ENOENT' ? MESSAGES.missing : MESSAGES.cli)));
      child.on('close', (code) => { exited = true; clearTimeout(killTimer); finish(null, code); });
      child.stdin?.on('error', () => finish(fail(MESSAGES.cli)));
      function data(chunk, stream) {
        if (ended) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > LIMIT) { finish(fail(MESSAGES.output)); return; }
        if (!isLogin) { if (stream === 'stdout') output += chunk.toString('utf8'); return; }
        if (disposed || revision !== id) return;
        tails[stream] = (tails[stream] + chunk.toString('utf8')).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-2048);
        const text = tails[stream];
        const match = text.match(/\b(?:one[- ]time|device)\s+code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
        if (match && state.code !== match[1]) publish({ code: match[1], message: 'Enter this device code in the GitHub browser window.' });
        if (!ended && revision === id && !sentEnter && (match || /press enter to open/i.test(text))) {
          sentEnter = true;
          try { child.stdin.end('\n'); } catch { finish(fail(MESSAGES.cli)); }
        }
      }
      child.stdout?.on('data', (chunk) => data(chunk, 'stdout'));
      child.stderr?.on('data', (chunk) => data(chunk, 'stderr'));
      if (!isLogin) { try { child.stdin?.end(); } catch { finish(fail(MESSAGES.cli)); } }
    });
  }

  async function inspect(source, id, deadline = Date.now() + 15000) {
    live(id);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw fail(MESSAGES.timeout);
    const result = await run(STATUS_ARGS, source, Math.min(15000, remaining), id);
    live(id);
    if (result.code !== 0) throw fail(MESSAGES.cli);
    let accounts;
    try { accounts = JSON.parse(result.output); } catch { throw fail(MESSAGES.cli); }
    if (!Array.isArray(accounts)) throw fail(MESSAGES.cli);
    const active = accounts.filter((entry) => entry && entry.active === true);
    if (active.length > 1) throw fail(MESSAGES.cli);
    if (!active.length) return null;
    const account = active[0];
    if (account.tokenSource !== 'keyring') throw fail(MESSAGES.unsafe);
    if (typeof account.login !== 'string' || !LOGIN_PATTERN.test(account.login)) throw fail(MESSAGES.cli);
    const scopes = typeof account.scopes === 'string' ? account.scopes.split(/[\s,]+/)
      : Array.isArray(account.scopes) ? account.scopes : [];
    return account.state === 'success' && scopes.includes('repo') ? account.login : null;
  }

  async function verify(source = env) {
    const id = revision;
    const expected = approved;
    try {
      const login = await inspect(source, id);
      live(id);
      if (!login || login !== expected) return invalidate(MESSAGES.changed);
      return publish({ connected: true, connecting: false, login, code: null, error: null, message: 'GitHub connected.' });
    } catch (error) {
      if (id !== revision || disposed) return snapshot();
      return invalidate(safeMessages.has(error.message) ? error.message : MESSAGES.cli);
    }
  }

  async function status() {
    if (disposed || state.connecting || !approved) return snapshot();
    if (!checking) {
      const work = verify();
      checking = work;
      work.finally(() => { if (checking === work) checking = null; });
    }
    return checking;
  }

  async function connect() {
    if (disposed) return snapshot();
    if (connecting) return connecting;
    const id = ++revision;
    const deadline = Date.now() + 5 * 60 * 1000;
    checking = null;
    if (!clearConsent()) return disconnected(MESSAGES.consent);
    // Defer work so reentrant observers see the single in-flight connect promise.
    const work = Promise.resolve().then(async () => {
      try {
        live(id);
        let login = await inspect(env, id, deadline);
        if (!login) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw fail(MESSAGES.timeout);
          const result = await run(LOGIN_ARGS, env, remaining, id, true);
          live(id);
          if (result.code !== 0) throw fail(MESSAGES.cli);
          login = await inspect(env, id, deadline);
          if (!login) throw fail(MESSAGES.scope);
        }
        live(id);
        try { fs.writeFileSync(statePath, JSON.stringify({ login }), { mode: 0o600 }); }
        catch { clearConsent(); throw fail(MESSAGES.consent); }
        approved = login;
        return publish({ connected: true, connecting: false, login, code: null, error: null, message: 'GitHub connected.' });
      } catch (error) {
        if (disposed || id !== revision) return snapshot();
        return disconnected(safeMessages.has(error.message) ? error.message : MESSAGES.cli);
      }
    });
    connecting = work;
    publish({ connected: false, connecting: true, login: null, code: null, error: null, message: 'Connecting to GitHub…' });
    work.finally(() => { if (connecting === work) connecting = null; });
    return work;
  }

  function cancel() {
    if (disposed || !state.connecting) return snapshot();
    revision += 1;
    connecting = null;
    loginProcess?.stop(MESSAGES.cancelled);
    return disconnected(null, MESSAGES.cancelled);
  }

  function disconnect() {
    if (disposed) return snapshot();
    revision += 1;
    connecting = null;
    checking = null;
    loginProcess?.stop(MESSAGES.cancelled);
    return disconnected(clearConsent() ? null : MESSAGES.consent, 'GitHub disconnected from this app.');
  }

  async function credentialEnvironment(baseEnv = env) {
    if (disposed || state.connecting || !approved) throw fail(MESSAGES.required);
    const id = revision;
    const result = await verify(baseEnv);
    if (disposed || id !== revision || !result.connected || !approved) throw fail(MESSAGES.required);
    const resultEnv = cleanEnvironment(baseEnv);
    const countKeys = Object.keys(resultEnv).filter((key) => key.toUpperCase() === 'GIT_CONFIG_COUNT');
    const rawCount = countKeys.length ? String(resultEnv[countKeys[0]]) : '0';
    if (countKeys.length > 1 || !/^(0|[1-9]\d*)$/.test(rawCount) || Number(rawCount) > 1024) {
      throw fail('Invalid per-process Git configuration count.');
    }
    const count = Number(rawCount);
    for (const key of countKeys) delete resultEnv[key];
    for (const key of Object.keys(resultEnv)) {
      if ([`GIT_CONFIG_KEY_${count}`, `GIT_CONFIG_VALUE_${count}`, `GIT_CONFIG_KEY_${count + 1}`, `GIT_CONFIG_VALUE_${count + 1}`].includes(key.toUpperCase())) delete resultEnv[key];
    }
    resultEnv.GIT_CONFIG_COUNT = String(count + 2);
    resultEnv[`GIT_CONFIG_KEY_${count}`] = 'credential.https://github.com.helper';
    resultEnv[`GIT_CONFIG_VALUE_${count}`] = '';
    resultEnv[`GIT_CONFIG_KEY_${count + 1}`] = 'credential.https://github.com.helper';
    resultEnv[`GIT_CONFIG_VALUE_${count + 1}`] = '!gh auth git-credential';
    return resultEnv;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    revision += 1;
    connecting = null;
    checking = null;
    for (const process of processes) process.stop(MESSAGES.disposed);
    state = { connected: false, connecting: false, login: null, code: null, error: null, message: MESSAGES.disposed };
  }

  return { status, connect, cancel, disconnect, credentialEnvironment, dispose };
}

module.exports = { createGitHubConnection };
