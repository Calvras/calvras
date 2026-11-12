import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const out = path.resolve('.agents/artifacts/reference-workflow');
await fs.mkdir(out, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-reference-'));
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-tools-'));
const referenceImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#181818"/><rect width="70" height="300" fill="#080808"/><rect x="82" y="12" width="306" height="120" fill="#65717a"/><text x="92" y="115" fill="white" font-size="24">Reference fixture</text><rect x="82" y="146" width="80" height="120" fill="#a32626"/><rect x="180" y="146" width="80" height="120" fill="#24758c"/><rect x="278" y="146" width="80" height="120" fill="#bd9651"/></svg>');
const server = http.createServer((req, res) => {
  if (req.url === '/design.jpg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(referenceImage); return; }
  if (req.url === '/blank') { res.writeHead(202, { 'Content-Type': 'text/html' }); res.end('<!doctype html><body></body>'); return; }
  if (req.url === '/reference-delay') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Delayed design</title><main><div class="shot-media"></div></main><script>setTimeout(() => { document.querySelector(".shot-media").innerHTML = \'<img src="/design.jpg" alt="Delayed target" width="400" height="300">\'; }, 400)</script>'); return; }
  if (req.url === '/reference') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Odeum target fixture</title><main><h1>Odeum Featured</h1><div class="shot-media"><div class="block-media"><img src="/design.jpg" alt="Odeum design" width="400" height="300"></div></div><section class="related-shots"><img src="/design.jpg" alt="Unrelated recommendation" width="500" height="375"></section></main>'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><html><head><title>Browser fixture</title></head><body style="background:#181818;color:white"><h1>Reference fixture</h1><input id="query" aria-label="Search"><button id="apply" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#query\').value">Apply</button><p id="result">Ready</p><input id="password" type="password" value="never-read-me"><div style="height:1200px"></div></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const fixtureUrl = 'http://127.0.0.1:' + server.address().port;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['main.cjs', '--user-data-dir=' + profile], env, timeout: 60000 });
const checks = [];
const check = (name, ok) => { checks.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve('app.html')).href);
  await page.waitForSelector('#prompt-input');
  await page.evaluate(() => {
    activeChatId = 'dock-test';
    chats.push({ id: activeChatId, title: 'Task dock verification', messages: [] });
    showConversationView('Task dock verification');
    const text = document.createElement('div');
    text.className = 'message-row assistant';
    text.textContent = 'A long conversation';
    text.style.height = '1800px';
    text.style.flexShrink = '0';
    messagesContainer.appendChild(text);
    updateTaskChecklist([{ done: true, text: 'Inspect reference' }, { done: false, text: 'Match layout and typography' }, { done: false, text: 'Test interactions' }]);
    messagesContainer.appendChild(buildTerminalCard({ command: 'npm run build', output: 'Build completed\n3 modules transformed.', durationMs: 483, exitCode: 0 }));
    scrollThreadToBottom(true);
  });
  await page.waitForTimeout(350);
  check('task dock lives with composer, not transcript', await page.evaluate(() => !!document.querySelector('.capsule-input-container #composer-task-dock') && !messagesContainer.querySelector('.task-checklist')));
  check('task summary displays progress and current work', await page.locator('#composer-task-dock summary').innerText().then(t => t.includes('1 / 3') && t.includes('Match layout')));
  await page.locator('#composer-task-dock summary').click();
  check('task list expands', await page.locator('#composer-task-dock').evaluate(el => el.open));
  await page.evaluate(() => updateTaskChecklist([{ done: true, text: 'Inspect reference' }, { done: true, text: 'Match layout and typography' }, { done: false, text: 'Test interactions' }]));
  check('updating tasks preserves disclosure', await page.locator('#composer-task-dock').evaluate(el => el.open));
  const dockTop = await page.locator('#composer-task-dock').evaluate(el => el.getBoundingClientRect().top);
  await page.evaluate(() => { pinnedToBottom = false; messagesContainer.scrollTop = 150; });
  check('task dock stays fixed while conversation scrolls', Math.abs(dockTop - await page.locator('#composer-task-dock').evaluate(el => el.getBoundingClientRect().top)) < 1);
  await page.evaluate(() => scrollThreadToBottom(true));
  await page.waitForTimeout(250);
  check('reply has 14px clearance above combined composer', await page.evaluate(() => Math.abs(document.querySelector('#composer-task-dock').getBoundingClientRect().top - messagesContainer.lastElementChild.getBoundingClientRect().bottom - 14) < 1));
  check('terminal has no rerun button', await page.locator('.agent-terminal-card .agent-run-in-terminal-btn').count() === 0);
  check('terminal uses app background', await page.locator('.agent-terminal-card').evaluate(el => getComputedStyle(el).backgroundColor === 'rgb(24, 24, 24)'));
  check('terminal copy control remains', await page.locator('.agent-terminal-card button').count() === 1);
  check('preview glowing dot removed', await page.locator('.preview-live-dot').count() === 0);
  await page.screenshot({ path: path.join(out, 'composer-terminal.png') });
  await page.evaluate(() => { document.getElementById('env-panel').style.display = 'flex'; });
  check('GitHub connection is visible in Environment', await page.locator('#env-github-connect').isVisible());
  await page.screenshot({ path: path.join(out, 'environment.png') });
  await page.evaluate(() => { showHomeView(); });
  check('home clears task dock', await page.locator('#composer-task-dock').evaluate(el => el.hidden));
  await page.evaluate(() => loadChatById('dock-test'));
  check('chat restore restores its tasks', await page.locator('#task-dock-count').innerText().then(t => t === '2 / 3'));
  await page.evaluate(() => { activeChatId = 'empty-test'; chats.push({ id: activeChatId, title: 'Empty', messages: [] }); showConversationView('Empty'); });
  check('new chat does not inherit old tasks', await page.locator('#composer-task-dock').evaluate(el => el.hidden));
  await page.evaluate(url => window.openLivePreview(url), fixtureUrl);
  await page.waitForFunction(() => { try { return previewSiteView && !previewSiteView.isLoading() && previewSiteView.getURL().startsWith('http:'); } catch { return false; } });
  check('local preview uses sandboxed guest', await page.evaluate(() => previewSiteView.getAttribute('webpreferences').includes('sandbox=yes')));
  await fs.writeFile(path.join(workspace, 'sample.txt'), 'one\ntwo\nthree');
  const edits = await page.evaluate(async folder => {
    const ipc = getElectronIpc();
    await ipc.invoke('workspace:set-folder', folder);
    const success = await ipc.invoke('workspace:replace', { filePath: 'sample.txt', oldText: 'two', newText: 'second' });
    let missing = false, outside = false;
    try { await ipc.invoke('workspace:replace', { filePath: 'sample.txt', oldText: 'missing', newText: 'x' }); } catch { missing = true; }
    try { await ipc.invoke('workspace:replace', { filePath: '../outside.txt', oldText: 'x', newText: 'z' }); } catch { outside = true; }
    return { success, missing, outside };
  }, workspace);
  check('exact replacement writes one match', edits.success.replaced === 1 && await fs.readFile(path.join(workspace, 'sample.txt'), 'utf8') === 'one\nsecond\nthree');
  check('exact replacement rejects missing and outside paths', edits.missing && edits.outside);
  check('unsafe external URLs are rejected', await page.evaluate(async () => {
    const ipc = getElectronIpc();
    for (const target of ['file:///C:/Windows', 'javascript:alert(1)', 'https://user:pass@example.com']) { try { await ipc.invoke('browser:open-external', target); return false; } catch {} }
    return true;
  }));
  if (process.env.CALVRAS_BROWSER_TOOLS === '1') {
    const approvals = (async () => {
      for (const action of ['fill #query', 'click #apply', 'fill #query', 'click #apply']) {
        await page.waitForFunction(expected => document.querySelector('.composer-approval pre')?.textContent.startsWith(expected), action);
        const command = await page.locator('.composer-approval pre').innerText();
        if (!command.includes(fixtureUrl)) throw new Error('Refusing approval outside the local fixture');
        await page.locator('.approval-allow').click();
      }
    })();
    approvals.catch(() => {});
    const browser = await page.evaluate(async fixture => {
      const ipc = getElectronIpc();
      const context = { chatId: activeChatId, sources: [], userText: fixture, signal: new AbortController().signal };
      const guestId = await previewGuestId(context);
      const inspected = await performBrowserAction('inspect', '', context);
      await performBrowserAction('fill #query', 'Interstellar', context);
      await performBrowserAction('click #apply', '', context);
      const after = await performBrowserAction('inspect', '', context);
      await performBrowserAction('fill #query', '', context);
      await performBrowserAction('click #apply', '', context);
      await performBrowserAction('inspect', '', context);
      let secretBlocked = false, foreignBlocked = false;
      try { await performBrowserAction('fill #password', 'should-not-enter', context); } catch { secretBlocked = true; }
      try { await ipc.invoke('browser:inspect', { guestId: -1 }); } catch { foreignBlocked = true; }
      const capture = await ipc.invoke('browser:capture', { guestId });
      const diagnostics = await ipc.invoke('browser:diagnostics', { guestId });
      const same = await ipc.invoke('browser:compare', { referenceDataUrl: capture.dataUrl, actualDataUrl: capture.dataUrl });
      const reference = await executeAgentBlock({ kind: 'reference', arg: fixture + '/reference', body: '' }, {}, context);
      const summary = { referenceFailed: !!reference.node.failed, referenceText: reference.resultText, imageCount: reference.images?.length || 0, referenceCaptured: context.referenceInspected, referenceImage: reference.images?.[0]?.dataUrl };
      return { inspected, after, secretBlocked, foreignBlocked, captured: capture.dataUrl?.startsWith('data:image/'), diagnostics, same, interactionTested: context.interactionTested, summary };
    }, fixtureUrl);
    await approvals;
    check('browser inspection hides secret field values', !JSON.stringify(browser.inspected).includes('never-read-me'));
    check('browser fill/click changes real page state', JSON.stringify(browser.after).includes('Interstellar') && browser.interactionTested);
    check('browser blocks secret fields and foreign guests', browser.secretBlocked && browser.foreignBlocked);
    check('browser captures actual page image', browser.captured);
    check('reference returns actual design image', !browser.summary.referenceFailed && browser.summary.imageCount === 1 && browser.summary.referenceCaptured);
    if (browser.summary.referenceImage) await fs.writeFile(path.join(out, 'captured-reference.png'), Buffer.from(browser.summary.referenceImage.split(',')[1], 'base64'));
    delete browser.summary.referenceImage;
    check('identical screenshot comparison is exact', browser.same.exactMatch && browser.same.pixelMismatchRatio === 0);
    check('ordinary search controls expose selectors without values', browser.inspected.elements.some(element => element.role === 'input' && element.label === 'Search' && element.selector));
    const referenceEdges = await page.evaluate(async fixture => {
      const chat = chats.find(item => item.id === activeChatId);
      const resumed = getVisualBuildContext('continue', [], chat);
      const unrelated = getVisualBuildContext('explain a closure', [], chat);
      const newChat = getVisualBuildContext('continue', [], { messages: [] });
      const imageChat = { messages: [{ imageDataUrls: ['data:image/png;base64,fixture'] }] };
      getVisualBuildContext('build this image', ['data:image/png;base64,fixture'], imageChat);
      const imageResumed = getVisualBuildContext('make it closer', [], imageChat);
      const context = { chatId: activeChatId, sources: [], userText: fixture, signal: new AbortController().signal };
      const delayed = await executeAgentBlock({ kind: 'reference', arg: fixture + '/reference-delay', body: '' }, {}, context);
      const blank = await executeAgentBlock({ kind: 'reference', arg: fixture + '/blank', body: '' }, {}, context);
      const write = await executeAgentBlock({ kind: 'write', arg: 'must-not-exist.txt', body: 'blocked' }, {}, context);
      return { resumed: resumed.referenceRequired && resumed.referenceUrl === fixture + '/reference', isolated: !unrelated.referenceRequired && !newChat.referenceRequired,
        imageResumed: imageResumed.referenceImage === imageChat.messages[0].imageDataUrls[0] && imageResumed.referenceRequired,
        delayed: !delayed.node.failed && delayed.images?.length === 1,
        blank: blank.node.failed && !context.referenceInspected && !context.referenceImage && /HTTP 202/.test(blank.resultText), writeBlocked: write.node.failed };
    }, fixtureUrl);
    check('continuations reuse their actual reference but unrelated chats do not', referenceEdges.resumed && referenceEdges.isolated && referenceEdges.imageResumed);
    check('delayed rendered reference is awaited', referenceEdges.delayed);
    check('blank reference clears stale evidence and blocks writes', referenceEdges.blank && referenceEdges.writeBlocked);
    await fs.writeFile(path.join(out, 'browser-evidence.json'), JSON.stringify({ ...browser, referenceEdges }, (key, value) => /dataUrl/i.test(key) ? undefined : value, 2));
    await app.evaluate(({ shell }) => { globalThis.__externalOpened = []; shell.openExternal = async target => { globalThis.__externalOpened.push(target); }; });
    await page.evaluate(target => window.openLivePreview(target), fixtureUrl + '/?mode=test#details');
    await page.click('#preview-open-tab-btn');
    check('external control uses operating-system browser API with full URL', await app.evaluate(() => globalThis.__externalOpened[0]) === fixtureUrl + '/?mode=test#details');
  }
  if (process.env.CALVRAS_LIVE_REFERENCE === '1') {
    await app.evaluate(({ webContents }) => {
      globalThis.__referenceNavigation = [];
      for (const guest of webContents.getAllWebContents().filter(item => item.getType() === 'webview')) {
        for (const event of ['dom-ready', 'did-finish-load', 'did-stop-loading']) guest.on(event, () => globalThis.__referenceNavigation.push({ event, url: guest.getURL(), title: guest.getTitle(), loading: guest.isLoading(), time: Date.now() }));
        guest.on('did-navigate', (_event, url, httpResponseCode) => globalThis.__referenceNavigation.push({ event: 'did-navigate', url, httpResponseCode, time: Date.now() }));
      }
    });
    const live = await page.evaluate(async () => {
      const target = 'https://dribbble.com/shots/5629312-Odeum-Featured';
      const context = { chatId: activeChatId, sources: [], userText: target, signal: new AbortController().signal };
      const outcome = await executeAgentBlock({ kind: 'reference', arg: target, body: '' }, {}, context);
      if (outcome.node.failed) return { error: outcome.resultText };
      const result = await streamCompletion([{ role: 'user', content: buildToolResultsMessage(['Inspect only the reference image. What is the hero movie title, sidebar navigation, and three visible poster titles? Do not run tools or invent unreadable details.'], outcome.images) }]);
      return { content: result.content, reference: outcome.resultText, dataUrl: outcome.images[0].dataUrl };
    });
    if (live.error) {
      live.initialDocument = await page.evaluate(() => previewSiteView.executeJavaScript('({ readyState: document.readyState, title: document.title, children: document.body?.childElementCount, images: document.images.length, type: document.contentType })'));
      await page.waitForFunction(() => { try { return !!previewSiteView.getTitle(); } catch { return false; } }, null, { timeout: 15000 }).catch(() => {});
      live.laterInspection = await page.evaluate(async () => getElectronIpc().invoke('browser:inspect', { guestId: await previewGuestId() }));
      live.diagnostics = await page.evaluate(async () => getElectronIpc().invoke('browser:diagnostics', { guestId: await previewGuestId() }));
    }
    live.navigation = await app.evaluate(() => globalThis.__referenceNavigation);
    if (live.dataUrl) await fs.writeFile(path.join(out, 'live-odeum-reference.png'), Buffer.from(live.dataUrl.split(',')[1], 'base64'));
    delete live.dataUrl;
    check('real linked page reaches model as the correct Odeum design', /Interstellar/i.test(live.content || '') && /Red Sparrow|Moonlight|Captain Marvel/i.test(live.content || ''));
    await fs.writeFile(path.join(out, 'live-odeum-evidence.json'), JSON.stringify(live, null, 2));
  }
  if (process.env.CALVRAS_VISION_PROBE === '1') {
    const image = 'data:image/jpeg;base64,' + (await fs.readFile('.agents/artifacts/response-redesign/odeum-reference.jpg')).toString('base64');
    const vision = await page.evaluate(async data => {
      try {
        const result = await streamCompletion([{ role: 'user', content: [{ type: 'text', text: 'Describe the actual UI in this image: hero movie title, sidebar labels and three poster names. Do not invent invisible text.' }, { type: 'image_url', image_url: { url: data } }] }]);
        return { ok: true, content: result.content };
      } catch (error) { return { ok: false, error: error.message }; }
    }, image);
    await fs.writeFile(path.join(out, 'vision-probe.json'), JSON.stringify(vision, null, 2));
    console.log('VISION', JSON.stringify(vision));
  }
  check('no renderer errors', errors.length === 0);
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify({ checks, errors }, null, 2));
} finally {
  await app.close();
  await new Promise(resolve => server.close(resolve));
}
console.log(`${checks.filter(c => c.ok).length}/${checks.length} passed`);
if (checks.some(c => !c.ok)) process.exitCode = 1;
