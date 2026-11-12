import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-controls-'));
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-controls-work-'));
const out = path.resolve('.agents/artifacts/composer-controls');
await fs.mkdir(out, { recursive: true });
const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><button id="action" onclick="this.textContent=\'Confirmed\'">Submit test</button>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['main.cjs', '--user-data-dir=' + profile], env, timeout: 60000 });
const checks = [];
function check(name, ok) { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve('app.html')).href);
  await page.waitForSelector('#prompt-input');
  await page.evaluate(async folder => {
    await getElectronIpc().invoke('workspace:set-folder', folder);
    activeWorkspaceDir = folder;
    activeChatId = 'controls';
    chats.push({ id: activeChatId, title: 'Controls', messages: [] });
    showConversationView('Controls');
    const row = document.createElement('div');
    row.className = 'message-row assistant';
    row.innerHTML = formatMarkdown('```js\nconst result = 42;\n```\n\n    indented code', 'test-code');
    messagesContainer.appendChild(row);
  }, workspace);
  check('composer Tools buttons removed', await page.locator('#home-tools-btn, #capsule-tools-btn').count() === 0);
  check('fenced and indented code use plain blocks', await page.locator('div.code-block-container').count() === 2);
  check('code is always visible', await page.locator('div.code-block-container pre').first().isVisible());
  check('stream update preserves code', await page.evaluate(() => {
    const row = messagesContainer.querySelector('.message-row.assistant');
    const template = document.createElement('template');
    template.innerHTML = formatMarkdown('```js\nconst result = 43;\n```\n\n    indented code', 'test-code');
    reconcileMarkdownChildren(row, template.content);
    return row.querySelector('code').textContent.includes('43');
  }));
  check('project menu matches approval surface', await page.evaluate(() => {
    const a = getComputedStyle(document.getElementById('folder-mode-popover'));
    const b = getComputedStyle(document.getElementById('capsule-mode-menu'));
    return a.backgroundColor === b.backgroundColor && a.borderRadius === b.borderRadius && a.padding === b.padding && a.width === b.width;
  }));
  await page.evaluate(() => {
    window.commandResult = null;
    getElectronIpc().invoke('workspace:exec', { command: "Set-Content approval.txt 'allowed'" }).then(result => window.commandResult = result).catch(error => window.commandResult = { error: error.message });
  });
  await page.waitForFunction(() => document.querySelector('.composer-approval pre')?.textContent === "Set-Content approval.txt 'allowed'");
  check('approval sits above input', await page.evaluate(() => {
    const a = document.querySelector('.composer-approval');
    return a.parentElement.classList.contains('capsule-input-container') && a.getBoundingClientRect().bottom <= capsuleBar.getBoundingClientRect().top;
  }));
  check('pending command has not run', await fs.stat(path.join(workspace, 'approval.txt')).then(() => false, () => true));
  await page.screenshot({ path: path.join(out, 'approval.png') });
  await page.locator('.approval-allow').click();
  await page.waitForFunction(() => window.commandResult !== null);
  check('allow executes the exact command', await fs.readFile(path.join(workspace, 'approval.txt'), 'utf8').then(text => text.trim() === 'allowed'));
  await page.evaluate(() => {
    window.commandResult = null;
    getElectronIpc().invoke('workspace:exec', { command: "Set-Content denied.txt 'no'" }).then(result => window.commandResult = result).catch(error => window.commandResult = { error: error.message });
  });
  await page.waitForSelector('.composer-approval');
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await page.waitForFunction(() => window.commandResult !== null);
  check('denied command never runs', await fs.stat(path.join(workspace, 'denied.txt')).then(() => false, () => true));
  await page.locator('#capsule-mode-btn').click();
  await page.locator('#capsule-mode-menu [data-mode="Default"]').click();
  check('Approve for me reaches main process', await page.evaluate(async () => await getElectronIpc().invoke('approval:mode') === 'Default'));
  const safe = await page.evaluate(() => getElectronIpc().invoke('workspace:exec', { command: 'pwd' }));
  check('safe command auto-runs', safe.success && await page.locator('.composer-approval').count() === 0);
  await page.evaluate(() => {
    window.commandResult = null;
    getElectronIpc().invoke('workspace:exec', { command: 'node -e "process.stdout.write(\'test\')"' }).then(result => window.commandResult = result).catch(error => window.commandResult = { error: error.message });
  });
  await page.waitForSelector('.composer-approval');
  check('unclassified command still asks in Approve for me', await page.locator('.composer-approval').isVisible());
  await page.evaluate(() => getElectronIpc().invoke('agent:cancel'));
  await page.waitForFunction(() => window.commandResult !== null);
  check('cancel resolves pending approval without execution', await page.evaluate(() => Boolean(window.commandResult.error) && approvalRequests.size === 0));
  await page.locator('#capsule-mode-btn').click();
  await page.locator('#capsule-mode-menu [data-mode="Turbo"]').click();
  const full = await page.evaluate(() => getElectronIpc().invoke('workspace:exec', { command: "Set-Content full.txt 'yes'" }));
  check('Full access runs ordinary local command', full.success && await fs.readFile(path.join(workspace, 'full.txt'), 'utf8').then(t => t.trim() === 'yes'));
  const fullDestructive = await page.evaluate(() => getElectronIpc().invoke('workspace:exec', { command: 'Remove-Item full.txt' }));
  const fullDestructiveGone = await fs.stat(path.join(workspace, 'full.txt')).then(() => false, () => true);
  check('Full access runs destructive commands without asking', fullDestructive.success && fullDestructiveGone && await page.evaluate(() => approvalRequests.size === 0));
  const fullExternal = await page.evaluate(() => getElectronIpc().invoke('workspace:exec', { command: "Write-Output 'publish'" }));
  check('Full access runs external-classified commands without asking', fullExternal.success && fullExternal.stdout.trim() === 'publish' && await page.evaluate(() => approvalRequests.size === 0));
  await page.locator('#capsule-mode-btn').click();
  await page.locator('#capsule-mode-menu [data-mode="Request Review"]').click();
  await page.evaluate(() => {
    window.commandResult = null;
    getElectronIpc().invoke('workspace:exec', { command: 'Remove-Item approval.txt' }).then(result => window.commandResult = result).catch(error => window.commandResult = { error: error.message });
  });
  await page.waitForSelector('.approval-allow');
  await page.locator('.approval-allow').click();
  check('brief click cannot allow destructive command', await page.evaluate(() => window.commandResult === null));
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await page.waitForFunction(() => window.commandResult !== null);
  check('GitHub IPC returns disconnected without implicit login', await page.evaluate(async () => { const s = await getElectronIpc().invoke('github:status'); return s.connected === false && !s.error; }));
  check('plan prompt limits plans to substantial work', await page.evaluate(() => { const prompt = buildAgentSystemPrompt([]); return prompt.includes('Only for substantial builds') && prompt.includes('never a fixed count'); }));
  check('official website appears in identity', await page.evaluate(() => ASSISTANT_IDENTITY.includes('https://calvras.com')));
  const recovered = await page.evaluate(async () => {
    const original = streamCompletion;
    let attempts = 0;
    streamCompletion = async () => ({ content: ++attempts < 3 ? '' : 'The answer is 42.' });
    try { await handleSend('What is six times seven?'); return { attempts, content: chats.find(c => c.id === activeChatId).messages.at(-1).content }; }
    finally { streamCompletion = original; }
  });
  check('empty responses recover before completion', recovered.attempts === 3 && recovered.content === 'The answer is 42.');
  const empty = await page.evaluate(async () => {
    const original = streamCompletion;
    let attempts = 0;
    streamCompletion = async () => { attempts += 1; return { content: '' }; };
    try { await handleSend('Explain the number seven.'); return { attempts, text: messagesContainer.textContent }; }
    finally { streamCompletion = original; }
  });
  check('persistent provider failure stops honestly without old error', empty.attempts === 4 && empty.text.includes('three recovery attempts') && !empty.text.includes('The model returned no final message.'));
  await page.evaluate(async url => { window.openLivePreview(url); await previewGuestId(); }, `http://127.0.0.1:${server.address().port}`);
  await page.evaluate(() => {
    window.browserResult = null;
    performBrowserAction('click #action', '').then(result => window.browserResult = result).catch(error => window.browserResult = { error: error.message });
  });
  await page.waitForSelector('.composer-approval');
  check('browser mutation asks above composer in approval mode', await page.locator('.approval-heading').textContent() === 'Allow browser action?' && await page.evaluate(() => window.browserResult === null));
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await page.waitForFunction(() => window.browserResult !== null);
  check('denied browser click does not submit', await page.evaluate(async () => (await performBrowserAction('inspect', '')).elements.some(item => item.text === 'Submit test')));
  await page.evaluate(() => {
    window.browserResult = null;
    performBrowserAction('click #action', '').then(result => window.browserResult = result).catch(error => window.browserResult = { error: error.message });
  });
  await page.waitForSelector('.composer-approval');
  await page.locator('.approval-allow').click();
  await page.waitForFunction(() => window.browserResult !== null);
  check('approved browser click dispatches exactly after consent', await page.evaluate(async () => (await performBrowserAction('inspect', '')).elements.some(item => item.text === 'Confirmed')));
  await page.locator('#capsule-mode-btn').click();
  await page.locator('#capsule-mode-menu [data-mode="Turbo"]').click();
  await page.evaluate(async url => { window.openLivePreview(url); await previewGuestId(); }, `http://127.0.0.1:${server.address().port}`);
  await page.evaluate(() => performBrowserAction('click #action', ''));
  check('Full access dispatches browser actions without asking', await page.evaluate(() => approvalRequests.size === 0) && await page.evaluate(async () => (await performBrowserAction('inspect', '')).elements.some(item => item.text === 'Confirmed')));
  check('no renderer errors', errors.length === 0);
  if (errors.length) console.log(errors);
} finally {
  await app.close();
  await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2));
  console.log(`${checks.filter(c => c.ok).length}/${checks.length} passed`);
  if (checks.some(c => !c.ok)) process.exitCode = 1;
}
