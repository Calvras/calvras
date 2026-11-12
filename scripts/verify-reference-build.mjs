import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

// Real-provider, real-chat integration test. Never import provider settings or keys.
// All persistent and temporary test writes remain under the authorized artifact root.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(root, '.agents/artifacts/reference-build');
await fs.mkdir(artifactRoot, { recursive: true });
const out = await fs.mkdtemp(path.join(artifactRoot, 'run-'));
const profile = path.join(out, 'profile');
const workspace = path.join(out, 'workspace');
const temp = path.join(out, 'temp');
await Promise.all([profile, workspace, temp].map(dir => fs.mkdir(dir)));
const maxCalls = 14;
const deadlineMs = 420000;
const checks = [];
const events = [];
const errors = [];
const check = (name, ok, evidence) => {
  checks.push({ name, ok: !!ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
};
const clean = value => String(value).replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]');
const json = (name, value) => fs.writeFile(path.join(out, name), clean(JSON.stringify(value, null, 2)));
const hashSources = async () => Object.fromEntries(await Promise.all(['app.js', 'main.cjs'].map(async name => [name, crypto.createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex')])));
const sourceBefore = await hashSources();
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Library desk — original reference</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f5f2;color:#24352a;font:14px Arial,sans-serif}.card{width:360px;max-width:calc(100% - 32px);margin:40px auto;background:#fff;border:1px solid #dce3dc;border-radius:16px;padding:24px}.eyebrow{font-size:10px;letter-spacing:2px;font-weight:700;color:#55705c;margin:0 0 10px}h1{font-size:28px;line-height:34px;margin:0 0 8px;letter-spacing:-.7px}.subtitle{color:#68766b;margin:0 0 22px;line-height:20px}form{display:flex;gap:8px;margin-bottom:20px}input{min-width:0;flex:1;width:180px;height:40px;border:1px solid #cbd5cd;border-radius:8px;padding:0 11px;font:14px Arial;background:#fff;color:#24352a}button{height:40px;border:0;border-radius:8px;padding:0 16px;background:#2d6444;color:white;font:bold 14px Arial;cursor:pointer}.book{background:#f3f5f2;border-radius:8px;padding:14px;margin-top:10px}.book strong{display:block;font-size:15px;margin-bottom:5px}.book span{font-size:12px;color:#68766b}#status{margin:18px 0 0;font-size:12px;color:#55705c;line-height:18px}
</style></head><body><main class="card"><p class="eyebrow">A LITTLE READING ROOM</p><h1>Library desk</h1><p class="subtitle">Find a good book for a quiet afternoon.</p><form><input id="query" aria-label="Search titles" placeholder="Search titles"><button type="submit">Filter</button></form><section aria-label="Books"><article class="book" data-title="Moss Almanac"><strong>Moss Almanac</strong><span>Field notes · 2024</span></article><article class="book" data-title="Amber Atlas"><strong>Amber Atlas</strong><span>Travel guide · 2023</span></article></section><p id="status" role="status">2 books available</p></main><script>
document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();const query=document.querySelector('input').value.trim().toLowerCase();let count=0;document.querySelectorAll('.book').forEach(book=>{book.hidden=!!query&&!book.dataset.title.toLowerCase().includes(query);if(!book.hidden)count++});document.querySelector('#status').textContent=!query?'Enter a title to filter.':count===1?'1 matching title':count+' matching titles';});
</script></body></html>`;
await fs.writeFile(path.join(out, 'reference-fixture.html'), fixture);
const requests = [];
const server = http.createServer((req, res) => {
  requests.push({ time: Date.now(), path: req.url });
  if (req.url?.startsWith('/favicon')) { res.writeHead(204); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(fixture);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const referenceUrl = `http://127.0.0.1:${server.address().port}/reference`;
const prompt = `Duplicate this original public local reference page: ${referenceUrl} . Build only one self-contained index.html in the selected workspace (plain HTML/CSS/JS explicitly; no React, installs, shell commands, git, or external assets). Inspect the actual reference first and match its exact text, colors, typography, spacing and card layout. Do not fetch the URL or source markup: use the rendered reference capture. The screenshot privacy mask may hide this public form; it contains one input with placeholder Search titles and a green Filter button, not a black rectangle. Make Filter search the two book titles case-insensitively. Main check: search Moss, click Filter, show only Moss Almanac and "1 matching title". Empty-input check: clear input, click Filter, show both books and "Enter a title to filter." Open your actual build with preview:index.html (the app already serves it), do both interaction/action+inspect checks, run diagnostics and compare the real screenshots before finishing. Use id search for the input so the empty-fill selector #search has no spaces. Keep this tiny: at most 8 model rounds. Batch sequential tool blocks in each reply: fill, click, inspect, empty fill, click, inspect, diagnostics, compare can execute in order without a separate model reply per action. Each code fence must start and end on its own line. Do not claim visual match from a pixel score; report any differences or blocker honestly.`;
await fs.writeFile(path.join(out, 'prompt.txt'), prompt);
let app;
let page;
let timer;
let queue = Promise.resolve();
let capped = false;
let endState;
const saveImage = async (name, dataUrl) => {
  if (!dataUrl?.startsWith('data:image/')) return;
  await fs.writeFile(path.join(out, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
};
try {
  const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'main.cjs'), '--user-data-dir=' + profile], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(clean(error.message)));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  await page.goto(pathToFileURL(path.join(root, 'app.html')).href);
  await page.waitForSelector('#prompt-input');
  const isolated = await app.evaluate(({ app }) => app.getPath('userData'));
  check('isolated Electron profile', path.resolve(isolated).toLowerCase() === profile.toLowerCase(), isolated);
  await page.evaluate(async folder => { await getElectronIpc().invoke('workspace:set-folder', folder); await refreshWorkspaceInfo(); }, workspace);
  const selected = await page.evaluate(() => activeWorkspaceDir);
  check('isolated selected workspace', selected === workspace, selected);

  // This is a real fixture screenshot for independent review, not injected model evidence.
  const referenceShot = await app.evaluate(async ({ BrowserWindow }, url) => {
    const window = new BrowserWindow({ width: 600, height: 720, useContentSize: true, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try { await window.loadURL(url); await window.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))'); return (await window.webContents.capturePage()).toDataURL(); }
    finally { window.destroy(); }
  }, referenceUrl);
  await saveImage('reference-independent.png', referenceShot);
  await page.exposeFunction('__recordReferenceBuild', event => {
    queue = queue.then(async () => {
      const id = events.length + 1;
      if (event.images) {
        const imageFiles = [];
        for (let i = 0; i < event.images.length; i++) {
          const image = event.images[i];
          const filename = `tool-${String(id).padStart(3, '0')}-${event.kind}-${i}.png`;
          await saveImage(filename, image.dataUrl);
          imageFiles.push({ label: image.label, file: filename });
        }
        event.images = imageFiles;
      }
      events.push({ id, ...event });
      await json('events.json', events);
      console.log(`TRACE ${id} ${event.type} ${event.kind || ''} ${event.arg || ''} ${event.failed ? 'FAILED' : ''}`);
    });
    return queue;
  });
  await page.evaluate(({ maxCalls, workspace }) => {
    const record = event => window.__recordReferenceBuild({ time: Date.now(), ...event });
    const realStream = streamCompletion;
    const realExecute = executeAgentBlock;
    window.__referenceBuildCalls = 0;
    window.__referenceBuildContext = null;
    const state = context => context ? Object.fromEntries(['visualBuild', 'referenceRequired', 'referenceInspected', 'referenceUrl', 'changedFiles', 'compared', 'diagnosed', 'interactionTested', 'interactionActions', 'interactionChecks', 'verificationReminders'].map(key => [key, context[key]])) : null;
    streamCompletion = async function(messages, options) {
      const call = ++window.__referenceBuildCalls;
      if (call > maxCalls) { await record({ type: 'cap', call }); stopGeneration(); throw new DOMException('Harness model-call cap reached.', 'AbortError'); }
      await record({ type: 'model-start', call, messageCount: messages.length, imageCount: messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url').length : 0), 0), gateReminders: messages.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Completion is not verified.')).map(m => m.content), state: state(window.__referenceBuildContext) });
      try {
        const result = await realStream.call(this, messages, options);
        await record({ type: 'model-end', call, content: result.content, state: state(window.__referenceBuildContext) });
        return result;
      } catch (error) { await record({ type: 'model-error', call, error: error.message, errorName: error.name }); throw error; }
    };
    executeAgentBlock = async function(block, handle, context) {
      window.__referenceBuildContext = context;
      await record({ type: 'tool-start', kind: block.kind, arg: block.arg, body: block.body, state: state(context) });
      // Deny only out-of-scope operations; never manufacture successful tool output.
      const allowed = ['reference', 'diagnostics', 'compare', 'preview', 'preview_close', 'browser', 'plan', 'tasks', 'write', 'edit', 'replace', 'read', 'list'];
      const fileTool = ['write', 'edit', 'replace', 'read'].includes(block.kind);
      const unsafePath = fileTool && (/(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[a-z]:/i.test(block.arg) || /(?:config|credential|\.env)/i.test(block.arg));
      if (!allowed.includes(block.kind) || unsafePath) {
        await record({ type: 'scope-denied', kind: block.kind, arg: block.arg });
        stopGeneration();
        throw new Error('Harness scope stops this operation. Only the isolated HTML fixture build is authorized.');
      }
      const outcome = await realExecute.call(this, block, handle, context);
      await record({ type: 'tool-end', kind: block.kind, arg: block.arg, failed: !!outcome.node?.failed, node: outcome.node, result: outcome.resultText, images: outcome.images, state: state(context), previewUrl: livePreviewUrl });
      return outcome;
    };
    window.__referenceBuildState = () => state(window.__referenceBuildContext);
  }, { maxCalls, workspace });
  timer = setTimeout(() => { capped = true; page.evaluate(() => stopGeneration()).catch(() => {}); }, deadlineMs);
  await page.locator('#prompt-input').fill(prompt);
  await page.locator('#send-btn').click();
  await page.waitForFunction(() => window.__referenceBuildCalls > 0 || isGenerating, null, { timeout: 30000 });
  await page.waitForFunction(() => !isGenerating, null, { timeout: deadlineMs + 30000 });
  clearTimeout(timer);
  await queue;
  endState = await page.evaluate(() => ({ calls: window.__referenceBuildCalls, state: window.__referenceBuildState(), previewUrl: livePreviewUrl, chat: chats.find(chat => chat.id === activeChatId)?.messages.map(message => ({ role: message.role, content: message.content, stopped: message.stopped, trace: message.trace?.map(({ thought, ...phase }) => phase) })) }));
  await json('chat-result.json', endState);
  await page.screenshot({ path: path.join(out, 'app-final.png') });
  await fs.writeFile(path.join(out, 'conversation.txt'), clean(await page.locator('#messages-container').innerText().catch(() => page.locator('body').innerText())));
  check('actual chat called established provider', events.some(e => e.type === 'model-start'), { calls: endState.calls });
  check('provider completed a streamed response', events.some(e => e.type === 'model-end'), events.filter(e => e.type === 'model-error'));
  check('automatic linked reference captured actual rendered page', events.some(e => e.type === 'tool-end' && e.kind === 'reference' && !e.failed && e.images?.length), events.filter(e => e.type === 'tool-end' && e.kind === 'reference').map(({ result, images }) => ({ result, images })));
  const built = await fs.stat(path.join(workspace, 'index.html')).catch(() => null);
  check('model wrote index.html', !!built?.size, { bytes: built?.size || 0 });
  check('model performed two action-inspect rounds after writes', endState.state?.interactionTested && endState.state?.interactionChecks >= 2, endState.state);
  check('model ran local diagnostics and image comparison after writes', endState.state?.diagnosed && endState.state?.compared, endState.state);
  check('model completed without cap/backend error', !capped && !events.some(e => ['model-error', 'cap', 'scope-denied'].includes(e.type)) && !endState.chat?.at(-1)?.stopped, { capped, stopped: endState.chat?.at(-1)?.stopped });

  if (built?.size) {
    // Independent post-turn QA: does not affect the model's completion-gate state.
    await page.evaluate(() => { window.openLivePreview('index.html'); previewSiteView.reload(); });
    await page.waitForFunction(async () => {
      if (!previewSiteView || previewSiteView.isLoading() || previewSiteView.dataset.ready !== 'true') return false;
      try { return await previewSiteView.executeJavaScript('document.body.innerText.includes("2 books available")'); } catch { return false; }
    }, null, { timeout: 30000 });
    await page.waitForFunction(() => {
      const rect = previewSiteView.getBoundingClientRect();
      const key = `${rect.width}:${rect.height}`;
      window.__fixtureStable = window.__fixtureSize === key ? (window.__fixtureStable || 0) + 1 : 0;
      window.__fixtureSize = key;
      return window.__fixtureStable >= 12;
    });
    const capture = async name => {
      const guestId = await page.evaluate(() => previewGuestId());
      // Unredacted independent screenshot of this controlled credential-free fixture only.
      // Model tool screenshots above remain exactly as supplied by the real app.
      const shot = await app.evaluate(async ({ webContents }, id) => {
        const guest = webContents.fromId(id);
        const image = await guest.capturePage();
        return { dataUrl: image.toDataURL(), ...image.getSize() };
      }, guestId);
      await saveImage(name, shot.dataUrl);
      return { width: shot.width, height: shot.height };
    };
    const inspect = () => page.evaluate(async () => getElectronIpc().invoke('browser:inspect', { guestId: await previewGuestId() }));
    const independent = { initial: await inspect(), viewport: await capture('build-initial.png') };
    const guestLayout = await page.evaluate(async () => previewSiteView.executeJavaScript(`(()=>({width:innerWidth,height:innerHeight,text:document.body.innerText,background:getComputedStyle(document.body).backgroundColor,inputCount:document.querySelectorAll('input').length,buttons:[...document.querySelectorAll('button')].map(b=>b.innerText)}))()`));
    independent.layout = guestLayout;
    const matchedReference = await app.evaluate(async ({ BrowserWindow }, data) => {
      const window = new BrowserWindow({ width: data.width, height: data.height, useContentSize: true, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try {
        await window.loadURL(data.url);
        await window.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
        const initial = (await window.webContents.capturePage()).toDataURL();
        const mainText = await window.webContents.executeJavaScript(`document.querySelector('input').value='Moss';document.querySelector('button').click();document.body.innerText`);
        const main = (await window.webContents.capturePage()).toDataURL();
        const emptyText = await window.webContents.executeJavaScript(`document.querySelector('input').value='';document.querySelector('button').click();document.body.innerText`);
        const empty = (await window.webContents.capturePage()).toDataURL();
        return { initial, main, empty, mainText, emptyText };
      } finally { window.destroy(); }
    }, { url: referenceUrl, width: guestLayout.width, height: guestLayout.height });
    await saveImage('reference-matched-viewport.png', matchedReference.initial);
    await saveImage('reference-main.png', matchedReference.main);
    await saveImage('reference-empty.png', matchedReference.empty);
    independent.reference = { mainText: matchedReference.mainText, emptyText: matchedReference.emptyText };
    independent.main = await page.evaluate(async () => {
      const ipc = getElectronIpc(), guestId = await previewGuestId();
      await ipc.invoke('browser:action', { guestId, action: 'fill', selector: 'input', text: 'Moss', value: 'Moss' });
      await ipc.invoke('browser:action', { guestId, action: 'click', selector: 'button' });
      return ipc.invoke('browser:inspect', { guestId });
    });
    await capture('build-main.png');
    const mainText = independent.main.visibleText || '';
    check('independent main: Moss result, Amber hidden, exact status', mainText.includes('Moss Almanac') && !mainText.includes('Amber Atlas') && mainText.includes('1 matching title'), mainText);
    independent.empty = await page.evaluate(async () => {
      const ipc = getElectronIpc(), guestId = await previewGuestId();
      await ipc.invoke('browser:action', { guestId, action: 'fill', selector: 'input', text: '', value: '' });
      await ipc.invoke('browser:action', { guestId, action: 'click', selector: 'button' });
      return ipc.invoke('browser:inspect', { guestId });
    });
    await capture('build-empty.png');
    const emptyText = independent.empty.visibleText || '';
    check('independent empty: both books and exact validation message', emptyText.includes('Moss Almanac') && emptyText.includes('Amber Atlas') && emptyText.includes('Enter a title to filter.'), emptyText);
    independent.diagnostics = await page.evaluate(async () => getElectronIpc().invoke('browser:diagnostics', { guestId: await previewGuestId() }));
    const consoleErrors = (independent.diagnostics.console || []).filter(event => event.level === 'error');
    const networkErrors = (independent.diagnostics.network || []).filter(event => !event.cancelled);
    check('independent diagnostics: no console errors or uncancelled network failures', !consoleErrors.length && !networkErrors.length, { consoleErrors, networkErrors, warnings: independent.diagnostics.console?.length || 0, tracking: independent.diagnostics.tracking });
    await json('independent-qa.json', independent);
  }
} catch (error) {
  errors.push(clean(error.stack || error.message));
  check('harness completed evidence collection', false, clean(error.message));
  if (page) {
    await page.evaluate(() => stopGeneration()).catch(() => {});
    await page.screenshot({ path: path.join(out, 'app-failure.png') }).catch(() => {});
  }
} finally {
  clearTimeout(timer);
  await queue;
  await json('checks.json', { checks, errors, capped, referenceUrl, workspace, profile, sourceBefore, sourceAfter: await hashSources(), note: 'No application sources/configs edited. Model output and real tools observed through pass-through wrappers; out-of-scope operations are stopped. Independent QA is separate from the model gate. No visual match is inferred from metrics.' });
  await json('fixture-requests.json', requests);
  if (app) await app.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  // Discard browser profile/cache so no incidental credentials/cookies are retained.
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
console.log(`ARTIFACTS ${out}`);
console.log(`${checks.filter(c => c.ok).length}/${checks.length} checks passed; screenshots require visual review.`);
if (checks.some(c => !c.ok)) process.exitCode = 1;
