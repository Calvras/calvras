// Renders the landing page (image-replica-studio clone) and reports geometry
// so the layout can be checked against the reference repo's Tailwind layout.
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
html = html.split('src="/calvras-logo.png"').join('src="' + pub('calvras-logo.png') + '"');
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
    header: pick('header'), brandMark: pick('.brand-mark'), nav: pick('nav'),
    pillOutline: pick('.pill-outline'), hero: pick('.hero'), h1: pick('h1'),
    sub: pick('.sub'), testi: pick('.testi'), pillBlack: pick('.pill-black'),
    heroRight: pick('.hero-right'), portrait: pick('.portrait'), chipFit: pick('.chip-fit'),
    chipDesign: pick('.chip-design'), play: pick('.play'), glassStat: pick('.glass-stat'),
    glassProduct: pick('.glass-product'), logos: pick('.logos'),
    fontsLoaded: document.fonts.check('600 16px Fraunces') && document.fonts.check('700 16px Manrope'),
    downloadHrefs: [...document.querySelectorAll('a[href*="releases/download"]')].map(a => a.href),
  };
});
console.log(JSON.stringify(geo, null, 2));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();