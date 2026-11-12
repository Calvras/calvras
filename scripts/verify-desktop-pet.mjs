import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-pet-'));
const out = path.resolve('.agents/artifacts/desktop-pet');
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
  await page.locator('#prompt-input').fill('/');
  const homeMenu = page.locator('#prompt-input-commands');
  check('slash opens all three commands with descriptions above home composer', await homeMenu.isVisible() && await homeMenu.locator('button').count() === 3 && await homeMenu.locator('#prompt-input-commands-pet .slash-label').textContent() === 'Show pet' && await homeMenu.locator('.slash-desc').count() === 3 && await homeMenu.evaluate(el => el.getBoundingClientRect().bottom <= promptCard.getBoundingClientRect().top));
  await page.locator('#prompt-input').press('Escape');
  check('Escape dismisses without sending a message', !await homeMenu.isVisible() && await page.evaluate(() => chats.length === 0));
  await page.locator('#prompt-input').fill('/unmatched');
  check('unmatched slash text does not show pet command', !await homeMenu.isVisible());
  await page.locator('#prompt-input').fill('/show');
  const petReady = app.waitForEvent('window');
  await page.locator('#prompt-input').press('Enter');
  const pet = await petReady;
  pet.on('pageerror', error => errors.push(error.message));
  await pet.waitForSelector('canvas');
  await pet.waitForFunction(() => document.body.dataset.working === 'false');
  check('Enter opens the real local 3D pet without sending slash text', await page.locator('#prompt-input').inputValue() === '' && await page.evaluate(() => chats.length === 0));
  check('WebGL renders and exposes only narrow preload methods', await pet.evaluate(() => document.getElementById('render-error').hidden && typeof require === 'undefined' && Object.keys(window.pet).sort().join(',') === 'drag,dragEnd,menu,onState,restore'));
  const petStateOk = () => app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'));
    if (!win) return false;
    const prefs = win.webContents.getLastWebPreferences();
    return win.getParentWindow() === null && win.isAlwaysOnTop() && prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration;
  });
  let petState = false;
  for (let i = 0; i < 20 && !petState; i++) {
    petState = await petStateOk();
    if (!petState) await new Promise(r => setTimeout(r, 250));
  }
  check('pet is independent, sandboxed and always on top', petState);
  await pet.screenshot({ path: path.join(out, 'idle.png') });
  await page.evaluate(() => { setGeneratingState(true); updatePetActivity('Searching the web…'); });
  await pet.waitForFunction(() => document.body.dataset.working === 'true' && document.getElementById('bubble').textContent === 'Searching the web…');
  await pet.screenshot({ path: path.join(out, 'working.png') });
  check('live work drives the pet bubble and working state', await pet.locator('#bubble').textContent() === 'Searching the web…');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/app.html')).minimize());
  check('pet stays visible while main app is minimized', await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    return windows.find(w => w.webContents.getURL().endsWith('/app.html')).isMinimized() && windows.find(w => w.webContents.getURL().endsWith('/pet.html')).isVisible();
  }));
  await pet.locator('#robot').dblclick();
  await page.waitForFunction(() => !document.hidden);
  check('double-click restores the main app', await app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/app.html')).isMinimized()));
  await page.evaluate(() => setGeneratingState(false));
  await pet.waitForFunction(() => document.body.dataset.working === 'false');
  check('finished work returns pet to idle', await pet.locator('#bubble').textContent() === 'Ready when you are');
  const petPosition = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html')).getPosition());
  const beforeDrag = await petPosition();
  const robotBox = await pet.locator('#robot').boundingBox();
  const startX = Math.round(robotBox.x + robotBox.width / 2);
  const startY = Math.round(robotBox.y + robotBox.height / 2);
  await pet.mouse.move(startX, startY);
  await pet.mouse.down();
  for (const [dx, dy] of [[-20, -15], [-40, -30], [-60, -45], [-80, -60]]) {
    await pet.mouse.move(startX + dx, startY + dy);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  await pet.mouse.up();
  await new Promise(resolve => setTimeout(resolve, 200));
  const afterDrag = await petPosition();
  // Windows rounds synthesized pointer coordinates, so allow a few px of drift.
  check('dragging the robot moves the pet window', Math.abs(afterDrag[0] - (beforeDrag[0] - 80)) <= 4 && Math.abs(afterDrag[1] - (beforeDrag[1] - 60)) <= 4);
  let savedPosition = null;
  for (let i = 0; i < 40 && !savedPosition; i += 1) {
    try { savedPosition = JSON.parse(await fs.readFile(path.join(profile, 'pet-position.json'), 'utf8')); }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  check('drag end persists the pet position', Boolean(savedPosition) && savedPosition.x === afterDrag[0] && savedPosition.y === afterDrag[1]);
  await page.evaluate(() => { activeChatId = 'pet-test'; chats.push({ id: activeChatId, title: 'Pet test', messages: [] }); showConversationView('Pet test'); });
  await page.locator('#capsule-prompt-input').fill('/');
  const activeMenu = page.locator('#capsule-prompt-input-commands');
  check('active composer offers Off pet with approval-menu styling', await activeMenu.isVisible() && await activeMenu.locator('#capsule-prompt-input-commands-pet .slash-label').textContent() === 'Off pet' && await activeMenu.evaluate(el => {
    const menu = getComputedStyle(el), approval = getComputedStyle(document.getElementById('capsule-mode-menu'));
    return menu.backgroundColor === approval.backgroundColor && menu.borderRadius === approval.borderRadius;
  }));
  await page.screenshot({ path: path.join(out, 'slash.png') });
  const firstClosed = pet.waitForEvent('close');
  await activeMenu.locator('#capsule-prompt-input-commands-pet').click();
  await firstClosed;
  check('Off pet closes the independent window', await page.evaluate(async () => !(await getElectronIpc().invoke('pet:status')).enabled));
  await app.evaluate(({ Menu }) => {
    const build = Menu.buildFromTemplate;
    Menu.buildFromTemplate = function(template) { const menu = build.call(this, template); globalThis.petTestMenu = menu; return menu; };
  });
  await page.locator('#capsule-prompt-input').fill('/');
  const secondPetReady = app.waitForEvent('window');
  await activeMenu.locator('#capsule-prompt-input-commands-pet').click();
  const secondPet = await secondPetReady;
  await secondPet.waitForSelector('canvas');
  const restoredPosition = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html')).getPosition());
  // Windows DPI rounding on the frameless window can shift a coordinate by 1px.
  check('reopened pet restores the dragged position', Math.abs(restoredPosition[0] - afterDrag[0]) <= 2 && Math.abs(restoredPosition[1] - afterDrag[1]) <= 2);
  await secondPet.locator('#robot').click({ button: 'right' });
  const nativeMenu = await app.evaluate(() => globalThis.petTestMenu?.items.map(item => item.label));
  check('right-click creates native Off pet menu', nativeMenu?.[0] === 'Off pet');
  const closed = secondPet.waitForEvent('close');
  await app.evaluate(() => { const menu = globalThis.petTestMenu; menu.closePopup(); menu.items[0].click(); });
  await closed;
  check('native Off pet action updates the composer state', await page.evaluate(async () => !(await getElectronIpc().invoke('pet:status')).enabled));
  check('no renderer errors', errors.length === 0);
  console.log(`${checks.length}/${checks.length} passed`);
} finally {
  await app.close();
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2));
}
