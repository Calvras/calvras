'use strict';

// Run with: node scripts/verify-github-connection.cjs. All gh processes are mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createGitHubConnection } = require('../electron/github-connection.cjs');

const SECRET = 'ghp_TEST_SECRET_MUST_NEVER_REACH_RENDERER';
const secure = (login = 'octocat', extra = {}) => ({ active: true, state: 'success', login,
  scopes: 'read:org, repo, gist', tokenSource: 'keyring', ...extra });
const statusPlan = (account = secure()) => ({ type: 'status', stdout: JSON.stringify(account ? [account] : []) });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const keys = ['code', 'connected', 'connecting', 'error', 'login', 'message'];

function fixture(t, plans = [], options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'github-connection-test-'));
  const statePath = path.join(directory, 'consent.json');
  if (options.consent !== undefined) fs.writeFileSync(statePath, options.consent);
  const calls = [];
  const notifications = [];
  const env = options.env || { PATH: 'mock-gh-path', GH_TOKEN: SECRET, GITHUB_TOKEN: SECRET,
    GH_ENTERPRISE_TOKEN: SECRET, GITHUB_ENTERPRISE_TOKEN: SECRET, gh_token: SECRET };
  function spawnImpl(command, args, spawnOptions) {
    const plan = plans.shift();
    const call = { command, args, options: spawnOptions, input: [], kills: [] };
    calls.push(call);
    if (!plan) throw new Error('Unexpected mocked spawn');
    assert.equal(command, 'gh');
    assert.equal(args[1], plan.type || 'status');
    if (plan.throw) throw Object.assign(new Error(SECRET), { code: plan.throw });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (value) => { call.input.push(value); plan.onInput?.(value, child); };
    child.kill = (signal) => {
      call.kills.push(signal);
      if (!plan.ignoreKill) child.emit('close', null);
      return true;
    };
    call.child = child;
    setImmediate(() => {
      if (plan.error) { child.emit('error', Object.assign(new Error(SECRET), { code: plan.error })); return; }
      for (const stream of ['stdout', 'stderr']) {
        const chunks = plan[stream] === undefined ? [] : Array.isArray(plan[stream]) ? plan[stream] : [plan[stream]];
        for (const chunk of chunks) child[stream].emit('data', Buffer.from(chunk));
      }
      if (!plan.hold) child.emit('close', plan.exit === undefined ? 0 : plan.exit);
    });
    return child;
  }
  const connection = createGitHubConnection({ statePath, spawnImpl, env, onStatus: (state) => {
    assert.deepEqual(Object.keys(state).sort(), keys);
    notifications.push(state);
    options.onStatus?.(state, connection);
  } });
  t.after(() => {
    connection.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(plans.length, 0, 'Every planned CLI call must be consumed');
    for (const call of calls) {
      assert.equal(call.options.shell, false);
      assert.equal(call.options.windowsHide, true);
      assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
      assert.ok(!JSON.stringify(call.args).includes(SECRET));
      for (const key of Object.keys(call.options.env)) assert.ok(!/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(key));
      assert.ok(!call.args.some((arg) => ['--insecure-storage', '--show-token', 'setup-git', 'logout', '--global'].includes(arg)));
    }
    assert.ok(!JSON.stringify(notifications).includes(SECRET));
  });
  return { connection, calls, notifications, statePath, directory, env, plans };
}

const consent = (login = 'octocat') => JSON.stringify({ login });

test('signed out: status and credentials never discover/reuse an account without consent', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.connection.status(), { connected: false, connecting: false, login: null, code: null, error: null, message: null });
  await assert.rejects(f.connection.credentialEnvironment(), /Connect and approve/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.statePath), false);
});

test('explicit connect reuses only a secure active repo account and persists only login', async (t) => {
  const f = fixture(t, [statusPlan()]);
  const [first, second] = await Promise.all([f.connection.connect(), f.connection.connect()]);
  assert.equal(first.connected, true);
  assert.equal(second.login, 'octocat');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts',
    '--jq', '.hosts["github.com"] | map({active, state, login, scopes, tokenSource})']);
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), consent());
  assert.equal(f.notifications[0].connecting, true);
});

test('persisted consent is reverified; concurrent status calls share one inspection', async (t) => {
  const f = fixture(t, [statusPlan()], { consent: consent() });
  const states = await Promise.all([f.connection.status(), f.connection.status()]);
  assert.ok(states.every((state) => state.connected));
  assert.equal(f.calls.length, 1);
});

test('device flow exposes only parsed code and lets gh launch browser through stdin', async (t) => {
  const f = fixture(t, [statusPlan(null), { type: 'login', stdout: `${SECRET}\nhttps://untrusted.invalid/${SECRET}\n`,
    stderr: ['! First copy your one-time co', 'de: \u001b[1mABCD-', '1234\u001b[0m\nPress Enter to open https://github.com/login/device in your browser...'],
  }, statusPlan()]);
  assert.equal((await f.connection.connect()).connected, true);
  assert.deepEqual(f.calls[1].args, ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https', '--skip-ssh-key', '--scopes', 'repo']);
  assert.deepEqual(f.calls[1].input, ['\n']);
  assert.deepEqual(f.notifications.filter((state) => state.code).map((state) => state.code), ['ABCD-1234']);
  assert.equal(f.notifications.at(-1).code, null);
  assert.ok(!JSON.stringify(f.notifications).includes('untrusted.invalid'));
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), consent());
});

test('missing repo scope or invalid secure auth requires interactive login', async (t) => {
  for (const extra of [{ scopes: 'read:org' }, { state: 'failed' }]) {
    await t.test(JSON.stringify(extra), async (subtest) => {
      const f = fixture(subtest, [statusPlan(secure('octocat', extra)), { type: 'login' }, statusPlan()]);
      assert.equal((await f.connection.connect()).connected, true);
      assert.equal(f.calls[1].args[1], 'login');
    });
  }
});

test('existing plaintext or environment accounts are refused without modifying gh logins', async (t) => {
  for (const tokenSource of ['oauth_token', 'plaintext', 'GH_TOKEN', 'GITHUB_TOKEN', '', undefined]) {
    await t.test(String(tokenSource), async (subtest) => {
      const f = fixture(subtest, [statusPlan(secure('octocat', { tokenSource }))]);
      const state = await f.connection.connect();
      assert.equal(state.connected, false);
      assert.match(state.error, /Unsafe credential storage/);
      assert.equal(f.calls.length, 1);
      assert.equal(fs.existsSync(f.statePath), false);
    });
  }
});

test('gh plaintext fallback after browser login is refused and is not logged out', async (t) => {
  const f = fixture(t, [statusPlan(null), { type: 'login', stderr: `warning: ${SECRET}` },
    statusPlan(secure('octocat', { tokenSource: 'oauth_token' }))]);
  assert.match((await f.connection.connect()).error, /Unsafe credential storage/);
  assert.equal(fs.existsSync(f.statePath), false);
  await assert.rejects(f.connection.credentialEnvironment(), /Connect and approve/);
  assert.equal(f.calls.length, 3);
});

test('post-login missing repo scope cannot create consent', async (t) => {
  const f = fixture(t, [statusPlan(null), { type: 'login' }, statusPlan(secure('octocat', { scopes: 'gist' }))]);
  assert.match((await f.connection.connect()).error, /repo scope/);
  assert.equal(fs.existsSync(f.statePath), false);
});

test('cancel kills only this login; late success and output cannot reconnect', async (t) => {
  const f = fixture(t, [statusPlan(null), { type: 'login', hold: true, ignoreKill: true }, statusPlan(secure('new-user'))]);
  const pending = f.connection.connect();
  await flush(); await flush();
  const login = f.calls[1];
  assert.ok(login);
  assert.equal(f.connection.cancel().connecting, false);
  assert.deepEqual(login.kills, ['SIGTERM']);
  assert.deepEqual(f.calls[0].kills, []);
  const notificationCount = f.notifications.length;
  login.child.stderr.emit('data', Buffer.from('First copy your one-time code: LATE-CODE'));
  login.child.emit('close', 0);
  assert.equal((await pending).connected, false);
  assert.equal(f.notifications.length, notificationCount);
  assert.equal(fs.existsSync(f.statePath), false);
  assert.equal((await f.connection.connect()).login, 'new-user');
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), consent('new-user'));
});

test('cancel during inspection does not kill the status process or start login', async (t) => {
  const f = fixture(t, [{ ...statusPlan(null), hold: true }, statusPlan(secure('new-user'))]);
  const old = f.connection.connect();
  await flush();
  f.connection.cancel();
  assert.deepEqual(f.calls[0].kills, []);
  const next = f.connection.connect();
  assert.equal((await next).login, 'new-user');
  f.calls[0].child.emit('close', 0);
  await old;
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), consent('new-user'));
});

test('disconnect clears only app consent and status never implicitly reconnects', async (t) => {
  const f = fixture(t, [statusPlan()]);
  await f.connection.connect();
  assert.equal(f.connection.disconnect().connected, false);
  assert.equal(fs.existsSync(f.statePath), false);
  assert.equal((await f.connection.status()).connected, false);
  await assert.rejects(f.connection.credentialEnvironment(), /Connect and approve/);
  assert.equal(f.calls.length, 1);
});

test('disconnect during login prevents late approval', async (t) => {
  const f = fixture(t, [statusPlan(null), { type: 'login', hold: true }]);
  const pending = f.connection.connect();
  await flush(); await flush();
  f.connection.disconnect();
  f.calls[1].child.emit('close', 0);
  assert.equal((await pending).connected, false);
  assert.equal(fs.existsSync(f.statePath), false);
});

test('credential environment appends scoped helpers, preserves indices, and never changes global git config', async (t) => {
  const f = fixture(t, [statusPlan(), statusPlan(), statusPlan()]);
  await f.connection.connect();
  const base = { ...f.env, GH_CONFIG_DIR: 'mock-context-only', GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: 'old-helper' };
  const copy = { ...base };
  const result = await f.connection.credentialEnvironment(base);
  assert.deepEqual(base, copy);
  assert.equal(result.GIT_CONFIG_COUNT, '4');
  for (let i = 0; i < 2; i += 1) {
    assert.equal(result[`GIT_CONFIG_KEY_${i}`], base[`GIT_CONFIG_KEY_${i}`]);
    assert.equal(result[`GIT_CONFIG_VALUE_${i}`], base[`GIT_CONFIG_VALUE_${i}`]);
  }
  assert.equal(result.GIT_CONFIG_KEY_2, 'credential.https://github.com.helper');
  assert.equal(result.GIT_CONFIG_VALUE_2, '');
  assert.equal(result.GIT_CONFIG_KEY_3, 'credential.https://github.com.helper');
  assert.equal(result.GIT_CONFIG_VALUE_3, '!gh auth git-credential');
  assert.equal(result.env, undefined, 'API returns the environment directly');
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.equal(f.calls[1].options.env.GH_CONFIG_DIR, base.GH_CONFIG_DIR, 'Verify the same CLI context used by the helper');
  const defaultEnv = await f.connection.credentialEnvironment();
  assert.equal(defaultEnv.GIT_CONFIG_COUNT, '2');
  assert.ok(f.calls.every((call) => call.command === 'gh' && call.args[1] === 'status'));
});

test('invalid per-process Git counts are rejected rather than clobbering config', async (t) => {
  for (const count of ['-1', '1x', '01', '1025']) {
    await t.test(count, async (subtest) => {
      const f = fixture(subtest, [statusPlan(), statusPlan()]);
      await f.connection.connect();
      await assert.rejects(f.connection.credentialEnvironment({ GIT_CONFIG_COUNT: count }), /Invalid per-process/);
    });
  }
});

test('active account switch invalidates consent until another explicit connect', async (t) => {
  const f = fixture(t, [statusPlan(), statusPlan(secure('different-user')), statusPlan(secure('different-user'))]);
  await f.connection.connect();
  const state = await f.connection.status();
  assert.equal(state.connected, false);
  assert.equal(state.login, null);
  assert.match(state.error, /active GitHub account changed/);
  assert.equal(fs.existsSync(f.statePath), false);
  assert.equal((await f.connection.status()).connected, false);
  assert.equal(f.calls.length, 2);
  assert.equal((await f.connection.connect()).login, 'different-user');
});

test('credential request independently revalidates approved account and secure storage', async (t) => {
  for (const account of [secure('other-user'), secure('octocat', { tokenSource: 'oauth_token' }), null]) {
    await t.test(account ? `${account.login}/${account.tokenSource}` : 'signed-out', async (subtest) => {
      const f = fixture(subtest, [statusPlan(), statusPlan(account)]);
      await f.connection.connect();
      await assert.rejects(f.connection.credentialEnvironment(), /Connect and approve/);
      assert.equal(fs.existsSync(f.statePath), false);
      assert.equal((await f.connection.status()).connected, false);
    });
  }
});

test('stale persisted consent is cleared without starting a login flow', async (t) => {
  const f = fixture(t, [statusPlan(null)], { consent: consent() });
  assert.equal((await f.connection.status()).connected, false);
  assert.equal(fs.existsSync(f.statePath), false);
  assert.equal(f.calls.length, 1);
});

test('invalid or oversized consent never grants access', async (t) => {
  for (const value of ['not json', JSON.stringify({ login: 'octocat', token: SECRET }), JSON.stringify({ login: SECRET.repeat(100) })]) {
    await t.test(`input length ${value.length}`, async (subtest) => {
      const f = fixture(subtest, [], { consent: value });
      assert.equal((await f.connection.status()).connected, false);
      await assert.rejects(f.connection.credentialEnvironment(), /Connect and approve/);
    });
  }
});

test('absent gh, invalid JSON, failed processes and arbitrary output yield only generic errors', async (t) => {
  for (const plan of [{ throw: 'ENOENT' }, { error: 'ENOENT' }, { error: 'EACCES' },
    { stdout: SECRET }, { stdout: SECRET, stderr: SECRET, exit: 1 }, { stdout: '{}' },
    { stdout: JSON.stringify([secure(), secure('other')]) }, { stdout: JSON.stringify([secure(SECRET)]) }]) {
    await t.test(JSON.stringify(plan), async (subtest) => {
      const f = fixture(subtest, [plan]);
      const state = await f.connection.connect();
      assert.equal(state.connected, false);
      assert.ok(state.error);
      assert.ok(!state.error.includes(SECRET));
      assert.equal(fs.existsSync(f.statePath), false);
    });
  }
  await t.test('login failure', async (subtest) => {
    const f = fixture(subtest, [statusPlan(null), { type: 'login', stderr: SECRET, exit: 1 }]);
    assert.match((await f.connection.connect()).error, /could not complete/);
    assert.equal(fs.existsSync(f.statePath), false);
  });
});

test('CLI output is bounded on either stream, including login output', async (t) => {
  for (const isLogin of [false, true]) {
    await t.test(isLogin ? 'login' : 'status', async (subtest) => {
      const overflow = { type: isLogin ? 'login' : 'status', stderr: 'x'.repeat(65537), hold: true };
      const f = fixture(subtest, isLogin ? [statusPlan(null), overflow] : [overflow]);
      assert.match((await f.connection.connect()).error, /output limit/);
      assert.deepEqual(f.calls.at(-1).kills, ['SIGTERM']);
    });
  }
});

test('status CLI has a finite timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(t, [{ hold: true }]);
  const pending = f.connection.connect();
  await flush();
  t.mock.timers.tick(15000);
  assert.match((await pending).error, /timed out/);
  assert.deepEqual(f.calls[0].kills, ['SIGTERM']);
});

test('browser flow is bounded to five minutes and escalates only its own stuck process', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(t, [statusPlan(null), { type: 'login', hold: true, ignoreKill: true }]);
  const pending = f.connection.connect();
  await flush(); await flush();
  t.mock.timers.tick(5 * 60 * 1000);
  assert.match((await pending).error, /timed out/);
  assert.deepEqual(f.calls[1].kills, ['SIGTERM']);
  t.mock.timers.tick(250);
  assert.deepEqual(f.calls[1].kills, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(f.calls[0].kills, []);
  f.calls[1].child.emit('close', 0);
  assert.equal(fs.existsSync(f.statePath), false);
});

test('dispose terminates owned work without revoking previously persisted gh consent', async (t) => {
  const f = fixture(t, [{ ...statusPlan(), hold: true }], { consent: consent() });
  const pending = f.connection.status();
  await flush();
  f.connection.dispose();
  assert.deepEqual(f.calls[0].kills, ['SIGTERM']);
  assert.equal((await pending).connected, false);
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), consent());
  assert.equal((await f.connection.connect()).connected, false);
  await assert.rejects(f.connection.credentialEnvironment(), /Connect and approve/);
});

test('observer exceptions cannot leak CLI data or break connection', async (t) => {
  const f = fixture(t, [statusPlan()], { onStatus: () => { throw new Error(SECRET); } });
  assert.equal((await f.connection.connect()).connected, true);
});

test('observer cancellation during device code prevents stdin browser trigger and consent', async (t) => {
  const f = fixture(t, [statusPlan(null), { type: 'login', stderr: 'First copy your one-time code: ABCD-1234', hold: true }],
    { onStatus: (state, connection) => { if (state.code) connection.cancel(); } });
  assert.equal((await f.connection.connect()).connected, false);
  assert.deepEqual(f.calls[1].input, []);
  assert.equal(fs.existsSync(f.statePath), false);
});

test('unwritable consent fails closed with a generic error', async (t) => {
  const f = fixture(t, [statusPlan()]);
  // Create a directory only after inspection starts, so consent saving fails.
  const pending = f.connection.connect();
  await Promise.resolve();
  fs.mkdirSync(f.statePath);
  const state = await pending;
  assert.equal(state.connected, false);
  assert.match(state.error, /consent/);
});
