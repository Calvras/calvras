import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const out = '.agents/artifacts/web-chat';
await fs.mkdir(out, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-web-chat-'));
const checks = [];
const check = (label, ok) => { checks.push([label, Boolean(ok)]); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: path.resolve('node_modules/electron/dist/electron.exe'),
  args: ['main.cjs', '--user-data-dir=' + profile], env, timeout: 60000,
});
let page;
try {
  page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve('app.html')).href);
  await page.waitForSelector('#prompt-input');
  const setup = await page.evaluate(() => ({
    noFolder: !activeWorkspaceDir && selectedPromptTool === null,
    tools: /```web:/.test(buildAgentSystemPrompt([])) && /```fetch:/.test(buildAgentSystemPrompt([])),
    fetchParsed: parseAgentBlocks('```fetch:https://calvras.com```')[0]?.kind === 'fetch',
    hidden: stripToolBlocks('```fetch:https://calvras.com```') === '',
    dsml: dsmlToBlock({ name: 'search_web', params: { query: 'Electron' } })?.kind === 'web',
  }));
  check('general mode exposes web and fetch', setup.noFolder && setup.tools);
  check('fetch block parsed and hidden from prose', setup.fetchParsed && setup.hidden);
  check('native search_web maps to web, not file search', setup.dsml);

  async function send(selector, button, prompt) {
    await page.fill(selector, prompt);
    const start = Date.now();
    await page.click(button);
    await page.waitForFunction(() => !isGenerating && chats[0]?.messages.at(-1)?.role === 'assistant', null, { timeout: 180000 });
    const result = await page.evaluate(() => {
      const message = chats[0].messages.at(-1);
      return { content: message.content, trace: message.trace, text: messagesContainer.innerText };
    });
    console.log(JSON.stringify({ prompt, ms: Date.now() - start, ...result }, null, 2));
    return result;
  }

  const browse = await send('#prompt-input', '#send-btn', 'browse for calvras.com');
  const browseNodes = (browse.trace || []).flatMap(p => p.tools || []);
  check('real model uses a live tool for the exact browse request', browseNodes.some(n => ['fetch', 'search', 'web'].includes(n.kind) && n.output && !n.failed));
  check('real model does not deny web capability', Boolean(browse.content) && !/don.t have.*(?:brows|internet|search)|cannot (?:browse|search)|no (?:web|internet) access/i.test(browse.content));
  check('no waiting-for-answer note', !browse.text.includes('Waiting for your answer before continuing'));
  await page.screenshot({ path: path.join(out, '01-browse-result.png'), animations: 'disabled' });

  const search = await send('#capsule-prompt-input', '#capsule-send-btn', 'Search the web for the official Electron desktop framework documentation and give me its official link.');
  const searchNodes = (search.trace || []).flatMap(p => p.tools || []);
  check('real model web search returns real result URLs', searchNodes.some(n => ['search', 'web'].includes(n.kind) && /https?:\/\//.test(n.output || '') && !/returned no results/.test(n.output || '')));
  check('answer cites an Electron source', /electronjs\.org/.test(search.content));
  check('sources shown as clickable links without a selected tool', await page.evaluate(() => selectedPromptTool === null && [...document.querySelectorAll('.message-row.assistant:last-child .reply-sources a')].some(a => a.href.includes('electronjs.org'))));
  const savedSources = await page.evaluate(() => {
    const count = chats[0].messages.at(-1).sources.length;
    loadChatById(activeChatId);
    return { count, restored: document.querySelectorAll('.message-row.assistant:last-child .reply-sources a').length, env: envSources.length };
  });
  check('sources survive chat reload and repopulate Environment', savedSources.count > 0 && savedSources.restored === savedSources.count && savedSources.env > 0);
  await page.evaluate(() => {
    const row = document.querySelector('.message-row.assistant:last-child');
    const item = [...row.querySelectorAll('.agent-tool-item')].find(e => e.querySelector('.agent-web-output'));
    // Completed work is folded into a "Worked for…" disclosure; open it the way a user would.
    const disclosure = item?.closest('details.agent-work-summary');
    if (disclosure) disclosure.open = true;
    item?.closest('.agent-thinking-state')?.classList.remove('collapsed');
    item?.querySelector('.agent-tool-chip')?.click();
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  });
  await page.locator('.message-row.assistant:last-child .agent-web-output').first().waitFor({ state: 'visible' });
  check('expanded web drawer contains actual output', await page.evaluate(() => [...document.querySelectorAll('.agent-web-output')].some(el => el.textContent.includes('https://'))));
  check('web drawer uses a dark scrollbar', await page.locator('.agent-web-output').first().evaluate(el => getComputedStyle(el).scrollbarColor === 'rgb(58, 58, 58) rgba(0, 0, 0, 0)'));
  await page.screenshot({ path: path.join(out, '02-web-search.png'), animations: 'disabled' });

  const boundary = await page.evaluate(async () => {
    const invalid = await executeAgentBlock({ kind: 'fetch', arg: 'file:///C:/Windows/win.ini', body: '' });
    const empty = await executeAgentBlock({ kind: 'fetch', arg: '', body: '' });
    const host = document.createElement('div');
    renderArchivedPhase(host, { message: 'What next?', awaiting: true });
    return { invalid: invalid.failed, empty: empty.failed, noNote: !host.querySelector('.agent-awaiting') };
  });
  check('fetch rejects non-HTTPS and missing URLs honestly', boundary.invalid && boundary.empty);
  check('old archived awaiting flags no longer render notes', boundary.noNote);

  const ownership = await page.evaluate(async () => {
    const originalFetch = searchFetch;
    const originalSources = envSources.slice();
    const controller = new AbortController();
    const context = { sources: [], chatId: activeChatId, signal: controller.signal };
    const next = { sources: [], chatId: activeChatId, signal: new AbortController().signal };
    let resolveFetch;
    try {
      searchFetch = () => new Promise(resolve => { resolveFetch = resolve; });
      const pending = performPageFetch('https://example.test/stopped', context);
      controller.abort();
      addSource('https://example.test/current', 'Current reply', next);
      resolveFetch({ ok: true, text: async () => '<title>Stopped fetch</title><p>Old reply</p>' });
      await pending;
      const cancelled = context.sources.length === 0 && next.sources.length === 1 && !envSources.some(s => s.url.includes('/stopped'));
      renderAssistantMessageFromHistory({ content: 'Archived reply', sources: [{ url: 'https://example.test/history', title: 'History' }] });
      const history = next.sources.length === 1;
      messagesContainer.lastElementChild.remove();
      const other = { sources: [], chatId: 'another-chat', signal: new AbortController().signal };
      addSource('https://example.test/other', 'Other chat', other);
      return { cancelled, history, navigation: other.sources.length === 1 && !envSources.some(s => s.url.includes('/other')) };
    } finally {
      searchFetch = originalFetch;
      envSources = originalSources;
      renderEnvSources();
    }
  });
  check('stopped fetch cannot add citations to another reply', ownership.cancelled);
  check('history hydration cannot contaminate an active reply', ownership.history);
  check('other-chat sources stay out of the visible environment', ownership.navigation);

  await page.evaluate(() => {
    document.querySelectorAll('.agent-thinking-state').forEach(el => el.classList.add('collapsed'));
    const spacer = document.createElement('div');
    spacer.id = 'test-history-spacer';
    spacer.style.cssText = 'height:1000px;flex-shrink:0';
    messagesContainer.prepend(spacer);
  });
  async function gap(label) {
    await page.waitForFunction(() => {
      const composer = document.querySelector('.capsule-input-container');
      return Math.abs(parseFloat(messagesContainer.style.paddingBottom) - composer.offsetHeight - 30) < 1;
    });
    const metrics = await page.evaluate(async () => {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      await new Promise(requestAnimationFrame);
      const last = messagesContainer.lastElementChild.getBoundingClientRect();
      const bar = document.getElementById('capsule-input-bar').getBoundingClientRect();
      return { gap: bar.top - last.bottom, bottom: last.bottom, top: bar.top, padding: messagesContainer.style.paddingBottom };
    });
    console.log(label, metrics);
    check(label + ' has 14px clearance', Math.abs(metrics.gap - 14) <= 1);
  }
  await gap('normal composer');
  await page.fill('#capsule-prompt-input', 'one\ntwo\nthree\nfour\nfive\nsix');
  await gap('multiline composer');
  await page.setInputFiles('#capsule-file-input', { name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
  await page.waitForSelector('.capsule-att-thumb');
  await gap('composer with image attachment');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 720));
  await gap('resized window');
  await page.screenshot({ path: path.join(out, '03-reply-clearance.png'), animations: 'disabled' });
  check('no renderer errors', errors.length === 0);
  if (errors.length) console.log(errors);
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ checks, browse, search }, null, 2));
} catch (error) {
  check('test completed: ' + error.message, false);
  if (page) await page.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
  await app.close();
}
const passed = checks.filter(([, ok]) => ok).length;
console.log(`${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exitCode = 1;
