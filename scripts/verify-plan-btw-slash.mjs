import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-plan-btw-'));
const out = path.resolve('.agents/artifacts/plan-btw-slash');
await fs.mkdir(out, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['main.cjs', '--user-data-dir=' + profile], env, timeout: 60000 });
const checks = [];
const check = (name, result) => { assert(result, name); checks.push(name); console.log('PASS ' + name); };
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve('app.html')).href);
  await page.waitForSelector('#prompt-input');

  // ---- Slash menu: three commands, each with a description ----
  await page.locator('#prompt-input').click();
  await page.locator('#prompt-input').fill('/');
  const menu = page.locator('#prompt-input-commands');
  await menu.waitFor({ state: 'visible' });
  check('slash menu lists Show pet / Plan mode / BTW chat', await menu.locator('button:visible').count() === 3
    && await menu.locator('#prompt-input-commands-pet .slash-label').textContent() === 'Show pet'
    && await menu.locator('#prompt-input-commands-plan .slash-label').textContent() === 'Plan mode'
    && await menu.locator('#prompt-input-commands-btw .slash-label').textContent() === 'BTW chat');
  check('every command carries a description', await menu.locator('button:visible .slash-desc').count() === 3
    && (await menu.locator('#prompt-input-commands-plan .slash-desc').textContent()).length > 20);
  await page.locator('#prompt-input').fill('/p');
  check('typing /p filters to Plan mode only', await menu.locator('button:visible').count() === 1 && await menu.locator('#prompt-input-commands-plan').isVisible());
  await page.locator('#prompt-input').fill('/btw');
  check('typing /btw filters to BTW chat only', await menu.locator('button:visible').count() === 1 && await menu.locator('#prompt-input-commands-btw').isVisible());
  await page.locator('#prompt-input').fill('/');
  await page.locator('#prompt-input').press('ArrowDown');
  check('ArrowDown moves the active option', await page.locator('#prompt-input').getAttribute('aria-activedescendant') === 'prompt-input-commands-plan');
  await page.locator('#prompt-input').press('ArrowUp');
  check('ArrowUp wraps back to the first option', await page.locator('#prompt-input').getAttribute('aria-activedescendant') === 'prompt-input-commands-pet');
  await page.locator('#prompt-input').press('Escape');
  check('Escape hides the slash menu', !await menu.isVisible());

  // ---- Plan mode arming chip ----
  await page.locator('#prompt-input').fill('/plan');
  await page.locator('#prompt-input').press('Enter');
  check('Plan mode arms from the slash menu without sending a message', await page.evaluate(() => planModeArmed === true && chats.length === 0) && await page.locator('#prompt-input').inputValue() === '');
  check('armed plan mode shows a composer chip', await page.locator('.antigravity-chat-card .composer-plan-chip').isVisible());
  await page.locator('.antigravity-chat-card .composer-plan-chip button').click();
  check('chip dismiss disarms plan mode', await page.evaluate(() => planModeArmed === false));

  // ---- Code snippet radius +5px and no step cap ----
  check('code snippet border radius is 11px (6 + 5)', await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML = formatMarkdown('```js\nconst a = 1;\n```');
    document.body.append(host);
    const radius = getComputedStyle(host.querySelector('.code-block-container')).borderRadius;
    host.remove();
    return radius === '11px';
  }));
  check('the 40-step cap is gone from the agent engine', await page.evaluate(() => typeof MAX_AGENT_STEPS === 'undefined'));

  // ---- Stub the provider so the full plan gate runs without network ----
  await page.evaluate(() => {
    window.__calls = [];
    window.streamCompletion = async (messages, opts = {}) => {
      const sys = String(messages[0]?.content || '');
      const kind = sys.includes('PLAN MODE') ? 'plan' : sys.includes('BTW chat') ? 'btw' : sys.includes('CONFIRMED IMPLEMENTATION PLAN') ? 'build-with-plan' : 'other';
      const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
      window.__calls.push({ kind, lastUser });
      const text = kind === 'plan'
        ? '# Todo app plan\n\n## Overview\nBuild a todo app.\n\n## Architecture\nClient → API → SQLite.\n\n## Implementation steps\n1. Scaffold the project.'
        : kind === 'btw' ? 'Roughly two more minutes — that is an estimate based on the current progress.'
        : 'Built and verified.';
      opts.onContent?.(text);
      return { content: text, reasoning: '' };
    };
  });

  // ---- Plan gate: draft → preview document → revise → confirm → binding build ----
  await page.evaluate(() => setPlanModeArmed(true));
  await page.locator('#prompt-input').fill('Build a todo app');
  await page.locator('#send-btn').click();
  await page.waitForSelector('#preview-panel.plan-mode #preview-plan-view:not([hidden])');
  check('plan opens as a document in the right preview', await page.locator('.plan-doc h1').textContent() === 'Todo app plan' && await page.locator('#preview-panel').evaluate(el => el.classList.contains('open')));
  check('confirm bar offers Confirm / Revise / Cancel', await page.locator('#plan-confirm-btn').isVisible() && await page.locator('#plan-revise-btn').isVisible() && await page.locator('#plan-cancel-btn').isVisible());
  check('plan is stored on the chat while awaiting confirmation', await page.evaluate(() => Boolean(chats[0].pendingPlan?.markdown.includes('Todo app plan'))));
  const messagesBefore = await page.evaluate(() => chats[0].messages.length);
  await page.evaluate(() => handleSend('interrupting message'));
  check('new sends are blocked while a plan awaits confirmation', await page.evaluate(() => chats[0].messages.length) === messagesBefore);
  await page.screenshot({ path: path.join(out, 'plan-preview.png') });
  await page.locator('#plan-revise-btn').click();
  check('Revise reveals a feedback box', await page.locator('.plan-feedback').isVisible());
  await page.locator('.plan-feedback').fill('Add dark mode support');
  await page.locator('#plan-revise-btn').click();
  await page.waitForFunction(() => window.__calls.filter(c => c.kind === 'plan').length >= 2);
  check('revision feedback reaches the planner', await page.evaluate(() => window.__calls.filter(c => c.kind === 'plan').at(-1).lastUser.includes('Add dark mode support')));
  await page.waitForSelector('#plan-confirm-btn');
  await page.locator('#plan-confirm-btn').click();
  await page.waitForFunction(() => !document.getElementById('preview-panel').classList.contains('plan-mode'));
  await page.waitForFunction(() => chats[0]?.messages.some(m => m.content === 'Built and verified.'));
  check('confirming binds the plan into the build prompt', await page.evaluate(() => window.__calls.some(c => c.kind === 'build-with-plan' && c.lastUser !== undefined) && chats[0].confirmedPlan.includes('Todo app plan') && !chats[0].pendingPlan));
  check('confirmed plan is injected as binding system context', await page.evaluate(() => window.__calls.some(c => c.kind === 'build-with-plan')));
  check('build completes after confirmation', await page.evaluate(() => chats[0].messages.at(-1).content === 'Built and verified.'));

  // ---- History keeps a reopenable plan document ----
  await page.evaluate(() => loadChatById(chats[0].id));
  check('history offers Open plan document', await page.locator('.plan-open-btn').count() >= 1);
  await page.locator('.plan-open-btn').first().click();
  await page.waitForSelector('#preview-panel.plan-mode #preview-plan-view:not([hidden])', { state: 'visible' });
  check('reopened plan is read-only (no confirm bar)', await page.locator('#plan-confirm-btn').count() === 0);
  await page.evaluate(() => window.closeLivePreview());

  // ---- Plan cancel path ----
  const callsBeforeCancel = await page.evaluate(() => window.__calls.length);
  await page.evaluate(() => { setPlanModeArmed(true); });
  await page.locator('#capsule-prompt-input').fill('Build a second app');
  await page.locator('#capsule-prompt-input').press('Enter');
  await page.waitForSelector('#plan-cancel-btn');
  await page.locator('#plan-cancel-btn').click();
  await page.waitForFunction(() => chats[0]?.messages.some(m => m.content === 'Plan cancelled — nothing was built.'));
  check('Cancel stops before any building and clears the pending plan', await page.evaluate(before => !chats[0].pendingPlan && !window.__calls.slice(before).some(c => c.kind === 'build-with-plan'), callsBeforeCancel));

  // ---- BTW chat: ephemeral, live status, model answers ----
  await page.locator('#capsule-prompt-input').fill('/btw');
  await page.locator('#capsule-prompt-input').press('Enter');
  await page.waitForSelector('#btw-chat-panel:not([hidden])');
  check('BTW chat opens from the slash menu', await page.locator('#btw-chat-panel').isVisible() && await page.locator('.btw-hint').isVisible());
  check('BTW status reflects the real idle state', (await page.locator('#btw-status').textContent()).includes('Idle'));
  await page.locator('#btw-input').fill('how long will it take to finish?');
  await page.locator('#btw-input').press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#btw-messages .btw-bubble.assistant').length === 1);
  check('BTW question gets a model answer from live status', (await page.locator('#btw-messages .btw-bubble.assistant').textContent()).includes('estimate'));
  check('BTW calls carry the live-status system prompt', await page.evaluate(() => window.__calls.some(c => c.kind === 'btw')));
  await page.evaluate(() => { setGeneratingState(true); updatePetActivity('Writing files…'); });
  await page.waitForFunction(() => document.getElementById('btw-status').textContent.includes('Working'));
  check('BTW status tracks the agent while it works', (await page.locator('#btw-status').textContent()).includes('Writing files…'));
  await page.screenshot({ path: path.join(out, 'btw-chat.png') });
  await page.evaluate(() => setGeneratingState(false));
  await page.locator('#btw-close-btn').click();
  check('closing BTW chat hides the panel', !await page.locator('#btw-chat-panel').isVisible());
  await page.evaluate(() => openBtwChat());
  check('reopening BTW chat starts fresh (nothing saved)', await page.locator('#btw-messages .btw-bubble').count() === 0 && await page.locator('.btw-hint').isVisible());
  await page.locator('#btw-close-btn').click();

  check('no renderer errors', errors.length === 0);
  console.log(`${checks.length}/${checks.length} passed`);
} finally {
  await app.close();
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2));
}