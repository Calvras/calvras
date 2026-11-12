import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const label = process.env.CALVRAS_STREAM_LABEL || 'after';
const out = path.resolve('.agents/artifacts/response-redesign/stream-' + label);
await fs.mkdir(out, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-stream-check-'));
const server = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><html><head><title>Layout verification</title></head><body><h1>Preview layout test</h1><input aria-label="Example input"></body></html>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const previewUrl = 'http://127.0.0.1:' + server.address().port;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.env.CALVRAS_TEST_EXE;
const app = await electron.launch({
  executablePath: path.resolve(packaged || 'node_modules/electron/dist/electron.exe'),
  args: [...(packaged ? [] : ['main.cjs']), '--user-data-dir=' + profile], env, timeout: 60000,
});
const checks = [];
const check = (name, ok) => { checks.push([name, Boolean(ok)]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
let page;
const errors = [];
try {
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  const appRoot = await app.evaluate(({ app }) => app.getAppPath());
  await page.goto(pathToFileURL(path.join(appRoot, 'app.html')).href);
  await page.waitForSelector('#prompt-input');
  check('sidebar starts collapsed', await page.locator('#sidebar').evaluate(el => el.classList.contains('collapsed') && el.getBoundingClientRect().right <= 49));
  await page.evaluate(() => {
    window.__streamMetrics = { frames: 0, fadedFrames: 0, minOpacity: 1, firstBlockReplacements: 0, capturedLength: 0, maxLength: 0, pinnedFrames: 0, badGapFrames: 0, observations: [] };
    let firstBlock = null;
    function sample() {
      const metrics = window.__streamMetrics;
      const body = document.querySelector('.streaming-prose');
      if (body && body.textContent.length > 20) {
        metrics.frames++;
        const blocks = [...body.querySelectorAll('p, li, h1, h2, h3, h4, pre code')];
        const opacity = Math.min(1, ...blocks.map(el => Number(getComputedStyle(el).opacity)));
        metrics.minOpacity = Math.min(metrics.minOpacity, opacity);
        if (opacity < 0.95) metrics.fadedFrames++;
        const first = body.firstElementChild;
        if (firstBlock && firstBlock !== first) metrics.firstBlockReplacements++;
        firstBlock = first;
        metrics.capturedLength = body.textContent.length;
        metrics.maxLength = Math.max(metrics.maxLength, metrics.capturedLength);
        const gap = document.getElementById('capsule-input-bar').getBoundingClientRect().top - messagesContainer.lastElementChild.getBoundingClientRect().bottom;
        if (pinnedToBottom && messagesContainer.scrollHeight > messagesContainer.clientHeight + 1) {
          metrics.pinnedFrames++;
          if (Math.abs(gap - 14) > 1) metrics.badGapFrames++;
        }
        if (metrics.observations.length < 1500) metrics.observations.push({ t: performance.now(), chars: metrics.capturedLength, opacity, gap, pinned: pinnedToBottom, height: body.offsetHeight, top: body.getBoundingClientRect().top });
      }
      window.__streamFrame = requestAnimationFrame(sample);
    }
    sample();
  });
  const prompt = 'Give me an architecture plan for a multi-tenant project management app with teams, projects, tasks, realtime collaboration, and Google sign-in. Start with a short Overview paragraph, then cover Components, Data flow, Storage, and Deployment. Include a small schema code block and a comparison table. Planning only; do not write files or run commands.';
  await page.fill('#prompt-input', prompt);
  await page.click('#send-btn');
  await page.waitForFunction(() => document.querySelector('.streaming-prose')?.textContent.length > 20 || (!isGenerating && chats.find(chat => chat.id === activeChatId)?.messages.at(-1)?.role === 'assistant'), null, { timeout: 120000 });
  const deadline = Date.now() + 90000;
  let frame = 0;
  let manualScroll = null;
  let resumed = false;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({ active: isGenerating, chars: window.__streamMetrics.maxLength, overflow: messagesContainer.scrollHeight - messagesContainer.clientHeight, top: messagesContainer.scrollTop }));
    if (!state.active) break;
    if (!manualScroll && state.chars > 1000 && state.overflow > 400) {
      const bounds = await page.locator('#messages-container').boundingBox();
      await page.mouse.move(bounds.x + bounds.width - 5, bounds.y + 100);
      await page.mouse.wheel(0, -350);
      await page.waitForFunction(top => messagesContainer.scrollTop < top - 100 && !pinnedToBottom, state.top);
      manualScroll = await page.evaluate(() => ({ top: messagesContainer.scrollTop, chars: window.__streamMetrics.maxLength }));
    } else if (manualScroll && !resumed && state.chars > manualScroll.chars + 400) {
      check('manual scroll stays put as real model text grows', Math.abs(state.top - manualScroll.top) < 2);
      await page.screenshot({ path: path.join(out, 'manual-scroll.png') });
      await page.mouse.wheel(0, 100000);
      await page.waitForFunction(() => pinnedToBottom);
      resumed = true;
    }
    if (frame < 30) {
      await page.screenshot({ path: path.join(out, 'frame-' + String(frame++).padStart(2, '0') + '.png') });
    }
    await page.waitForTimeout(120);
  }
  await page.waitForFunction(() => !isGenerating && chats.find(chat => chat.id === activeChatId)?.messages.at(-1)?.role === 'assistant', null, { timeout: 30000 });
  const result = await page.evaluate(() => {
    cancelAnimationFrame(window.__streamFrame);
    const answer = chats.find(chat => chat.id === activeChatId).messages.at(-1);
    return { metrics: window.__streamMetrics, answer, finalVisible: !!document.querySelector('.agent-workflow-container > .agent-phase-message'), collapsed: !document.querySelector('.agent-work-summary')?.open, cursorCount: document.querySelectorAll('.streaming-cursor').length, gap: document.getElementById('capsule-input-bar').getBoundingClientRect().top - messagesContainer.lastElementChild.getBoundingClientRect().bottom };
  });
  check('observed real model text during multiple animation frames', result.metrics.frames > 15 && result.answer.content.length > 500);
  check('already-written text never fades during streaming', result.metrics.fadedFrames === 0);
  check('first rendered block stays mounted while text arrives', result.metrics.firstBlockReplacements === 0);
  check('pinned streaming reply maintains 14px input clearance', result.metrics.pinnedFrames > 15 && result.metrics.badGapFrames === 0);
  check('manual scrolling and return to bottom were exercised live', !!manualScroll && resumed);
  check('finished reply maintains 14px input clearance', Math.abs(result.gap - 14) <= 1);
  check('finished reply stays visible with collapsed work and no cursor', result.finalVisible && result.collapsed && result.cursorCount === 0);
  await page.screenshot({ path: path.join(out, 'completed.png') });
  const boundaries = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.className = 'message-row assistant';
    document.querySelector('#messages-container').appendChild(host);
    const phase = createAgentPhase(host);
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const prefix = 'An overview that stays readable while the rest arrives.\n\n';
    const partial = prefix + '```sql\nCREATE TABLE tasks (tenant_id uuid';
    phase.setInterim(stripToolBlocks(partial));
    await frame();
    const body = host.querySelector('.agent-phase-message');
    const paragraph = body.firstElementChild;
    const code = body.querySelector('pre code');
    const codeId = code?.id;
    const copy = body.querySelector('.code-copy-btn');
    const cursor = body.querySelector('.streaming-cursor');
    copy?.focus();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const complete = partial + ', title text);\n```\n\n| Store | Role |\n|---|---|\n| Postgres | Durable |\n\n- First item\n- Second item';
    phase.setInterim(stripToolBlocks(complete));
    phase.setInterim(stripToolBlocks(complete + '\n- Third item'));
    await frame();
    const stable = paragraph === body.firstElementChild && code === body.querySelector('pre code') && codeId === code?.id && cursor === body.querySelector('.streaming-cursor');
    const focusStable = document.activeElement === copy;
    const selectionStable = getSelection().toString() === paragraph.textContent;
    const copyTargetStable = copy?.getAttribute('onclick').includes(codeId);
    phase.setInterim(stripToolBlocks(complete + '\n- Third item\n\nThe latest queued text.'));
    phase.finalize();
    await frame();
    const stopped = body.textContent.includes('The latest queued text.') && !body.querySelector('.streaming-cursor') && !body.classList.contains('streaming-prose');
    const markdown = body.querySelectorAll('table tbody tr').length === 1 && body.querySelectorAll('li').length === 3 && code?.textContent.includes('tenant_id uuid, title text');
    const finalPhase = createAgentPhase(host);
    finalPhase.setInterim(prefix);
    await frame();
    const finalBody = host.lastElementChild.querySelector('.agent-phase-message');
    const finalParagraph = finalBody.firstElementChild;
    finalPhase.setInterim(prefix + 'pending');
    finalPhase.setFinalMessage(prefix + 'Final answer.');
    finalPhase.finalize();
    await frame();
    const finalized = finalBody.firstElementChild === finalParagraph && finalBody.textContent.includes('Final answer.') && !finalBody.textContent.includes('pending') && finalBody.querySelectorAll('.reply-actions').length === 1 && !finalBody.querySelector('.streaming-cursor');
    const empty = createAgentPhase(host);
    empty.setInterim('This pending text must not return.');
    empty.setFinalMessage('');
    empty.finalize();
    await frame();
    const emptyBody = host.lastElementChild.querySelector('.agent-phase-message');
    const emptyOk = !emptyBody.textContent.includes('pending') && !emptyBody.querySelector('.streaming-cursor') && emptyBody.querySelectorAll('.reply-actions').length === 0;
    const errorPhase = createAgentPhase(host);
    errorPhase.setInterim('Preserve this partial answer after failure.');
    errorPhase.finalize();
    errorPhase.showError('Connection interrupted.');
    await frame();
    const errorOk = host.lastElementChild.textContent.includes('Preserve this partial answer') && !!host.lastElementChild.querySelector('.agent-phase-error') && !host.lastElementChild.querySelector('.streaming-cursor');
    const toolSafe = !stripToolBlocks(prefix + '```run:npm test\nprivate tool body').includes('private tool body');
    const safe = document.createElement('div');
    safe.innerHTML = formatMarkdown(stripToolBlocks('```html\n<script>window.__unsafe = true</script>'));
    const codeSafe = safe.querySelector('pre code')?.textContent.includes('<script>') && !safe.querySelector('script');
    getSelection().removeAllRanges();
    host.remove();
    return { stable, focusStable, selectionStable, copyTargetStable, stopped, markdown, finalized, emptyOk, errorOk, toolSafe, codeSafe };
  });
  for (const [name, ok] of Object.entries(boundaries)) check('stream boundary: ' + name, ok);
  const short = await page.evaluate(async () => {
    messagesContainer.replaceChildren();
    renderUserMessage('A short question.');
    const row = document.createElement('div');
    row.className = 'message-row assistant';
    messagesContainer.appendChild(row);
    window.__layoutPhase = createAgentPhase(row);
    window.__layoutPhase.setInterim('A short answer.');
    scrollThreadToBottom(true);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { top: messagesContainer.firstElementChild.getBoundingClientRect().top - messagesContainer.getBoundingClientRect().top, padding: parseFloat(getComputedStyle(messagesContainer).paddingTop), gap: document.getElementById('capsule-input-bar').getBoundingClientRect().top - row.getBoundingClientRect().bottom };
  });
  check('short conversation keeps the user message at the top', Math.abs(short.top - short.padding) < 1 && short.gap >= 13);
  await page.screenshot({ path: path.join(out, 'short-top-aligned.png') });
  await page.evaluate(async () => {
    window.__layoutText = Array.from({ length: 70 }, (_, i) => 'Paragraph ' + i + ' remains readable while more text arrives.').join('\n\n');
    window.__layoutPhase.setInterim(window.__layoutText);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const box = await page.locator('#messages-container').boundingBox();
  await page.mouse.move(box.x + box.width - 5, box.y + 120);
  await page.mouse.wheel(0, -400);
  await page.waitForFunction(() => !pinnedToBottom);
  const away = await page.evaluate(() => messagesContainer.scrollTop);
  await page.evaluate(async () => {
    window.__layoutPhase.setFinalMessage(window.__layoutText + '\n\nThe response has finished.');
    window.__layoutPhase.finalize();
    scrollThreadToBottom();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  check('completion does not pull a manually scrolled reader to bottom', await page.evaluate(top => Math.abs(messagesContainer.scrollTop - top) < 2 && !pinnedToBottom, away));
  await page.mouse.wheel(0, 100000);
  await page.waitForFunction(() => pinnedToBottom);
  await page.fill('#capsule-prompt-input', 'One line\nTwo lines\nThree lines\nFour lines');
  await page.waitForFunction(() => Math.abs(document.getElementById('capsule-input-bar').getBoundingClientRect().top - messagesContainer.lastElementChild.getBoundingClientRect().bottom - 14) <= 1);
  check('growing the composer preserves 14px clearance', true);
  await page.fill('#capsule-prompt-input', '');
  await page.evaluate(url => window.openLivePreview(url), previewUrl);
  await page.waitForFunction(() => { try { return previewSiteView?.getTitle() === 'Layout verification' && previewSiteView.dataset.ready === 'true'; } catch { return false; } });
  await page.waitForFunction(() => !previewPanel.getAnimations().length);
  const split = () => page.evaluate(() => {
    const preview = previewPanel.getBoundingClientRect().width;
    const chat = document.querySelector('.main-content').getBoundingClientRect().width;
    return { preview: preview / (preview + chat), collapsed: sidebar.classList.contains('collapsed'), gap: document.getElementById('capsule-input-bar').getBoundingClientRect().top - messagesContainer.lastElementChild.getBoundingClientRect().bottom };
  });
  const wide = await split();
  check('preview opens at 60% with chat at 40% and collapsed sidebar', Math.abs(wide.preview - 0.6) < 0.002 && wide.collapsed);
  check('preview opening preserves 14px reply clearance', Math.abs(wide.gap - 14) <= 1);
  await page.screenshot({ path: path.join(out, 'preview-60-40.png') });
  await page.locator('#preview-resize-handle').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => !previewPanel.getAnimations().length);
  check('preview keyboard resizing remains available', (await split()).preview < 0.59);
  await page.click('#preview-close-btn');
  await page.evaluate(() => window.openLivePreview());
  await page.waitForFunction(() => !previewPanel.getAnimations().length);
  check('reopening preview restores the 60/40 default', Math.abs((await split()).preview - 0.6) < 0.002);
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.unmaximize(); win.setSize(1050, 720); });
  await page.waitForFunction(() => innerWidth < 1100 && !previewPanel.getAnimations().length && Math.abs(previewPanel.getBoundingClientRect().width - parseFloat(previewPanel.style.getPropertyValue('--preview-width'))) < 1 && Math.abs(parseFloat(messagesContainer.style.paddingBottom) - document.querySelector('.capsule-input-container').offsetHeight - 30) < 1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const narrow = await split();
  console.log(JSON.stringify({ wide, narrow }));
  check('narrow preview retains 60/40 and 14px reply clearance', Math.abs(narrow.preview - 0.6) < 0.002 && Math.abs(narrow.gap - 14) <= 1);
  await page.screenshot({ path: path.join(out, 'preview-narrow.png') });
  await page.click('#rail-sidebar-btn');
  check('sidebar can still be explicitly expanded', await page.locator('#sidebar').evaluate(el => !el.classList.contains('collapsed')));
  await page.reload();
  await page.waitForSelector('#prompt-input');
  check('sidebar is collapsed again after reload', await page.locator('#sidebar').evaluate(el => el.classList.contains('collapsed')));
  const guidance = await page.evaluate(() => {
    const previous = activeWorkspaceDir;
    activeWorkspaceDir = '';
    const general = buildAgentSystemPrompt([]);
    activeWorkspaceDir = previous || 'C:/example-project';
    const workspace = buildAgentSystemPrompt([]);
    activeWorkspaceDir = previous;
    return { shared: general.includes(BUILD_STACK_GUIDANCE) && workspace.includes(BUILD_STACK_GUIDANCE), noHtmlDefault: !workspace.includes('use a CDN script') && !workspace.includes('375px') };
  });
  check('both prompt paths prefer suitable frameworks and preserve explicit HTML requests', guidance.shared && guidance.noHtmlDefault);
  const stackAnswer = await page.evaluate(async () => {
    const result = await streamCompletion([{ role: 'system', content: buildAgentSystemPrompt([]) }, { role: 'user', content: 'For a new full project-management web app with authentication, teams, and a dashboard recreated from a screenshot, which stack would you choose by default? Then say what you would use if I explicitly ask for a simple single-file HTML page. Answer in two sentences only; planning only, no tools, no files, no commands.' }]);
    return result.content;
  });
  console.log(JSON.stringify({ stackAnswer }));
  check('real model chooses an app framework and honors an explicit simple HTML request', /React|Next\.js|Vite/i.test(stackAnswer) && /TypeScript/i.test(stackAnswer) && /HTML/i.test(stackAnswer));
  check('no renderer errors', errors.length === 0);
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ ...result, screenshots: frame, checks, errors }, null, 2));
  console.log(JSON.stringify({ ...result.metrics, observations: undefined, screenshots: frame }));
} catch (error) {
  check('streaming verification completed: ' + error.message, false);
  if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log(`${checks.filter(([, ok]) => ok).length}/${checks.length} checks passed`);
if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
