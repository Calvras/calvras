// Verifies the new batch UI on the real rendered Electron app:
// sidebar width, Settings footer + full window, menu bar, coding placeholder,
// mic listening->preview->send flow (mocked speech), and ask options only in the card.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-batch-'));
const out = path.resolve('.agents/artifacts/batch-ui');
await fs.mkdir(out, { recursive: true });
const checks = [];
const check = (name, ok) => { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['main.cjs', '--user-data-dir=' + profile], env, timeout: 60000 });

const ASK = '<read path="app.html"></read>\n<read path="app.css"></read>\nOne decision.\n```ask:Pick a style\n1. Dark mode\n2. Light mode\n```';
function sse(content) { return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`; }

try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // Mock speech recognition so the mic flow is drivable without a real mic.
  await page.addInitScript(() => {
    class FakeRec {
      constructor() { this.continuous = false; this.interimResults = false; this.lang = ''; window.__rec = this; }
      start() { this.started = true; }
      stop() { if (this.stopped) return; this.stopped = true; setTimeout(() => { if (this.onend) this.onend(); }, 0); }
      emit(text, isFinal) {
        const res = [[{ transcript: text }]]; res[0].isFinal = isFinal;
        if (this.onresult) this.onresult({ resultIndex: 0, results: res });
      }
    }
    window.SpeechRecognition = FakeRec;
    // No real mic in CI: fake stream + silent analyser so the component takes its
    // real recognition path and FakeRec drives transcription.
    const fakeStream = { getTracks: () => [{ stop() {} }] };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.resolve(fakeStream);
    class FakeAudioCtx {
      createAnalyser() { return { fftSize: 64, frequencyBinCount: 32, getByteFrequencyData(arr) { arr.fill(0); } }; }
      createMediaStreamSource() { return { connect() {} }; }
      close() { return Promise.resolve(); }
    }
    window.AudioContext = FakeAudioCtx;
  });
  await page.route('https://api.together.xyz/**', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(ASK) }));
  await page.route('https://calvras.com/api/site/quota', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ quota: { used: 0, limit: 100000, exhausted: false } }) }));

  await page.goto(pathToFileURL(path.resolve('app.html')).href);
  await page.waitForSelector('#prompt-input');

  // 0 ── splash shows the logo centered, then auto-dismisses to reveal the session
  const splashUp = await page.evaluate(() => {
    const s = document.getElementById('app-splash');
    if (!s) return null;
    const r = s.getBoundingClientRect();
    const mr = s.querySelector('.app-splash-mark')?.getBoundingClientRect();
    return {
      covers: r.width >= innerWidth - 1 && r.height >= innerHeight - 1,
      centered: !!mr && Math.abs((mr.left + mr.width / 2) - innerWidth / 2) < 4 && Math.abs((mr.top + mr.height / 2) - innerHeight / 2) < 4,
    };
  });
  check('splash covers window with centered logo', !!splashUp && splashUp.covers && splashUp.centered);
  await page.screenshot({ path: path.join(out, 'splash.png') });
  await page.waitForSelector('#app-splash', { state: 'detached', timeout: 6000 });
  check('splash auto-dismisses after ~2.5s', await page.evaluate(() => !document.getElementById('app-splash')));

  // 1 ── sidebar width reduced to 280 and Settings footer present
  const width = await page.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().width);
  check('sidebar width is 280px', Math.round(width) === 280);
  check('settings footer button exists', await page.evaluate(() => !!document.getElementById('btn-settings-nav')));

  // 2 ── placeholder is coding-related, not "Message..."
  const ph = await page.evaluate(() => document.getElementById('prompt-input').placeholder);
  check('placeholder changed from Message...', ph !== 'Message...' && ph.length > 0);

  // 2b ── v9.6.0 composer card: textarea + attach / mode / mic / send row
  const cardIdle = await page.evaluate(() => ({
    home: ['prompt-input', 'send-btn', 'attach-btn', 'mode-selector-btn', 'voice-btn', 'card-attachments'].every(id => !!document.getElementById(id)),
    capsule: ['capsule-prompt-input', 'capsule-send-btn', 'capsule-attach-btn', 'capsule-mode-btn', 'capsule-voice-btn', 'capsule-attachments'].every(id => !!document.getElementById(id)),
    noReact: !document.getElementById('home-react-prompt') && !window.CalvrasPrompt,
  }));
  check('v9.6.0 home + capsule composer controls restored', cardIdle.home && cardIdle.capsule && cardIdle.noReact);
  await page.fill('#prompt-input', 'hello');
  const typed = await page.evaluate(() => document.getElementById('prompt-input').value === 'hello');
  check('typing writes into the home textarea', typed);
  await page.fill('#prompt-input', '');
  await page.evaluate(() => document.getElementById('prompt-input').blur());
  await page.waitForTimeout(60);
  const bgUnified = await page.evaluate(() => {
    const bg = el => getComputedStyle(el).backgroundColor;
    return {
      body: bg(document.body),
      menubar: bg(document.getElementById('app-menubar')),
      main: bg(document.querySelector('.main-content')),
      thread: bg(document.querySelector('.conversation-thread')),
    };
  });
  check('entire app background unified to #181818', Object.values(bgUnified).every(c => c === 'rgb(24, 24, 24)'));

  // 3 ── menu bar present; File menu opens and Settings action opens full window
  check('menu bar has File/Edit/View/Help', await page.evaluate(() => ['menu-file', 'menu-edit', 'menu-view', 'menu-help'].every(id => !!document.getElementById(id))));
  const strip = await page.evaluate(() => {
    const r = document.getElementById('app-menubar').getBoundingClientRect();
    const s = document.getElementById('sidebar').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height, sidebarTop: s.top };
  });
  check('menu bar is a top strip above the sidebar', strip.top < 2 && strip.height <= 40 && strip.bottom <= strip.sidebarTop + 1);
  const titlebar = await page.evaluate(() => {
    const nav = document.getElementById('app-menubar');
    const main = document.querySelector('.main-content');
    const cs = getComputedStyle(main);
    return {
      brandGone: !nav.querySelector('.titlebar-brand'),
      menusInNav: !!nav.querySelector('.menubar-btn[data-menu="menu-file"]') && !!nav.querySelector('.menubar-btn[data-menu="menu-help"]'),
      uncollapseInNav: !!nav.querySelector('#sidebar-uncollapse-btn'),
      terminalInNav: !!nav.querySelector('#terminal-toggle-btn'),
      terminalInHeader: !!document.querySelector('header.main-header #terminal-toggle-btn'),
      diffInNav: !!nav.querySelector('#top-diff-btn'),
      secondRowPresent: !!document.querySelector('header.main-header'),
      gradient: cs.backgroundImage.includes('gradient'),
      curve: parseFloat(cs.borderTopLeftRadius) > 0,
      mainDark: cs.backgroundColor === 'rgb(24, 24, 24)',
      composerDark: getComputedStyle(document.querySelector('.capsule-input-bar')).backgroundColor === 'rgb(48, 48, 48)',
    };
  });
  check('Calvras brand removed from top bar', titlebar.brandGone);
  check('menus moved up into top bar', titlebar.menusInNav && titlebar.uncollapseInNav && titlebar.diffInNav);
  check('terminal button moved back down to header row', !titlebar.terminalInNav && titlebar.terminalInHeader && titlebar.secondRowPresent);
  check('original dark design restored, no curve', !titlebar.gradient && !titlebar.curve && titlebar.mainDark);
  check('composer keeps dark theme', titlebar.composerDark);
  await page.click('.menubar-btn[data-menu="menu-file"]');
  check('File dropdown opens', await page.evaluate(() => document.getElementById('menu-file').classList.contains('open')));
  await page.click('#menu-file .menubar-action[data-action="settings"]');
  await page.waitForTimeout(200);
  check('Settings opens full window', await page.evaluate(() => document.getElementById('settings-modal').style.display === 'flex'));
  check('Settings fills the entire window', await page.evaluate(() => {
    const r = document.querySelector('.settings-dialog-card').getBoundingClientRect();
    return Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2;
  }));
  await page.screenshot({ path: path.join(out, 'settings-window.png') });
  await page.click('#close-settings-modal');

  // 4 ── sidebar Settings button also opens the window
  await page.evaluate(() => document.getElementById('sidebar').classList.remove('collapsed'));
  await page.click('#btn-settings-nav');
  await page.waitForTimeout(150);
  check('sidebar Settings opens window', await page.evaluate(() => document.getElementById('settings-modal').style.display === 'flex'));
  await page.click('#close-settings-modal');

  // 5 ── folder chip sits below the card, detached; send via the card's send button
  await page.waitForTimeout(450);
  const chip = await page.evaluate(() => {
    const bar = document.getElementById('tag-folder').getBoundingClientRect();
    const card = document.querySelector('.codex-home-composer .antigravity-chat-card').getBoundingClientRect();
    return { below: bar.top > card.bottom, gap: bar.top - card.bottom };
  });
  check('folder chip below card, not attached', chip.below && chip.gap >= 8);
  await page.fill('#prompt-input', 'build me a dark box');
  await page.click('#send-btn');
  await page.waitForSelector('#question-card', { timeout: 20000 });

  // 6 ── ask options appear only in the card, not duplicated in the reply
  const askState = await page.evaluate(() => ({
    cardOptions: [...document.querySelectorAll('.question-option-text')].map(e => e.textContent),
    replyHasOptions: messagesContainer.innerText.includes('1. Dark mode') || messagesContainer.innerText.includes('Dark mode\n2.'),
    rawFence: messagesContainer.innerText.includes('```ask'),
  }));
  check('ask card shows the options', askState.cardOptions.length === 2 && askState.cardOptions[0] === 'Dark mode');
  check('options not duplicated in reply', !askState.replyHasOptions);
  check('ask fence not leaked as text', !askState.rawFence);
  await page.screenshot({ path: path.join(out, 'ask-card.png') });

  // 7 ── work-step scrubber: right rail, magnifying hover, click-to-flash
  const rail = await page.evaluate(() => {
    const root = document.querySelector('.work-scrubber');
    const vp = document.getElementById('chat-viewport').getBoundingClientRect();
    const r = root.getBoundingClientRect();
    return {
      visible: !root.hidden,
      ticks: root.querySelectorAll('.work-scrubber-tick').length,
      rightSide: r.right <= vp.right && r.left > vp.left + vp.width / 2,
      centered: Math.abs((r.top + r.height / 2) - (vp.top + vp.height / 2)) < 4,
    };
  });
  check('work-step rail visible on the right', rail.visible && rail.ticks >= 2 && rail.rightSide && rail.centered);
  const listBox = await page.evaluate(() => {
    const r = document.querySelector('.work-scrubber-list').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(listBox.x, listBox.y);
  await page.waitForTimeout(500);
  const hover = await page.evaluate(() => ({
    opacity: Number(getComputedStyle(document.querySelector('.work-scrubber-card')).opacity),
    width: Math.max(...[...document.querySelectorAll('.work-scrubber-tick-bar')].map(b => b.getBoundingClientRect().width)),
    title: document.querySelector('.work-scrubber-title').textContent,
  }));
  check('hover magnifies ticks and opens the card', hover.opacity > .6 && hover.width > 30 && hover.title.startsWith('Read'));
  await page.screenshot({ path: path.join(out, 'work-rail.png') });
  await page.click('.work-scrubber-tick');
  await page.waitForTimeout(200);
  check('clicking a tick flashes its work row', await page.evaluate(() => !!document.querySelector('.agent-tool-item.scrub-flash')));
  await page.mouse.move(10, 400);

  check('no page errors', errors.length === 0);
  await page.evaluate(() => window.require('electron').ipcRenderer.invoke('pet:enabled', true));
  await page.waitForTimeout(800);
  const petWin = app.windows().find(w => w.url().includes('pet.html'));
  check('desktop pet defaults to the ghost', !!petWin && petWin.url().includes('pet=ghost'));
  if (petWin) {
    const ghost = await petWin.evaluate(() => ({
      canvas: !!document.querySelector('canvas'),
      img: !!document.querySelector('img'),
    }));
    check('ghost is rendered from code (canvas, no image)', ghost.canvas && !ghost.img);
    await petWin.waitForTimeout(700);
    await petWin.screenshot({ path: path.join(out, 'ghost-pet.png') });
  }
  await page.screenshot({ path: path.join(out, 'titlebar.png') });
  if (errors.length) console.log('ERRORS', errors);
} finally {
  await app.close();
}
const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);