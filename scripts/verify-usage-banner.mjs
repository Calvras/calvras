import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-usage-'));
const out = path.resolve('.agents/artifacts/usage-banner');
await fs.mkdir(out, { recursive: true });
const checks = [];
function check(name, ok) { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.env.CALVRAS_VERIFY_EXE;
const app = await electron.launch({ executablePath: packaged || path.resolve('node_modules/electron/dist/electron.exe'), args: [...(packaged ? [] : ['main.cjs']), '--user-data-dir=' + profile], env, timeout: 60000 });

try {
  await app.evaluate(({ ipcMain }) => {
    global.__quotaFixture = { ok: true, signedIn: true, used: 12345, limit: 200000, percent: 6, exhausted: false, resetAt: 0, lockDays: 0 };
    ipcMain.removeHandler('quota:status');
    ipcMain.handle('quota:status', () => global.__quotaFixture);
    ipcMain.removeHandler('browser:open-external');
    ipcMain.handle('browser:open-external', (_event, url) => { global.__openedPricing = url; return { ok: true }; });
  });
  const page = await app.firstWindow();
  await page.waitForURL('**/signin.html');
  await page.waitForLoadState('domcontentloaded');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (packaged) await app.evaluate(({ app, BrowserWindow }) => BrowserWindow.getAllWindows()[0].loadFile(app.getAppPath() + '/app.html'));
  else await page.goto(pathToFileURL(path.resolve('app.html')).href);
  await page.waitForSelector('#prompt-input');
  await page.waitForSelector('#app-splash', { state: 'detached', timeout: 6000 });
  const version = packaged ? await app.evaluate(({ app }) => app.getVersion()) : JSON.parse(await fs.readFile(path.resolve('electron-builder.kraken.json'), 'utf8')).extraMetadata.version;
  check('renderer reports the actual build version', await page.evaluate(() => getElectronIpc().invoke('app:get-version')) === version);
  await page.evaluate(() => refreshQuota());
  check('Free meter displays spent tokens, not chat count', await page.locator('#quota-usage-label').textContent() === '12.3k / 200k tokens used today');
  check('meter percentage reflects 6% token usage', await page.evaluate(() => document.getElementById('quota-usage-bar').style.width === '6%'));
  check('token formatting preserves 10k, 100k, and sub-1k values', await page.evaluate(() => formatTokens(10000) === '10k' && formatTokens(100000) === '100k' && formatTokens(999) === '999'));
  check('unlocked composer is visible', await page.locator('#prompt-input').isVisible());

  await app.evaluate(() => { global.__quotaFixture = { ok: true, signedIn: true, used: 200000, limit: 200000, percent: 100, exhausted: true, resetAt: Date.now() + 5 * 86400000, lockDays: 5 }; });
  await page.evaluate(() => refreshQuota());
  check('token exhaustion locks both composer layouts', await page.evaluate(() => document.body.classList.contains('usage-locked') && [...document.querySelectorAll('.usage-limit-banner')].every(el => !el.hidden)));
  check('composer is hidden while locked', !await page.locator('#prompt-input').isVisible());
  check('meter reports token lock', (await page.locator('#quota-usage-label').textContent()).startsWith('Token limit reached — unlocks'));
  check('banner shows the five-day countdown', (await page.locator('.codex-home-composer .usage-limit-days').textContent()).includes('5 days'));
  if (await page.locator('#upgrade-modal').isVisible()) await page.locator('#upgrade-close-btn').click();
  await page.screenshot({ path: path.join(out, 'locked-home.png') });
  await page.locator('.codex-home-composer .usage-limit-upgrade').click();
  check('real Upgrade click opens exact website pricing URL', await app.evaluate(() => global.__openedPricing === 'https://calvras.com/pricing'));

  await page.evaluate(() => { welcomeContainer.style.display = 'none'; conversationThread.style.display = 'flex'; refreshUsageLock(); });
  const activeUpgrade = page.locator('.capsule-input-container .usage-limit-upgrade');
  check('active-chat Upgrade is visible', await activeUpgrade.isVisible());
  await app.evaluate(() => { global.__openedPricing = ''; });
  await activeUpgrade.click();
  check('active-chat Upgrade receives the click', await app.evaluate(() => global.__openedPricing === 'https://calvras.com/pricing'));

  await app.evaluate(() => { global.__quotaFixture = { ok: true, signedIn: true, used: 100000, limit: 500000, percent: 20, exhausted: false, resetAt: 0, lockDays: 0 }; });
  await page.evaluate(() => refreshQuota());
  check('Lite refresh clears the old lock and preserves spent tokens', await page.evaluate(() => !document.body.classList.contains('usage-locked') && quotaLockedUntil === 0 && document.getElementById('quota-usage-label').textContent === '100k / 500k tokens used today'));
  check('active composer returns after upgrade', await page.locator('#capsule-prompt-input').isVisible());
  await page.screenshot({ path: path.join(out, 'upgraded-active.png') });

  await app.evaluate(() => { global.__quotaFixture = { ok: true, signedIn: true, used: 100000, limit: 800000, percent: 13, exhausted: false, resetAt: 0, lockDays: 0 }; });
  await page.evaluate(() => refreshQuota());
  check('Pro displays the 800k allowance', await page.locator('#quota-usage-label').textContent() === '100k / 800k tokens used today');
  const planCopy = await page.locator('#account-plan-name').locator('..').textContent();
  check('settings explains 200k, $12 Lite 500k, and $30 Pro 800k', /200k tokens/.test(planCopy) && /500k/.test(planCopy) && /800k/.test(planCopy) && /\$12\/month/.test(planCopy) && /\$30\/month/.test(planCopy) && !/Starter|Ultra|unlimited/i.test(planCopy));

  await page.locator('#capsule-chat-mode-btn').click();
  check('mode menu beside the mic lists Build and Chat with a blue Free pill', await page.evaluate(() => {
    const menu = document.getElementById('capsule-chat-mode-menu');
    const rows = [...menu.querySelectorAll('.mode-option')].map(o => o.getAttribute('data-chat-mode'));
    const pill = menu.querySelector('[data-chat-mode="chat"] .chat-free-pill');
    return menu.classList.contains('show') && rows.join(',') === 'build,chat' && Boolean(pill) && pill.textContent.trim() === 'Free' && getComputedStyle(pill).backgroundColor === 'rgb(37, 99, 235)';
  }));
  await page.screenshot({ path: path.join(out, 'chat-mode-menu.png') });
  await page.locator('#capsule-chat-mode-menu [data-chat-mode="chat"]').click();
  check('selecting Chat labels both composers and shows the Free pill', await page.evaluate(() => document.getElementById('chat-mode-label').textContent === 'Chat' && document.getElementById('capsule-chat-mode-label').textContent === 'Chat' && !document.querySelector('#capsule-chat-mode-btn .chat-free-pill').hidden));
  check('chat mode refuses edits, commands, git and documents', await page.evaluate(async () => {
    for (const kind of ['write', 'edit', 'replace', 'run', 'git', 'document', 'image', 'video']) {
      try { await executeAgentBlock({ kind, arg: 'x.txt', body: '{}' }, {}, null); return false; }
      catch (error) { if (!/read-only/.test(error.message)) return false; }
    }
    return true;
  }));
  check('chat mode can search the web and fetch pages to confirm', await page.evaluate(async () => {
    const os = window.performWebSearch; const of = window.performPageFetch;
    window.performWebSearch = async () => 'fixture results';
    window.performPageFetch = async (url) => ({ url, text: 'fixture page' });
    try {
      const a = await executeAgentBlock({ kind: 'web', arg: 'calvras' }, {}, null);
      const b = await executeAgentBlock({ kind: 'fetch', arg: 'https://example.com' }, {}, null);
      return !a.failed && !b.failed && /fixture results/.test(a.resultText) && /fixture page/.test(b.resultText);
    } finally { window.performWebSearch = os; window.performPageFetch = of; }
  }));
  check('chat mode browses read-only but refuses clicks and logins', await page.evaluate(async () => {
    const original = window.performBrowserAction;
    window.performBrowserAction = async () => ({ ok: true });
    try {
      const ok = await executeAgentBlock({ kind: 'browser', arg: 'open https://example.com' }, {}, null);
      let refused = false; let loginRefused = false;
      try { await executeAgentBlock({ kind: 'browser', arg: 'click #buy' }, {}, null); } catch (e) { refused = /look at pages/.test(e.message); }
      try { await executeAgentBlock({ kind: 'browser', arg: 'login' }, {}, null); } catch (e) { loginRefused = /look at pages/.test(e.message); }
      return !ok.failed && refused && loginRefused;
    } finally { window.performBrowserAction = original; }
  }));
  await app.evaluate(() => { global.__quotaFixture = { ok: true, signedIn: true, used: 200000, limit: 200000, percent: 100, exhausted: true, resetAt: Date.now() + 5 * 86400000, lockDays: 5 }; });
  await page.evaluate(() => refreshQuota());
  if (await page.locator('#upgrade-modal').isVisible()) await page.locator('#upgrade-close-btn').click();
  check('a locked account keeps chatting in free Chat mode', await page.locator('#capsule-prompt-input').isVisible() && await page.evaluate(() => !document.body.classList.contains('usage-locked')));
  check('lock banner still explains the build lock during free chat', await page.evaluate(() => [...document.querySelectorAll('.usage-limit-banner')].some(b => !b.hidden)));
  await page.screenshot({ path: path.join(out, 'locked-chat.png') });
  await page.locator('#capsule-chat-mode-btn').click();
  await page.locator('#capsule-chat-mode-menu [data-chat-mode="build"]').click();
  check('switching back to Build restores the lock screen', await page.evaluate(() => document.body.classList.contains('usage-locked')) && !await page.locator('#capsule-prompt-input').isVisible());
  await page.locator('.capsule-input-container .usage-limit-chat').click();
  check('the lock banner offers a way into free Chat', await page.locator('#capsule-prompt-input').isVisible() && await page.evaluate(() => composerMode === 'chat'));

  const chatSys = await page.evaluate(async () => {
    const msgs = await buildApiMessagesWithCompression({ messages: [{ role: 'user', content: 'hi' }] }, [], null);
    return { role: msgs[0].role, isChat: msgs[0].content === CHAT_SYSTEM_PROMPT, head: msgs[0].content.slice(0, 40) };
  });
  check('chat requests carry the strict Calvras chat system prompt', chatSys.role === 'system' && chatSys.isChat && chatSys.head.startsWith('You are Calvras'));
  await page.evaluate(() => window.setComposerMode('build'));
  const buildSys = await page.evaluate(async () => {
    const msgs = await buildApiMessagesWithCompression({ messages: [{ role: 'user', content: 'hi' }] }, [], null);
    return { differs: msgs[0].content !== CHAT_SYSTEM_PROMPT, len: msgs[0].content.length };
  });
  check('build mode keeps the agent system prompt', buildSys.differs && buildSys.len > 200);
  await page.evaluate(() => window.setComposerMode('chat'));
  const smallTalk = await page.evaluate(async () => {
    const original = window.streamCompletion;
    let captured = null;
    window.streamCompletion = async (msgs) => { captured = msgs; return { content: 'Hey.' }; };
    try {
      currentChat = { id: 'prompt-fixture', messages: [] };
      await handleSend('hey');
    } finally { window.streamCompletion = original; }
    return Boolean(captured) && captured[0].content === CHAT_SYSTEM_PROMPT;
  });
  check('chat small-talk also uses the strict prompt', smallTalk === true);

  await page.route('https://calvras.com/api/site/chat', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"fixture unavailable"}' }));
  let fallback = false;
  await page.route('https://api.together.xyz/**', route => { fallback = true; return route.abort(); });
  const refused = await page.evaluate(async () => {
    localStorage.setItem('calvras_user', JSON.stringify({ session: 'fixture-session' }));
    try { await streamCompletion([{ role: 'user', content: 'fixture' }]); return false; }
    catch (error) { return error.message.includes('503'); }
    finally { localStorage.removeItem('calvras_user'); }
  });
  check('signed-in provider failure cannot bypass token accounting', refused && !fallback);
  check('no renderer errors', errors.length === 0);
  if (errors.length) console.log('ERRORS', errors);
} finally {
  await app.close();
}
const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
