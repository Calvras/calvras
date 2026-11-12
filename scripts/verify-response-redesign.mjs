import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const root = process.cwd();
const out = path.join(root, '.agents/artifacts/response-redesign');
await fs.mkdir(out, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-response-ui-'));
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-preview-ui-'));
await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html><html><title>Local preview check</title><body><input id="name"><button id="save" onclick="document.getElementById(\'result\').textContent=document.getElementById(\'name\').value">Save</button><p id="result"></p></body></html>');
const checks = [];
const evidence = { profile };
const check = (label, value) => { checks.push([label, Boolean(value)]); console.log(`${value ? 'PASS' : 'FAIL'} ${label}`); };
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const packagedExe = process.env.CALVRAS_TEST_EXE;
const app = await electron.launch({
  executablePath: packagedExe ? path.resolve(packagedExe) : path.join(root, 'node_modules/electron/dist/electron.exe'),
  args: [...(packagedExe ? [] : ['main.cjs']), '--user-data-dir=' + profile], env, timeout: 60000,
});
let page;
const errors = [];
async function screenshot(name) {
  if (name.endsWith('-top')) {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      messagesContainer.scrollTop = 0;
    });
  }
  await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
  if (await page.locator('#preview-site-view').isVisible()) {
    await page.waitForFunction(async () => {
      const view = document.getElementById('preview-site-view');
      return Math.abs(await view.executeJavaScript('window.innerWidth') - view.clientWidth) <= 2;
    }, null, { timeout: 10000 });
  }
  await page.screenshot({ path: path.join(out, name + '.png') });
}
async function send(prompt) {
  const before = await page.evaluate(() => chats.find(chat => chat.id === activeChatId)?.messages.length || 0);
  const start = Date.now();
  const home = await page.locator('#prompt-input').isVisible();
  await page.fill(home ? '#prompt-input' : '#capsule-prompt-input', prompt);
  await page.click(home ? '#send-btn' : '#capsule-send-btn');
  await page.waitForFunction(({ before, prompt }) => {
    const messages = chats.find(chat => chat.id === activeChatId)?.messages || [];
    return !isGenerating && messages.length === before + 2 && messages[before]?.content === prompt && messages.at(-1)?.role === 'assistant';
  }, { before, prompt }, { timeout: 180000 });
  const result = await page.evaluate(() => chats.find(chat => chat.id === activeChatId).messages.at(-1));
  console.log(JSON.stringify({ prompt, ms: Date.now() - start, content: result.content, tools: result.trace?.flatMap(phase => phase.tools || []).map(node => ({ kind: node.kind, failed: node.failed, detail: node.detail })) }));
  return result;
}
async function lastMetrics() {
  return page.evaluate(() => {
    const row = messagesContainer.querySelector('.message-row.assistant:last-child');
    const details = row.querySelector('.agent-work-summary');
    const final = row.querySelector('.agent-workflow-container > .agent-phase-message');
    return { count: row.querySelectorAll('.agent-work-summary').length, closed: details && !details.open, label: details?.querySelector('summary')?.textContent, finalVisible: !!final && final.getBoundingClientRect().height > 0, display: final && getComputedStyle(final).display, gap: final && getComputedStyle(final).gap };
  });
}
async function clearance(label) {
  await page.waitForFunction(() => Math.abs(parseFloat(messagesContainer.style.paddingBottom) - document.querySelector('.capsule-input-container').offsetHeight - 30) < 1);
  const value = await page.evaluate(async () => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    await new Promise(requestAnimationFrame);
    return document.getElementById('capsule-input-bar').getBoundingClientRect().top - messagesContainer.lastElementChild.getBoundingClientRect().bottom;
  });
  check(label + ' has 14px reply clearance', Math.abs(value - 14) <= 1);
  return value;
}
try {
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  const appRoot = await app.evaluate(({ app }) => app.getAppPath());
  await page.goto(pathToFileURL(path.join(appRoot, 'app.html')).href);
  await page.waitForSelector('#prompt-input');
  const saved = JSON.parse(await fs.readFile(path.join(out, 'architecture-response.json'), 'utf8'));
  await page.evaluate(saved => {
    const chat = { id: 'architecture-render-check', title: 'Architecture layout', messages: [
      { role: 'user', content: saved.prompt },
      { role: 'assistant', content: saved.response, durationMs: 5231, trace: [{ message: saved.response, tools: [], thought: 'Organize components, data, and deployment.', durationMs: 5231 }] },
    ] };
    chats.unshift(chat);
    saveChatsToStorage();
    loadChatById(chat.id);
    messagesContainer.scrollTop = 0;
  }, saved);
  await screenshot('architecture-after-top');
  const same = await lastMetrics();
  check('completed work has one closed timer and visible final answer', same.count === 1 && same.closed && same.finalVisible && /^Worked for 5s/.test(same.label));
  check('architecture blocks retain flex spacing', same.display === 'flex' && same.gap === '12px');
  const layout = await page.evaluate(() => {
    const row = messagesContainer.querySelector('.message-row.assistant:last-child');
    const body = row.querySelector('.agent-workflow-container > .agent-phase-message');
    const blocks = [...body.children].filter(el => !el.classList.contains('reply-actions'));
    return { font: getComputedStyle(body).fontSize, line: getComputedStyle(body).lineHeight, gaps: blocks.slice(1).map((el, i) => el.getBoundingClientRect().top - blocks[i].getBoundingClientRect().bottom), code: [...body.querySelectorAll('code')].map(el => el.textContent), sidebar: getComputedStyle(document.querySelector('.sidebar')).borderRightWidth, colors: ['.sidebar', '.main-content', '.preview-panel', '.preview-panel-header'].map(selector => getComputedStyle(document.querySelector(selector)).backgroundColor), gutter: !!document.querySelector('.thread-gutter') };
  });
  evidence.layout = layout;
  check('response uses 14px type, 22px line height, and 12px block gaps', layout.font === '14px' && layout.line === '22px' && layout.gaps.every(gap => Math.abs(gap - 12) < 1));
  check('real architecture inline code preserves tenant_id', layout.code.includes('tenant_id'));
  check('sidebar divider and dashed gutter are removed', layout.sidebar === '0px' && !layout.gutter);
  check('outside-preview surfaces match app background', layout.colors.every(color => color === 'rgb(24, 24, 24)'));
  const toggle = page.locator('.message-row.assistant:last-child .agent-work-toggle');
  await toggle.focus();
  await page.keyboard.press('Enter');
  check('keyboard expands all work without hiding final answer', await page.evaluate(() => document.querySelector('.agent-work-summary').open && document.querySelector('.agent-work-history .agent-group-header').getAttribute('aria-expanded') === 'true'));
  await screenshot('work-expanded');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await clearance('architecture');
  await screenshot('architecture-after-bottom');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 740));
  await clearance('narrow architecture');
  check('narrow response does not overflow the page', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await screenshot('architecture-after-narrow');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1368, 827));

  const boundary = await page.evaluate(async () => {
    const container = document.createElement('div');
    container.innerHTML = formatMarkdown('`tenant_id` and `SET app.tenant_id` [Docs](https://react.dev/reference/react/use_id) <img src=x onerror="window.__unsafe=1"> **bold** _italic_ [Broken](https://[)');
    const markdown = !container.querySelector('img,script') && container.querySelector('a')?.getAttribute('href') === 'https://react.dev/reference/react/use_id' && [...container.querySelectorAll('code')].some(el => el.textContent === 'tenant_id') && !!container.querySelector('strong') && !!container.querySelector('em');
    const current = { sources: [], chatId: activeChatId, userText: '', signal: new AbortController().signal };
    const unverified = await executeAgentBlock({ kind: 'preview', arg: 'https://unverified.example.test' }, null, current);
    const controller = new AbortController(); controller.abort();
    const canceled = await executeAgentBlock({ kind: 'preview', arg: 'https://react.dev' }, null, { ...current, signal: controller.signal, userText: 'open https://react.dev' });
    const stale = await executeAgentBlock({ kind: 'preview', arg: 'https://react.dev' }, null, { ...current, chatId: 'other-chat', userText: 'open https://react.dev' });
    const malformed = ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,hello', 'https://user:pass@example.test'].every(url => !normalizePreviewUrl(url));
    const stoppedHost = document.createElement('div');
    const phases = [{ message: 'Partial work', tools: [], thought: 'Checking', error: 'Stopped', durationMs: 1300 }];
    renderArchivedPhase(stoppedHost, phases[0]);
    settleAgentWorkflow(stoppedHost, phases, 'Partial work', 1300, 'user');
    const stopped = stoppedHost.querySelector('summary').textContent.startsWith('Stopped after') && !stoppedHost.querySelector('details').open && stoppedHost.textContent.includes('Partial work');
    const sources = document.createElement('div');
    renderReplySources(sources, [{ url: 'javascript:alert(1)', title: 'bad' }, { url: 'https://user:pass@example.test', title: 'bad' }, { url: 'https://react.dev', title: '<img src=x onerror=alert(1)>' }]);
    const safeSources = sources.querySelectorAll('a').length === 1 && sources.querySelector('.reply-source-title').textContent.startsWith('<img') && !sources.querySelector('.reply-source-title img');
    return { markdown, unverified: unverified.failed, canceled: canceled.failed, stale: stale.failed, malformed, stopped, safeSources };
  });
  for (const [label, passed] of Object.entries(boundary)) check('boundary: ' + label, passed);

  await page.click('#rail-home-btn');
  evidence.architecture = await send('Give me an architecture plan for a multi-tenant project management app with teams, projects, tasks, realtime collaboration, and Google sign-in. Planning only, do not write files or run commands. Keep it concise but cover components, data flow, storage, and deployment.');
  check('real model returns an architecture plan without tools', evidence.architecture.content.length > 200 && !evidence.architecture.trace.some(phase => phase.tools?.length));
  check('real architecture final answer is visible and work closed', (await lastMetrics()).finalVisible && (await lastMetrics()).closed);
  await page.evaluate(() => { messagesContainer.scrollTop = 0; });
  await screenshot('architecture-live-top');
  await clearance('live architecture');
  await screenshot('architecture-live-bottom');

  await page.click('#rail-home-btn');
  evidence.site = await send('Search for the official React website');
  const siteTools = evidence.site.trace?.flatMap(phase => phase.tools || []) || [];
  check('site request performs live search and opens a verified preview', siteTools.some(node => ['web', 'search'].includes(node.kind) && !node.failed) && siteTools.some(node => node.kind === 'preview' && !node.failed));
  await page.waitForSelector('#preview-site-view', { timeout: 20000 });
  await page.waitForFunction(async () => {
    const view = document.getElementById('preview-site-view');
    try { return !view.isLoading() && await view.executeJavaScript('document.body.innerText.length > 100'); } catch { return false; }
  }, null, { timeout: 60000 });
  const guest = await app.evaluate(async ({ webContents }) => {
    const view = webContents.getAllWebContents().find(contents => contents.getType() === 'webview');
    const prefs = view.getLastWebPreferences();
    return { url: view.getURL(), title: view.getTitle(), prefs: { nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, webSecurity: prefs.webSecurity }, globals: await view.executeJavaScript('({require:typeof require,process:typeof process,body:document.body.innerText.slice(0,100)})') };
  });
  evidence.guest = guest;
  check('real React page loads inside preview', new URL(guest.url).hostname === 'react.dev' && guest.globals.body.length > 0);
  check('public website has no Node globals and stays sandboxed', !guest.prefs.nodeIntegration && guest.prefs.contextIsolation && guest.prefs.sandbox && guest.prefs.webSecurity && guest.globals.require === 'undefined' && guest.globals.process === 'undefined');
  const frame = await page.evaluate(() => {
    const body = document.querySelector('.preview-panel-body');
    const rect = body.getBoundingClientRect();
    const view = document.querySelector('#preview-site-view').getBoundingClientRect();
    const css = getComputedStyle(body);
    return { top: rect.top, radius: css.borderRadius, margin: css.margin, height: view.height, width: view.width, container: rect.width };
  });
  evidence.frame = frame;
  check('preview frame retains exact radius and insets', frame.radius === '18px' && frame.margin === '5px 7px 6px 0px' && frame.top === 49);
  check('webview fills its rounded frame', frame.height > 500 && Math.abs(frame.width - frame.container + 2) < 1);
  await screenshot('website-preview');
  const sources = page.locator('.message-row.assistant:last-child .reply-sources');
  check('sources default to collapsed numbered rows', await sources.count() === 1 && !(await sources.evaluate(el => el.open)) && await sources.locator('.reply-source-index').count() > 0);
  await sources.locator('summary').focus();
  await page.keyboard.press('Enter');
  check('sources keyboard toggle reveals real clickable URLs', await sources.evaluate(el => el.open && [...el.querySelectorAll('a')].some(link => link.href.includes('react.dev'))));
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); messagesContainer.scrollTop = messagesContainer.scrollHeight; });
  await screenshot('sources-expanded');
  const restored = await page.evaluate(() => {
    const count = chats.find(chat => chat.id === activeChatId).messages.at(-1).sources.length;
    loadChatById(activeChatId);
    return { count, links: messagesContainer.querySelector('.message-row.assistant:last-child').querySelectorAll('.reply-source').length, closed: !messagesContainer.querySelector('.message-row.assistant:last-child .agent-work-summary').open };
  });
  check('sources and work summary survive saved-chat reload', restored.count === restored.links && restored.count > 0 && restored.closed);

  await page.click('#preview-close-btn');
  await page.waitForFunction(() => !isLivePreviewOpen());
  check('preview close button hides the site', !(await page.evaluate(() => isLivePreviewOpen())));
  await page.click('#rail-home-btn');
  evidence.research = await send('Search the web for how React useState works and explain the key rule about updating state in two sentences with a source.');
  const researchTools = evidence.research.trace?.flatMap(phase => phase.tools || []) || [];
  check('information request searches without opening preview', researchTools.some(node => ['web', 'search', 'fetch'].includes(node.kind) && !node.failed) && !researchTools.some(node => node.kind === 'preview') && !(await page.evaluate(() => isLivePreviewOpen())));
  await screenshot('information-search');

  await page.evaluate(async dir => {
    await getElectronIpc().invoke('workspace:set-folder', dir);
    await refreshWorkspaceInfo();
    window.openLivePreview('index.html?check=one#test');
  }, workspace);
  const localFrame = page.frameLocator('#preview-iframe');
  await localFrame.locator('#name').fill('Calvras');
  await localFrame.locator('#save').click();
  const result = await localFrame.locator('#result').textContent();
  const local = await page.evaluate(async () => {
    let missing = false;
    try { await performBrowserAction('click #missing'); } catch { missing = true; }
    const before = window.getLivePreviewUrl();
    window.reloadLivePreview();
    return { noGuest: !previewSiteView, missing, query: before.includes('?check=one#test') && window.getLivePreviewUrl() === before };
  });
  check('switching to local preview preserves user clicks and typing', local.noGuest && result === 'Calvras');
  check('unavailable browser control fails honestly', local.missing);
  check('preview reload preserves query and hash', local.query);
  await screenshot('local-preview');
  check('no renderer errors', errors.length === 0);
} catch (error) {
  check('verification completes: ' + error.message, false);
  evidence.failure = error.stack;
  if (page) await screenshot('failure').catch(() => {});
} finally {
  evidence.errors = errors;
  evidence.checks = checks;
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify(evidence, null, 2));
  await app.close();
}
console.log(`${checks.filter(([, ok]) => ok).length}/${checks.length} checks passed`);
if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
