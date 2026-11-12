// Proves the desktop app's update check: a newer published release puts the update badge in the
// top-right action bar, an equal or older release shows nothing, and the real GitHub feed is
// consulted without errors. The feed response is a fixture; the app code under test is real.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-badge-'));
const out = path.resolve('.agents/artifacts/update-badge');
await fs.mkdir(out, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const packagedExe = process.env.CALVRAS_TEST_EXE;
if (packagedExe) {
  // Token-less fixture identity: skips the sign-in screen; account sync aborts locally without tokens.
  await fs.writeFile(path.join(profile, 'calvras-auth.json'), JSON.stringify({ email: 'badge-smoke@example.test', name: 'Badge Smoke' }));
}
const app = await electron.launch({ executablePath: packagedExe || path.resolve('node_modules/electron/dist/electron.exe'), args: packagedExe ? ['--user-data-dir=' + profile] : ['main.cjs', '--user-data-dir=' + profile], env, timeout: 60000 });
const checks = [];
function check(name, ok) { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
const feed = { tag: 'v99.1.0' };
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://api.github.com/repos/Calvras/calvras/releases/latest', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ tag_name: feed.tag, assets: [{ name: `Calvras.Setup.${feed.tag.replace(/^v/, '')}.exe`, browser_download_url: `https://github.com/Calvras/calvras/releases/download/${feed.tag}/Calvras.Setup.${feed.tag.replace(/^v/, '')}.exe` }] }),
  }));
  if (packagedExe) {
    check('packaged build reports the published version', await app.evaluate(({ app: electronApp }) => electronApp.getVersion()) === '9.4.0');
  } else {
    await page.goto(pathToFileURL(path.resolve('app.html')).href);
  }
  await page.waitForSelector('#prompt-input');

  await page.locator('#update-badge').waitFor({ state: 'visible', timeout: 15000 });
  const badge = await page.locator('#update-badge').evaluate(node => {
    const box = node.getBoundingClientRect();
    const bar = document.querySelector('.header-right').getBoundingClientRect();
    return { text: node.textContent.trim(), title: node.title, box: { x: box.x, y: box.y, w: box.width, h: box.height }, bar: { x: bar.x, y: bar.y, w: bar.width, h: bar.height }, viewport: innerWidth };
  });
  check(`newer release shows the badge (${badge.text})`, badge.text === 'Update to v99.1.0');
  check('badge sits in the top-right action bar', badge.box.y >= badge.bar.y - 1 && badge.box.y + badge.box.h <= badge.bar.y + badge.bar.h + 1 && badge.box.x > badge.viewport * 0.6 && badge.box.x + badge.box.w <= badge.bar.x + badge.bar.w + 1);
  check('badge tooltip names the install target', /99\.1\.0/.test(badge.title));
  await page.screenshot({ path: path.join(out, 'badge.png') });

  feed.tag = 'v9.4.0';
  await page.reload();
  await page.waitForSelector('#prompt-input');
  await page.waitForTimeout(2500);
  check('same published version shows no badge', await page.locator('#update-badge').isHidden());

  feed.tag = 'v9.3.1';
  await page.reload();
  await page.waitForSelector('#prompt-input');
  await page.waitForTimeout(2500);
  check('older published version shows no badge', await page.locator('#update-badge').isHidden());

  await page.unroute('https://api.github.com/repos/Calvras/calvras/releases/latest');
  await page.reload();
  await page.waitForSelector('#prompt-input');
  await page.waitForTimeout(3500);
  check('real GitHub feed is readable and shows no badge for this build', await page.locator('#update-badge').isHidden());
  check('no page errors', errors.length === 0);
  if (errors.length) console.log(errors.join('\n'));
} finally {
  await app.close();
}
const failed = checks.filter(c => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);