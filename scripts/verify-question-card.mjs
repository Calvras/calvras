// Verifies the mid-build question selection card on the real rendered UI:
// the build pauses, the composer swaps to a numbered-option card, and the
// turn resumes only after an option click, free-text answer, or Skip.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-qcard-'));
const out = path.resolve('.agents/artifacts/question-card');
await fs.mkdir(out, { recursive: true });

const checks = [];
function check(name, ok) { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }

const ASK_CONTENT = 'I need one decision.\n```ask:What do you want to see?\n1. A select box (dropdown)\n2. A ballot/election box\n3. A chat input with options\n4. A multi-select checklist\n```';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['main.cjs', '--user-data-dir=' + profile], env, timeout: 60000 });

let capturedBodies = [];
let sseMode = 'ask';
function sseBody(content) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
}
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.route('https://api.together.xyz/**', async route => {
    const body = route.request().postData() || '';
    capturedBodies.push(body);
    let content;
    if (sseMode === 'ask') content = body.includes('A ballot/election box') ? 'Building the ballot box now.' : ASK_CONTENT;
    else if (sseMode === 'prose') content = body.includes('yes dark mode') ? 'Dark mode added.' : 'I can add that. Should I add dark mode?';
    else if (sseMode === 'skip') content = body.includes('Skip this question') ? 'Proceeding with my judgment.' : ASK_CONTENT;
    else content = ASK_CONTENT;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseBody(content) });
  });
  await page.route('https://calvras.com/api/site/quota', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ quota: { used: 0, limit: 100, exhausted: false } }) }));

  await page.goto(pathToFileURL(path.resolve('app.html')).href);
  await page.waitForSelector('#prompt-input');

  // 1 ── ask block pauses the build and swaps the composer for the card
  await page.fill('#prompt-input', 'Build me a box');
  await page.click('#send-btn');
  await page.waitForSelector('#question-card', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.is-live'), null, { timeout: 10000 });
  const cardState = await page.evaluate(() => ({
    title: document.querySelector('.question-card-title').textContent,
    options: [...document.querySelectorAll('.question-option')].map(b => [b.querySelector('.question-option-num').textContent, b.querySelector('.question-option-text').textContent]),
    composerHidden: document.getElementById('capsule-input-bar').style.display === 'none',
    freePlaceholder: document.getElementById('question-free-input').placeholder,
    skip: document.getElementById('question-skip-btn').textContent,
    toolRows: messagesContainer.querySelectorAll('.agent-tool-item').length,
    rawFence: messagesContainer.innerText.includes('```ask'),
    prose: messagesContainer.innerText.includes('I need one decision.'),
  }));
  check('card shows ask title', cardState.title === 'What do you want to see?');
  check('card shows 4 numbered options', cardState.options.length === 4 && cardState.options[1][0] === '2' && cardState.options[1][1] === 'A ballot/election box');
  check('composer hidden while question pending', cardState.composerHidden);
  check('free input + Skip present', cardState.freePlaceholder === 'Something else' && cardState.skip === 'Skip');
  check('build fully paused: no tools ran', cardState.toolRows === 0 && cardState.prose);
  check('ask fence never renders as text', !cardState.rawFence);
  await page.screenshot({ path: path.join(out, 'question-card.png') });

  // 2 ── clicking an option resumes the build with that answer
  await page.click('.question-option:nth-child(2)');
  await page.waitForFunction(() => !document.getElementById('question-card'), null, { timeout: 5000 });
  await page.waitForFunction(() => messagesContainer.innerText.includes('Building the ballot box now.'), null, { timeout: 20000 });
  const afterPick = await page.evaluate(() => ({
    composerBack: document.getElementById('capsule-input-bar').style.display !== 'none',
    userEcho: messagesContainer.innerText.includes('A ballot/election box'),
  }));
  const answerSent = capturedBodies.length >= 2 && capturedBodies[capturedBodies.length - 1].includes('A ballot/election box');
  check('option click removes card and restores composer', afterPick.composerBack);
  check('option answer is sent as the next user turn', answerSent && afterPick.userEcho);

  // 3 ── prose question fallback: no options, free input focused, Enter submits
  sseMode = 'prose';
  await page.fill('#capsule-prompt-input', 'Add dark mode');
  await page.click('#capsule-send-btn');
  await page.waitForSelector('#question-card', { timeout: 20000 });
  const proseState = await page.evaluate(() => ({
    options: document.querySelectorAll('.question-option').length,
    focused: document.activeElement && document.activeElement.id === 'question-free-input',
    title: document.querySelector('.question-card-title').textContent,
  }));
  check('prose question shows free-input card', proseState.options === 0 && proseState.focused && proseState.title.includes('Should I add dark mode?'));
  await page.fill('#question-free-input', 'yes dark mode');
  await page.press('#question-free-input', 'Enter');
  await page.waitForFunction(() => messagesContainer.innerText.includes('Dark mode added.'), null, { timeout: 20000 });
  check('free-text Enter resumes the build', await page.evaluate(() => !document.getElementById('question-card')));

  // 4 ── Skip sends the proceed-with-judgment answer
  sseMode = 'skip';
  await page.fill('#capsule-prompt-input', 'Build another box');
  await page.click('#capsule-send-btn');
  await page.waitForSelector('#question-card', { timeout: 20000 });
  await page.click('#question-skip-btn');
  await page.waitForFunction(() => messagesContainer.innerText.includes('Proceeding with my judgment.'), null, { timeout: 20000 });
  check('Skip resumes with best-judgment answer', capturedBodies[capturedBodies.length - 1].includes('Skip this question'));

  // 5 ── X dismisses without sending anything
  sseMode = 'dismiss';
  const beforeDismiss = capturedBodies.length;
  await page.fill('#capsule-prompt-input', 'Build a third box');
  await page.click('#capsule-send-btn');
  await page.waitForSelector('#question-card', { timeout: 20000 });
  await page.click('#question-close-btn');
  await page.waitForFunction(() => !document.getElementById('question-card'), null, { timeout: 5000 });
  await page.waitForTimeout(600);
  const afterDismiss = await page.evaluate(() => ({
    composerBack: document.getElementById('capsule-input-bar').style.display !== 'none',
    live: !!document.querySelector('.is-live'),
  }));
  check('X restores composer without sending', afterDismiss.composerBack && !afterDismiss.live && capturedBodies.length === beforeDismiss + 1);
  await page.screenshot({ path: path.join(out, 'dismissed.png') });

  check('no page errors', errors.length === 0);
  if (errors.length) console.log('ERRORS', errors);
} finally {
  await app.close();
}
const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);