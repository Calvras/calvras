import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const root = process.cwd();
const out = path.join(root, '.agents/artifacts/calvras-migration');
fs.mkdirSync(out, { recursive: true });
const checks = [];
const check = (label, ok) => {
  checks.push([label, Boolean(ok)]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
};
const mainSource = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
const unitSource = mainSource.slice(0, mainSource.indexOf('// ── IPC'));
const futureToken = 'fixture.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.fixture';
function contextFor(profile, fetchImpl = async () => { throw new Error('No live requests in migration fixtures'); }) {
  const app = {
    getPath: name => name === 'userData' ? profile : path.dirname(profile),
    setName: () => {},
    setPath: () => {},
    commandLine: { hasSwitch: () => true },
  };
  const sandbox = vm.createContext({
    require: name => name === 'electron' ? { app } : name === './oauth.config.json' ? { clientSecret: '' } : require(name),
    process: { env: {}, platform: 'win32' }, Buffer, URLSearchParams, AbortSignal,
    console: { log() {}, warn() {}, error() {} }, fetch: fetchImpl,
    setTimeout: callback => { callback(); return 0; },
  });
  vm.runInContext(unitSource, sandbox, { timeout: 1000 });
  return sandbox;
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'calvras-store-fixture-'));
const legacy = { name: 'Migration fixture', marker: 'retain-this-value' };
fs.writeFileSync(path.join(profile, 'kraken-auth.json'), JSON.stringify(legacy));
const first = contextFor(profile);
check('legacy sign-in file migrates without changing data', JSON.stringify(vm.runInContext('Store.get()', first)) === JSON.stringify(legacy));
check('legacy file removed only after replacement exists', fs.existsSync(path.join(profile, 'calvras-auth.json')) && !fs.existsSync(path.join(profile, 'kraken-auth.json')));
fs.writeFileSync(path.join(profile, 'kraken-auth.json'), JSON.stringify({ marker: 'older' }));
check('existing Calvras sign-in wins over legacy data', vm.runInContext('Store.get().marker', contextFor(profile)) === 'retain-this-value');
vm.runInContext('Store.clear()', first);
check('sign-out clears both names so migration cannot restore it', !fs.existsSync(path.join(profile, 'calvras-auth.json')) && !fs.existsSync(path.join(profile, 'kraken-auth.json')));
fs.writeFileSync(path.join(profile, 'kraken-auth.json'), '{incomplete');
contextFor(profile);
check('unreadable legacy sign-in stays intact', fs.readFileSync(path.join(profile, 'kraken-auth.json'), 'utf8') === '{incomplete' && !fs.existsSync(path.join(profile, 'calvras-auth.json')));

const syncProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'calvras-sync-fixture-'));
const requests = [];
let refreshes = 0;
const sync = contextFor(syncProfile, async () => {
  refreshes += 1;
  return { ok: true, json: async () => ({ access_token: 'refreshed-fixture-access', id_token: futureToken }) };
});
sync.postSession = async payload => {
  requests.push(JSON.parse(payload));
  if (requests.length === 1) throw new Error('401 expired token');
  return { ok: true, session: 'fixture-session', plan: 'free' };
};
sync.fixture = { email: 'fixture@example.test', accessToken: 'old-fixture-access', refreshToken: 'fixture-refresh', idToken: futureToken };
await vm.runInContext('syncAccountWithCalvras(fixture)', sync);
check('401 retry rebuilds request with refreshed credentials', requests.length === 2 && refreshes === 1 && requests[0].accessToken === 'old-fixture-access' && requests[1].accessToken === 'refreshed-fixture-access');
check('sync reports current desktop version and saves returned session', requests[1].version === '9.4.0' && vm.runInContext('Store.get().session', sync) === 'fixture-session');
check('sync never claims identity from renderer email', !Object.hasOwn(requests[1], 'email'));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'calvras-ui-migration-'));
  const packagedExe = process.env.CALVRAS_TEST_EXE;
  app = await electron.launch({
    executablePath: packagedExe ? path.resolve(packagedExe) : path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: [...(packagedExe ? [] : ['main.cjs']), '--user-data-dir=' + fresh], env, timeout: 60000,
  });
  const appRoot = await app.evaluate(({ app }) => app.getAppPath());
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  check('fresh profile opens Calvras sign-in', (await page.title()) === 'Calvras — Sign in' && await page.locator('#google-btn').isVisible());
  await page.screenshot({ path: path.join(out, '01-fresh-signin.png') });
  await page.goto(pathToFileURL(path.join(appRoot, 'app.html')).href);
  await page.waitForSelector('#prompt-input');
  check('fresh profile has no hardcoded recent projects', await page.evaluate(() => getRecentProjects().length === 0));
  await page.evaluate(() => {
    localStorage.setItem('kraken_chats_history', '[{"id":"saved-fixture","title":"Saved conversation","messages":[]}]');
    localStorage.setItem('kraken_recent_projects', '["Saved project"]');
    localStorage.setItem('kraken_preview_share_v2', '0.4');
    localStorage.setItem('calvras_preview_share_v2', '0.65');
    localStorage.setItem('unrelated-setting', 'keep');
  });
  await page.reload();
  await page.waitForSelector('#prompt-input');
  const migrated = await page.evaluate(() => ({
    history: JSON.parse(localStorage.getItem('calvras_chats_history')),
    projects: getRecentProjects(), share: localStorage.getItem('calvras_preview_share_v2'),
    old: Object.keys(localStorage).filter(key => key.startsWith('kraken_')),
    other: localStorage.getItem('unrelated-setting'), version: getElectronIpc().invoke('app:get-version'),
  }));
  check('saved conversation survives renderer key migration', migrated.history[0]?.id === 'saved-fixture');
  check('recent projects survive migration', migrated.projects[0] === 'Saved project');
  check('modern preference wins and unrelated settings survive', migrated.share === '0.65' && migrated.other === 'keep');
  check('renderer migration removes legacy keys', migrated.old.length === 0);
  check('desktop reports 9.4.0 rather than TanStack package version', await page.evaluate(() => getElectronIpc().invoke('app:get-version')) === '9.4.0');
  await page.screenshot({ path: path.join(out, '02-migrated-chat.png') });
  const migrationSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8').split('function getRecentProjects')[0];
  const storage = { kraken_chats_history: 'saved', getItem(key) { return this[key] ?? null; }, setItem() { throw new Error('quota'); }, removeItem(key) { delete this[key]; } };
  vm.runInNewContext(migrationSource, { localStorage: storage, console: { warn() {} } }, { timeout: 1000 });
  check('storage failure does not delete legacy conversations', storage.kraken_chats_history === 'saved');
  check('all chat modes explicitly override retired identity in history', await page.evaluate(() => {
    const previous = activeWorkspaceDir;
    try {
      activeWorkspaceDir = '';
      const general = buildAgentSystemPrompt([]);
      activeWorkspaceDir = 'C:/identity-fixture';
      return [general, buildAgentSystemPrompt([]), buildSmallTalkPrompt()].every(prompt =>
        prompt.includes(ASSISTANT_IDENTITY) && prompt.includes('Calvras, made by Kracton') && prompt.includes('earlier messages or conversation summaries'));
    } finally {
      activeWorkspaceDir = previous;
    }
  }));
  if (process.env.CALVRAS_LIVE_IDENTITY === '1') {
    async function sendIdentity(question) {
      const before = await page.evaluate(() => chats.find(chat => chat.id === activeChatId)?.messages.length || 0);
      const home = await page.locator('#prompt-input').isVisible();
      await page.fill(home ? '#prompt-input' : '#capsule-prompt-input', question);
      await page.click(home ? '#send-btn' : '#capsule-send-btn');
      await page.waitForFunction(({ before, question }) => {
        const messages = chats.find(chat => chat.id === activeChatId)?.messages || [];
        return !isGenerating && messages.length === before + 2 && messages[before]?.content === question && messages.at(-1)?.role === 'assistant';
      }, { before, question }, { timeout: 120000 });
      const answer = await page.evaluate(() => chats.find(chat => chat.id === activeChatId).messages.at(-1).content);
      console.log(JSON.stringify({ question, answer }));
      return answer;
    }
    const identifiesAsCalvras = answer => /\bCalvras\b/.test(answer) && !/^(?:I(?:'m| am)\s+)?Kraken\b/i.test(answer);
    check('real model identifies as Calvras in a fresh chat', identifiesAsCalvras(await sendIdentity('What is your name?')));
    await page.evaluate(() => {
      const chat = chats.find(chat => chat.id === activeChatId);
      chat.messages = [
        { role: 'user', content: 'whats ur name' },
        { role: 'assistant', content: 'Kraken — your coding and offensive security agent.' },
        { role: 'user', content: 'whats youe name' },
        { role: 'assistant', content: 'Kraken.' },
      ];
      saveChatsToStorage();
      loadChatById(chat.id);
    });
    check('real model uses Calvras despite old Kraken answers', identifiesAsCalvras(await sendIdentity('What is your name?')));
    check('identity correction preserves historical answers', await page.evaluate(() => chats.find(chat => chat.id === activeChatId).messages[3].content === 'Kraken.'));
    const identityWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'calvras-identity-workspace-'));
    await page.evaluate(async dir => {
      await getElectronIpc().invoke('workspace:set-folder', dir);
      await refreshWorkspaceInfo();
      const chat = chats.find(chat => chat.id === activeChatId);
      chat.messages = chat.messages.slice(0, 4);
      saveChatsToStorage();
      loadChatById(chat.id);
    }, identityWorkspace);
    check('real workspace model uses Calvras despite old identity', identifiesAsCalvras(await sendIdentity('What is your name?')));
    check('real model names Kracton as its company', /\bKracton\b/.test(await sendIdentity('Which company makes you?')));
    await page.screenshot({ path: path.join(out, '05-identity-regression.png') });
  }
  check('migration and identity UI have no renderer errors', errors.length === 0);
} finally {
  if (app) await app.close();
  fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2));
}
assert.ok(checks.every(([, ok]) => ok), 'Migration verification failed');
console.log(`${checks.length}/${checks.length} passed; network sync above uses explicit local fixtures, not a live Google sign-in.`);
