import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const out = '.agents/artifacts/preview-build';
await fs.mkdir(out, { recursive: true });
const savedBuild = process.env.REUSE_BUILD ? JSON.parse(await fs.readFile(path.join(out, 'demo.json'), 'utf8')) : null;
const workspace = savedBuild?.workspace || await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-task-board-'));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-build-profile-'));
const checks = [];
const check = (label, ok) => { checks.push([label, Boolean(ok)]); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['main.cjs', '--user-data-dir=' + profile], env, timeout: 60000 });
let page;
try {
  page = await app.firstWindow();
  const errors = [];
  const failedRequests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('requestfailed', r => { if (r.url().startsWith('http://127.0.0.1:')) failedRequests.push(r.url() + ' ' + r.failure()?.errorText); });
  await page.goto(pathToFileURL(path.resolve('app.html')).href);
  await page.waitForSelector('#prompt-input');
  check('incomplete markdown and streamed list prefixes stay responsive', await page.evaluate(() => {
    const start = performance.now();
    ['=', '-', '***bold***', '___bold___', '>quote', '```js\nconst x = 1;\n``` trailing'].forEach(text => formatMarkdown(text));
    const list = 'I will build the app.\n\n- Check documentation\n- Write the page\n- Test it';
    for (let i = 1; i <= list.length; i++) formatMarkdown(list.slice(0, i));
    return performance.now() - start < 500;
  }));
  check('streamed tool code and plans stay out of reply prose', await page.evaluate(() => {
    const tool = 'Writing the file.\n\n```write:index.html\n<style>body { color: red; }</style>';
    return stripToolBlocks(tool) === 'Writing the file.'
      && stripToolBlocks('```plan:\n- [ ] Build\n```') === ''
      && stripToolBlocks('```js\nconst x = 1;\n```').includes('```js');
  }));
  await page.evaluate(async dir => {
    await getElectronIpc().invoke('workspace:set-folder', dir);
    await refreshWorkspaceInfo();
  }, workspace);
  let result;
  const started = Date.now();
  if (savedBuild) {
    await page.evaluate(saved => {
      chats = [saved.chat];
      saveChatsToStorage();
      loadChatById(saved.chat.id);
      window.openLivePreview('index.html');
    }, savedBuild);
    result = savedBuild;
    console.log('Retesting the existing real-model build; no new generation.');
  } else {
  const prompt = 'Check current MDN documentation for localStorage, then build a polished dark task board called Orbit Tasks in this empty folder. Use one complete index.html with inline CSS and JavaScript, no dependencies or external assets. Functional requirements: an input accessible as "Task name", an "Add task" button, real checkboxes to complete tasks, a "Clear completed" button, and localStorage persistence across reload. Reject blank task names and render user text safely with textContent. Start with no tasks. Use a compact header, warm dark cards, a muted violet accent, live task counts, responsive layout, and a helpful empty state. Open the working preview when finished. Do not commit or push.';
  await page.fill('#prompt-input', prompt);
  await page.click('#send-btn');
  await page.waitForFunction(() => !!document.querySelector('.agent-tool-item'), null, { timeout: 60000 });
  check('live progress visible while the real model works', await page.evaluate(() => isGenerating && !!document.querySelector('.agent-thinking-state.is-live')));
  await page.screenshot({ path: path.join(out, '01-working.png'), animations: 'disabled' });
  await page.waitForFunction(() => !isGenerating && chats[0]?.messages.at(-1)?.role === 'assistant', null, { timeout: 240000 });
  result = await page.evaluate(() => ({ chat: chats[0], sourceCount: document.querySelectorAll('.reply-sources a').length, selectedTool: selectedPromptTool, previewUrl: livePreviewUrl }));
  await fs.writeFile(path.join(out, 'demo.json'), JSON.stringify({ workspace, ...result }, null, 2));
  }
  const nodes = result.chat.messages.filter(m => m.role === 'assistant').flatMap(m => m.trace || []).flatMap(p => p.tools || []);
  console.log(JSON.stringify({ ms: Date.now() - started, workspace, content: result.chat.messages.at(-1).content, nodes: nodes.map(n => ({ kind: n.kind, path: n.path, query: n.query, failed: n.failed, error: n.error })), sources: result.sourceCount }, null, 2));
  check('model looked up documentation automatically with no selected tool', result.selectedTool === null && nodes.some(n => ['search', 'web', 'fetch'].includes(n.kind) && n.output && !n.failed));
  check('coding reply shows real sources', result.sourceCount > 0);
  check('model created a real index.html', (await fs.stat(path.join(workspace, 'index.html'))).size > 500);
  const runs = nodes.filter(n => n.kind === 'run');
  check('agent completed with successful verification after any retry', !result.chat.messages.at(-1).stopped && runs.at(-1)?.failed === false && nodes.filter(n => n.kind !== 'run').every(n => !n.failed));
  await page.waitForSelector('#preview-panel.open');
  const frame = page.frameLocator('#preview-iframe');
  await frame.getByRole('button', { name: 'Add task', exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, '02-built-preview.png'), animations: 'disabled' });
  await frame.getByRole('button', { name: 'Add task', exact: true }).click();
  check('blank task is rejected', await frame.getByRole('checkbox').count() === 0);
  await frame.getByRole('textbox', { name: 'Task name', exact: true }).fill('Review the preview frame');
  await frame.getByRole('button', { name: 'Add task', exact: true }).click();
  check('add task works', await frame.getByRole('checkbox').count() === 1);
  await frame.getByRole('checkbox').first().check();
  await page.click('#preview-refresh-btn');
  await frame.getByRole('checkbox').first().waitFor();
  check('task completion survives preview reload', await frame.getByRole('checkbox').first().isChecked());
  await frame.getByRole('button', { name: 'Clear completed', exact: true }).click();
  check('clear completed works', await frame.getByRole('checkbox').count() === 0);
  const unsafe = '<img src=x onerror="window.__injected=true">';
  await frame.getByRole('textbox', { name: 'Task name', exact: true }).fill(unsafe);
  await frame.getByRole('button', { name: 'Add task', exact: true }).click();
  check('task text cannot inject HTML', await frame.locator('body').evaluate(el => el.textContent.includes('<img src=x') && !window.__injected && !el.querySelector('img[src="x"]')));
  await frame.getByRole('checkbox').first().check();
  await frame.getByRole('button', { name: 'Clear completed', exact: true }).click();
  await frame.getByRole('textbox', { name: 'Task name', exact: true }).fill('Ship the next idea');
  await frame.getByRole('button', { name: 'Add task', exact: true }).click();

  async function geometry(label) {
    await page.waitForFunction(() => !previewPanel.getAnimations().length);
    const m = await page.evaluate(() => {
      const panel = previewPanel.getBoundingClientRect();
      const body = document.querySelector('.preview-panel-body').getBoundingClientRect();
      const css = getComputedStyle(document.querySelector('.preview-panel-body'));
      return { top: body.top, right: innerWidth - body.right, bottom: innerHeight - body.bottom, radius: css.borderRadius, border: css.borderWidth, panelRight: panel.right, width: innerWidth, color: css.backgroundColor, dpr: devicePixelRatio };
    });
    console.log(label, m);
    check(label + ' frame matches measured 18px/1px/49px/7px/6px geometry', m.radius === '18px' && Math.abs(parseFloat(m.border) * m.dpr - Math.floor(m.dpr)) < 0.01 && Math.abs(m.top - 49) < 1 && Math.abs(m.right - 7) < 1 && Math.abs(m.bottom - 6) < 1);
    check(label + ' preview never overflows app window', m.panelRight <= m.width + 1);
  }
  await geometry('wide');
  await page.locator('#preview-resize-handle').focus();
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => new Promise(requestAnimationFrame));
  check('keyboard resizing changes and bounds the share', await page.evaluate(() => previewShare >= PREVIEW_MIN_SHARE && previewShare <= PREVIEW_MAX_SHARE && previewShare < PREVIEW_DEFAULT_SHARE));
  await page.evaluate(async () => { messagesContainer.scrollTop = messagesContainer.scrollHeight; await new Promise(requestAnimationFrame); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 720));
  await page.waitForFunction(() => innerWidth < 1100);
  await geometry('narrow');
  const replyGap = await page.evaluate(() => {
    const last = messagesContainer.lastElementChild;
    const bottom = last.getBoundingClientRect().bottom;
    const top = document.getElementById('capsule-input-bar').getBoundingClientRect().top;
    return { gap: top - bottom, remaining: messagesContainer.scrollHeight - messagesContainer.clientHeight - messagesContainer.scrollTop, margin: getComputedStyle(last).marginBottom };
  });
  console.log('resized reply clearance', replyGap);
  check('resizing preserves the pinned 14px reply gap', Math.abs(replyGap.gap - 14) < 1);
  check('generated app has no horizontal overflow', await frame.locator('html').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  check('narrow chat keeps its send control inside the composer', await page.evaluate(() => {
    const composer = document.getElementById('capsule-input-bar').getBoundingClientRect();
    const send = document.getElementById('capsule-send-btn').getBoundingClientRect();
    return send.right <= composer.right && send.bottom <= composer.bottom;
  }));
  await page.screenshot({ path: path.join(out, '03-tested-narrow.png'), animations: 'disabled' });
  await page.click('#preview-close-btn');
  check('close hides preview', await page.evaluate(() => !isLivePreviewOpen()));
  await page.evaluate(() => window.openLivePreview());
  await page.waitForSelector('#preview-panel.open');
  check('reopen preserves working task board', await frame.getByRole('checkbox').count() === 1);
  check('no app or generated-page JavaScript errors', errors.length === 0);
  check('no failed local preview requests', failedRequests.length === 0);
  if (errors.length || failedRequests.length) console.log({ errors, failedRequests });
} catch (error) {
  check('test completed: ' + error.message, false);
  if (page) console.log(await page.evaluate(() => ({ generating: isGenerating, transcript: messagesContainer.innerText, messages: chats[0]?.messages })).catch(() => ({})));
  if (page) await page.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled' }).catch(() => {});
} finally {
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2));
  await app.close();
}
const passed = checks.filter(([, ok]) => ok).length;
console.log(`${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exitCode = 1;
