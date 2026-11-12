import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-links-'));
const out = path.resolve('.agents/artifacts/reply-links');
await fs.mkdir(out, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['main.cjs', '--user-data-dir=' + profile], env, timeout: 60000 });
const checks = [];
const check = (name, ok) => { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve('app.html')).href);
  await page.waitForSelector('#prompt-input');
  const result = await page.evaluate(() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:600px;background:#181716;color:#e7e5e4;padding:20px;z-index:9999';
    document.body.appendChild(host);
    const render = text => { host.innerHTML = formatMarkdown(text); return host; };
    const links = () => [...host.querySelectorAll('a.md-link')];
    const out = {};

    render('Docs live at https://calvras.com today.');
    out.bare = links().length === 1 && links()[0].href === 'https://calvras.com/' && links()[0].textContent === 'https://calvras.com' && links()[0].target === '_blank';

    render('Visit https://calvras.com.');
    out.trailingDot = links().length === 1 && links()[0].href === 'https://calvras.com/' && host.textContent.trim() === 'Visit https://calvras.com.';

    render('See https://calvras.com, then https://example.com/a?b=1; done.');
    out.trailingPunct = links().length === 2 && links()[0].href === 'https://calvras.com/' && links()[1].href === 'https://example.com/a?b=1';

    render('[Calvras](https://calvras.com) and <https://example.com>');
    out.markdownAndAngle = links().length === 2 && links()[0].textContent === 'Calvras' && links()[0].href === 'https://calvras.com/' && links()[1].href === 'https://example.com/';

    render('Inline `https://code.example.com` stays code.');
    out.inlineCodeNotLinked = links().length === 0 && !!host.querySelector('code.inline-code');

    render('```\nhttps://fenced.example.com\n```');
    out.fencedNotLinked = links().length === 0 && !!host.querySelector('pre code');

    render('javascript:alert(1) and https://ok.example.com');
    out.unsafeNotLinked = links().length === 1 && links()[0].href === 'https://ok.example.com/' && !host.innerHTML.includes('href="javascript:');

    render('Wiki https://en.wikipedia.org/wiki/Foo_(bar) page.');
    out.balancedParens = links().length === 1 && links()[0].href === 'https://en.wikipedia.org/wiki/Foo_(bar)';

    render('https://calvras.com');
    const a = links()[0];
    const cs = getComputedStyle(a);
    out.style = cs.textDecorationLine.includes('underline') && cs.textDecorationColor === 'rgb(138, 133, 128)' && cs.cursor === 'pointer';
    out.styleSnapshot = { line: cs.textDecorationLine, color: cs.textDecorationColor, linkColor: cs.color };

    host.innerHTML = formatMarkdown('Calvras ships from https://calvras.com — read the [docs](https://calvras.com/docs).');
    return out;
  });
  for (const key of ['bare', 'trailingDot', 'trailingPunct', 'markdownAndAngle', 'inlineCodeNotLinked', 'fencedNotLinked', 'unsafeNotLinked', 'balancedParens', 'style']) {
    check('reply links: ' + key, result[key]);
  }
  console.log('style snapshot', JSON.stringify(result.styleSnapshot));
  await page.screenshot({ path: path.join(out, 'links.png') });
  check('no renderer errors', errors.length === 0);
  if (errors.length) console.log(errors);
} finally {
  await app.close();
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2));
  console.log(`${checks.filter(c => c.ok).length}/${checks.length} passed`);
  if (checks.some(c => !c.ok)) process.exitCode = 1;
}