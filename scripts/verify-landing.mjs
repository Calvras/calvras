// Renders the rebuilt landing page at the reference resolution (1280x960)
// and reports element geometry so the layout can be compared to the FLARE ref.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve('.');
const pub = p => pathToFileURL(path.join(root, 'public', p)).href;
const out = path.resolve('.agents/artifacts/landing');
await fs.mkdir(out, { recursive: true });

const ts = await fs.readFile(path.join(root, 'src/lib/landing-html.ts'), 'utf8');
const start = ts.indexOf('`') + 1;
const end = ts.lastIndexOf('`');
let html = ts.slice(start, end);
html = html.split('/calvras-logo.png').join(pub('calvras-logo.png'));
html = html.split('/social-preview.png').join(pub('social-preview.png'));
html = html.split('/calvras-logo.ico').join(pub('calvras-logo.ico'));
const tmp = path.join(out, 'render.html');
await fs.writeFile(tmp, html);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(pathToFileURL(tmp).href);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(out, 'render.png') });

const geo = await page.evaluate(() => {
  const pick = sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    frame: pick('.frame'), topbar: pick('.topbar'), brand: pick('.brand'), nav: pick('.nav'),
    download: pick('.download-pill'), hero: pick('.hero'), eyebrow: pick('.eyebrow'),
    headlineLeft: pick('.headline-left'), headlineRight: pick('.headline-right'),
    heroLogo: pick('.hero-logo'), statCard: pick('.stat-card'), inset: pick('.inset-tile'),
    social: pick('.social-rail'), tagline: pick('.tagline'),
    fontsLoaded: document.fonts.check('600 96px Oswald'),
  };
});
console.log(JSON.stringify(geo, null, 2));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();