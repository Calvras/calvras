// Proves the icon rail is gone, the left edge is flat, and the header toggle
// slides the drawer out and back.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-flat-'));
const out = path.resolve('.agents/artifacts/flat-left');
await fs.mkdir(out, { recursive: true });
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

  const initial = await page.evaluate(() => {
    const main = document.querySelector('.main-content').getBoundingClientRect();
    const sb = document.getElementById('sidebar');
    const box = sb.getBoundingClientRect();
    return {
      rail: !!document.getElementById('codex-rail') || !!document.querySelector('.rail-btn'),
      mainX: main.x, collapsed: sb.classList.contains('collapsed'), sbRight: box.right,
      toggleVisible: getComputedStyle(document.getElementById('sidebar-uncollapse-btn')).display !== 'none',
      avatarInHeader: !!document.querySelector('.header-right #user-profile-btn'),
      avatarLoaded: (() => { const i = document.getElementById('user-avatar-img'); return i.complete && i.naturalWidth > 0; })(),
    };
  });
  check('icon rail fully removed', !initial.rail);
  check('left edge flat (main starts at x=0)', initial.mainX === 0);
  check('drawer starts hidden off-screen', initial.collapsed && initial.sbRight <= 0);
  check('header sidebar toggle visible', initial.toggleVisible);
  check('account avatar moved to header and loads', initial.avatarInHeader && initial.avatarLoaded);
  await page.screenshot({ path: path.join(out, 'flat-left.png') });

  await page.evaluate(() => document.getElementById('sidebar-uncollapse-btn').click());
  await page.waitForTimeout(450);
  const open = await page.evaluate(() => {
    const sb = document.getElementById('sidebar');
    const box = sb.getBoundingClientRect();
    return { collapsed: sb.classList.contains('collapsed'), x: box.x, w: box.width, scrim: document.body.classList.contains('sidebar-open'), toggleHidden: getComputedStyle(document.getElementById('sidebar-uncollapse-btn')).display === 'none' };
  });
  check('toggle slides drawer out from the left edge', !open.collapsed && open.x === 0 && open.w === 290 && open.scrim && open.toggleHidden);
  await page.screenshot({ path: path.join(out, 'drawer-open.png') });

  await page.evaluate(() => document.getElementById('btn-new-chat').click());
  await page.waitForTimeout(200);
  const home = await page.evaluate(() => document.getElementById('welcome-container').style.display !== 'none');
  check('drawer New chat still reaches home', home);

  await page.evaluate(() => document.getElementById('sidebar-toggle-btn').click());
  await page.waitForTimeout(450);
  const closed = await page.evaluate(() => {
    const sb = document.getElementById('sidebar');
    return { collapsed: sb.classList.contains('collapsed'), right: sb.getBoundingClientRect().right, toggleBack: getComputedStyle(document.getElementById('sidebar-uncollapse-btn')).display !== 'none' };
  });
  check('drawer collapse button slides it back', closed.collapsed && closed.right <= 0 && closed.toggleBack);
  check('no page errors', errors.length === 0);
  if (errors.length) console.log(errors.join('\n'));
} finally {
  await app.close();
}
const failed = checks.filter(c => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);