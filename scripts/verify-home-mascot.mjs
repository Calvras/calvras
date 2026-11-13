// Proves the home greeting shows the new Calvras logo tile instead of the old SVG mark.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-mascot-'));
const out = path.resolve('.agents/artifacts/home-mascot');
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
  await page.locator('.codex-home-logo').waitFor({ state: 'visible', timeout: 15000 });

  const hero = await page.evaluate(() => {
    const img = document.querySelector('.codex-home-hero .codex-home-logo');
    const heading = document.getElementById('welcome-heading');
    const box = img.getBoundingClientRect();
    const head = heading.getBoundingClientRect();
    const cs = getComputedStyle(img);
    return {
      tag: img.tagName, loaded: img.complete && img.naturalWidth > 0, natural: img.naturalWidth,
      src: img.getAttribute('src'),
      box: { x: box.x, y: box.y, w: box.width, h: box.height }, headY: head.y,
      radius: cs.borderRadius, heading: heading.textContent.trim(),
      svgLeft: !!document.querySelector('.codex-home-hero svg'),
      centered: Math.abs((box.x + box.width / 2) - (head.x + head.width / 2)) < 2,
    };
  });
  check('logo image replaced the SVG mark', hero.tag === 'IMG' && !hero.svgLeft && hero.src === 'calvras-logo.png');
  check('logo file actually loads', hero.loaded && hero.natural >= 512);
  check('tile renders 104px with rounded corners', Math.abs(hero.box.w - 104) < 1 && Math.abs(hero.box.h - 104) < 1 && hero.radius === '26px');
  check('tile sits centered above the greeting', hero.box.y + hero.box.h <= hero.headY && hero.centered);
  check('greeting unchanged', hero.heading === 'What should we build?');
  await page.screenshot({ path: path.join(out, 'home.png') });
  check('no page errors', errors.length === 0);
  if (errors.length) console.log(errors.join('\n'));
} finally {
  await app.close();
}
const failed = checks.filter(c => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);