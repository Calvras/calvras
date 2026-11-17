// Verifies the out-of-usage banner on the real rendered UI: at the daily limit the
// composer is replaced by the banner (reset time + Upgrade), Upgrade opens the plan
// dialog, and the composer returns once the reset time passes.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-usage-'));
const out = path.resolve('.agents/artifacts/usage-banner');
await fs.mkdir(out, { recursive: true });

const checks = [];
function check(name, ok) { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }

// Runs an object-expression in the page with a `vis` helper that reports whether a
// selector actually occupies layout space (accounts for hidden ancestors).
const state = (page, expr) => page.evaluate(`(() => {
  const vis = sel => { const el = document.querySelector(sel); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return (${expr});
})()`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['main.cjs', '--user-data-dir=' + profile], env, timeout: 60000 });

try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve('app.html')).href);
  await page.waitForSelector('#prompt-input');

  const baseline = await state(page, `{
    locked: document.body.classList.contains('usage-locked'),
    homeBannerHidden: document.querySelector('.codex-home-composer .usage-limit-banner').hidden,
    projectBarVisible: vis('#tag-folder'),
    homeInputVisible: vis('#prompt-input'),
  }`);
  check('unlocked by default: composer shown, banner hidden', !baseline.locked && baseline.homeBannerHidden && baseline.projectBarVisible && baseline.homeInputVisible);

  // Reach the limit: lock the quota and refresh.
  await page.evaluate(() => { quotaLockedUntil = Date.now() + 3600_000; refreshUsageLock(); });
  const lockedState = await state(page, `{
    locked: document.body.classList.contains('usage-locked'),
    homeBannerShown: !document.querySelector('.codex-home-composer .usage-limit-banner').hidden,
    capBannerShown: !document.querySelector('.capsule-input-container .usage-limit-banner').hidden,
    projectBarHidden: !vis('#tag-folder'),
    homeInputHidden: !vis('#prompt-input'),
    capBarHidden: !vis('#capsule-input-bar'),
    title: document.querySelector('.codex-home-composer .usage-limit-title').textContent,
    reset: document.querySelector('.codex-home-composer .usage-limit-reset').textContent,
    upgradeLabel: document.querySelector('.codex-home-composer .usage-limit-upgrade').textContent.trim(),
  }`);
  check('limit locks body and shows banner in both layouts', lockedState.locked && lockedState.homeBannerShown && lockedState.capBannerShown);
  check('composer contents hidden while locked', lockedState.projectBarHidden && lockedState.homeInputHidden && lockedState.capBarHidden);
  check('banner copy + reset time + Upgrade pill', lockedState.title === "You're out of Calvras usage" && /\w{3} \d{1,2}, \d{1,2}:\d{2} (AM|PM)/.test(lockedState.reset) && lockedState.upgradeLabel.includes('Upgrade'));
  await page.screenshot({ path: path.join(out, 'locked-home.png') });

  // Upgrade opens the plan dialog.
  await page.click('.codex-home-composer .usage-limit-upgrade');
  await page.waitForSelector('#upgrade-modal', { timeout: 5000 });
  check('Upgrade opens plan dialog', await page.evaluate(() => getComputedStyle(document.getElementById('upgrade-modal')).display !== 'none'));
  await page.click('#upgrade-close-btn');

  // Reset passes: composer returns.
  await page.evaluate(() => { quotaLockedUntil = 0; refreshUsageLock(); });
  const restored = await state(page, `{
    locked: document.body.classList.contains('usage-locked'),
    homeBannerHidden: document.querySelector('.codex-home-composer .usage-limit-banner').hidden,
    projectBarVisible: vis('#tag-folder'),
    homeInputVisible: vis('#prompt-input'),
  }`);
  check('after reset composer restored and banner hidden', !restored.locked && restored.homeBannerHidden && restored.projectBarVisible && restored.homeInputVisible);
  await page.screenshot({ path: path.join(out, 'restored-home.png') });

  check('no page errors', errors.length === 0);
  if (errors.length) console.log('ERRORS', errors);
} finally {
  await app.close();
}
const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);