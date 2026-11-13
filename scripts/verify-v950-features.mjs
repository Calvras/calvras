// Verifies the v9.5.0 batch on the real rendered UI: XML tool-tag parsing,
// question gate, artifact cards + PDF/game preview, upgrade dialog, PDF upload
// extraction, and the ethical/scope system prompt actually sent to the model.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-v950-'));
const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-v950-ws-'));
const out = path.resolve('.agents/artifacts/v950');
await fs.mkdir(out, { recursive: true });

await fs.writeFile(path.join(ws, 'game.html'), '<!-- SNAKE_GAME_MARKER -->\n<!doctype html><html><body><canvas id="game" width="320" height="320"></canvas><script>const ctx = document.getElementById("game").getContext("2d"); ctx.fillRect(10, 10, 40, 40);</script></body></html>\n');

function makePdf(streamBody) {
  const data = zlib.deflateSync(Buffer.from(streamBody));
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n${data.toString('latin1')}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objs.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
const pdfBuf = makePdf('BT /F1 12 Tf 72 720 Td (Hello Calvras PDF) Tj 0 -20 Td (Second line here) Tj ET');
await fs.writeFile(path.join(ws, 'report.pdf'), pdfBuf);

const checks = [];
function check(name, ok) { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['main.cjs', '--user-data-dir=' + profile], env, timeout: 60000 });

let capturedBodies = [];
let sseMode = 'question';
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
    if (sseMode === 'question') content = 'I can build that game. Should I use canvas or DOM?\n<read:game.html></read>';
    else if (sseMode === 'tool') content = body.includes('SNAKE_GAME_MARKER') ? 'The game file looks ready.' : 'Checking the game file now.\n<read:game.html></read>';
    else content = 'The attached PDF greets Calvras.';
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseBody(content) });
  });
  await page.route('https://calvras.com/api/site/quota', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ quota: { used: 0, limit: 100, exhausted: false } }) }));

  await page.goto(pathToFileURL(path.resolve('app.html')).href);
  await page.waitForSelector('#prompt-input');

  await page.evaluate(dir => window.require('electron').ipcRenderer.invoke('workspace:set-folder', dir), ws);
  await page.waitForFunction(() => typeof workspacePreviewBase === 'string' && workspacePreviewBase.startsWith('http://127.0.0.1:'), null, { timeout: 10000 });

  // 1 ── XML tool tags from the screenshots parse and strip cleanly
  const parser = await page.evaluate(() => {
    const read = parseAgentBlocks('Checking files.\n<read:default.project.json></read>');
    const write = parseAgentBlocks('<write workspace="." path="check.ps1">Write-Host hi</write>');
    const run = parseAgentBlocks('<run:Get-Command Get-Process></run>');
    const stripped = stripToolBlocks('Before <read:default.project.json></read> middle <write workspace="." path="check.ps1">x</write> after <run:Get-Command x></run> end');
    return {
      read: read.map(b => [b.kind, b.arg]), write: write.map(b => [b.kind, b.arg, b.body]), run: run.map(b => [b.kind, b.arg]),
      stripped, questionYes: endsWithUserQuestion('Should I use canvas or DOM?'), questionNo: endsWithUserQuestion('All done.'),
    };
  });
  check('read XML tag parses', parser.read.length === 1 && parser.read[0][0] === 'read' && parser.read[0][1] === 'default.project.json');
  check('write XML tag parses with path attr', parser.write.length === 1 && parser.write[0][0] === 'write' && parser.write[0][1] === 'check.ps1' && parser.write[0][2].includes('Write-Host'));
  check('run XML tag parses', parser.run.length === 1 && parser.run[0][0] === 'run' && parser.run[0][1] === 'Get-Command Get-Process');
  check('stripToolBlocks removes all XML tags', !/<\/?(read|write|run)[:\s>]/.test(parser.stripped) && parser.stripped.includes('Before') && parser.stripped.includes('end'));
  check('question detector', parser.questionYes === true && parser.questionNo === false);

  // 2 ── new logo on home
  const logo = await page.evaluate(() => {
    const img = document.querySelector('.codex-home-hero .codex-home-logo');
    return { src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0 };
  });
  check('home hero uses new logo and loads', logo.src === 'calvras-logo.png' && logo.loaded);
  await page.screenshot({ path: path.join(out, 'home.png') });

  // 3 ── artifact cards + PDF preview + game preview
  await page.evaluate(() => {
    const row = document.createElement('div');
    row.id = 'test-artifact-row';
    renderArtifactHolder(row, [artifactInfo('report.pdf'), artifactInfo('game.html')]);
    messagesContainer.appendChild(row);
  });
  const cards = await page.evaluate(() => {
    const row = document.getElementById('test-artifact-row');
    return {
      count: row.querySelectorAll('.artifact-card').length,
      pdfBtns: [...row.querySelector('[data-path="report.pdf"]').querySelectorAll('button')].map(b => b.textContent),
    };
  });
  check('artifact cards render with Preview + Open file', cards.count === 2 && cards.pdfBtns.includes('Preview') && cards.pdfBtns.includes('Open file'));
  await page.evaluate(() => document.querySelector('#test-artifact-row [data-path="report.pdf"] .artifact-card-btn').click());
  await page.waitForFunction(() => document.getElementById('preview-panel').classList.contains('open'), null, { timeout: 5000 });
  const pdfPreview = await page.evaluate(() => ({
    iframeSrc: previewIframe.src, iframeVisible: previewIframe.style.display !== 'none', webview: !!document.getElementById('preview-site-view'),
  }));
  check('PDF opens in iframe viewer, not webview', pdfPreview.iframeSrc.endsWith('/report.pdf') && pdfPreview.iframeVisible && !pdfPreview.webview);
  const pdfRes = await fetch(pdfPreview.iframeSrc);
  check('preview server serves PDF mime', pdfRes.status === 200 && (pdfRes.headers.get('content-type') || '').includes('application/pdf'));
  await page.screenshot({ path: path.join(out, 'pdf-preview.png') });

  await page.evaluate(() => window.openLivePreview('game.html'));
  await page.waitForFunction(() => { const v = document.getElementById('preview-site-view'); return v && v.dataset.ready === 'true'; }, null, { timeout: 10000 });
  const gamePreview = await page.evaluate(() => ({
    webview: !!document.getElementById('preview-site-view'), iframeHidden: previewIframe.style.display === 'none', src: document.getElementById('preview-site-view').src,
  }));
  check('game opens in webview preview', gamePreview.webview && gamePreview.iframeHidden && gamePreview.src.endsWith('/game.html'));
  await page.screenshot({ path: path.join(out, 'game-preview.png') });
  await page.evaluate(() => { window.closeLivePreview(); document.getElementById('test-artifact-row').remove(); });

  // 4 ── upgrade dialog
  await page.evaluate(() => window.openUpgradeDialog());
  const upgradeOpen = await page.evaluate(() => document.getElementById('upgrade-modal').style.display === 'flex');
  await page.evaluate(() => document.getElementById('upgrade-checkout-btn').click());
  const upgradeNote = await page.evaluate(() => document.getElementById('upgrade-note').textContent);
  await page.screenshot({ path: path.join(out, 'upgrade.png') });
  await page.evaluate(() => document.getElementById('upgrade-close-btn').click());
  const upgradeClosed = await page.evaluate(() => document.getElementById('upgrade-modal').style.display === 'none');
  check('upgrade dialog opens, explains checkout pending, closes', upgradeOpen && upgradeNote.includes('Payment checkout is being connected') && upgradeClosed);

  // 5 ── PDF upload extraction IPC
  const extracted = await page.evaluate(b64 => window.require('electron').ipcRenderer.invoke('pdf:extract-text', { dataB64: b64 }), pdfBuf.toString('base64'));
  check('pdf:extract-text reads uploaded PDF', (extracted.text || '').includes('Hello Calvras PDF') && (extracted.text || '').includes('Second line here'));

  // 6 ── question gate end-to-end
  await page.fill('#prompt-input', 'Build me a snake game');
  await page.click('#send-btn');
  await page.waitForFunction(() => messagesContainer.innerText.includes('Should I use canvas or DOM?'), null, { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.is-live'), null, { timeout: 10000 });
  const gate = await page.evaluate(() => ({
    toolRows: messagesContainer.querySelectorAll('.agent-tool-item').length,
    rawTags: /<read:|<write[\s>]|<run:/.test(messagesContainer.innerText),
  }));
  check('question gate stops the turn with no tool run', gate.toolRows === 0);
  check('no raw tool tags in rendered reply', !gate.rawTags);
  await page.screenshot({ path: path.join(out, 'question-gate.png') });

  const sysBody = JSON.parse(capturedBodies[0] || '{}');
  const sysPrompt = (sysBody.messages || []).map(m => m.content || '').join('\n');
  check('system prompt carries ethical protocol', sysPrompt.includes('Ethical Use Protocol') && sysPrompt.includes('authorized penetration tester'));
  check('system prompt carries scope + question rules', sysPrompt.includes('Scope & speed') && sysPrompt.includes('emit NO tool blocks'));

  // 7 ── XML tool executes as a chip end-to-end
  sseMode = 'tool';
  await page.fill('#capsule-prompt-input', 'Now check the game file');
  await page.click('#capsule-send-btn');
  await page.waitForFunction(() => [...messagesContainer.querySelectorAll('.agent-tool-label')].some(el => el.textContent.includes('Read game.html')), null, { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.is-live'), null, { timeout: 15000 });
  const toolRender = await page.evaluate(() => {
    const chip = [...messagesContainer.querySelectorAll('.agent-tool-chip')].find(el => el.textContent.includes('Read game.html'));
    if (chip) chip.click();
    return {
      rawTags: /<read:/.test(messagesContainer.innerText),
      final: messagesContainer.innerText.includes('The game file looks ready.'),
      chips: messagesContainer.querySelectorAll('.agent-tool-chip').length,
    };
  });
  await page.waitForTimeout(400);
  const markerOk = await page.evaluate(() => {
    const chip = [...messagesContainer.querySelectorAll('.agent-tool-chip')].find(el => el.textContent.includes('Read game.html'));
    const drawer = chip && chip.closest('.agent-tool-item').querySelector('.agent-tool-drawer');
    return !!drawer && drawer.textContent.includes('SNAKE_GAME_MARKER');
  });
  check('read tag renders as chip and executes', !toolRender.rawTags && toolRender.final && markerOk);
  if (toolRender.rawTags || !toolRender.final || !markerOk) console.log('DEBUG tool', JSON.stringify(toolRender), 'marker', markerOk);
  await page.screenshot({ path: path.join(out, 'tool-chip.png') });

  // 8 ── PDF attachment reaches the model as extracted text
  sseMode = 'attach';
  capturedBodies = [];
  await page.setInputFiles('#capsule-file-input', path.join(ws, 'report.pdf'));
  await page.fill('#capsule-prompt-input', 'Summarize the attached PDF');
  await page.click('#capsule-send-btn');
  await page.waitForFunction(() => messagesContainer.innerText.includes('The attached PDF greets Calvras.'), null, { timeout: 20000 });
  const attachBody = capturedBodies.join('\n');
  check('uploaded PDF text is fed to the model', attachBody.includes('[Attached file: report.pdf]') && attachBody.includes('Hello Calvras PDF'));
  await page.screenshot({ path: path.join(out, 'attachment.png') });

  check('no page errors', errors.length === 0);
  if (errors.length) console.log(errors.join('\n'));
} finally {
  await app.close();
}
const failed = checks.filter(c => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);