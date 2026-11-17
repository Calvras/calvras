import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { _electron as electron } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-upgrade-'));
const out = path.resolve('.agents/artifacts/update-badge');
await fs.mkdir(out, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const packagedExe = process.env.CALVRAS_TEST_EXE;
const app = await electron.launch({ executablePath: packagedExe || path.resolve('node_modules/electron/dist/electron.exe'), args: [...(packagedExe ? [] : ['main.cjs']), '--user-data-dir=' + profile], env, timeout: 60000 });
const checks = [];
const files = new Set();
function check(name, ok) { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
const version = JSON.parse(await fs.readFile('electron-builder.kraken.json', 'utf8')).extraMetadata.version;
const bytes = Buffer.alloc(6 * 1024 * 1024, 42);
bytes.write('MZ');
const sha256 = createHash('sha256').update(bytes).digest('hex');
try {
  await app.evaluate(({ app, shell }, fixture) => {
    global.__originalFetch = global.fetch;
    global.__originalQuit = app.quit;
    global.__version = '99.1.0';
    global.__mode = 'valid';
    global.__openError = 'Fixture: Windows refused setup';
    global.__opened = [];
    global.__downloads = 0;
    global.__quits = 0;
    app.quit = () => { global.__quits++; };
    shell.openPath = async file => { global.__opened.push(file); return global.__openError; };
    global.fetch = async (url, options) => {
      if (url === 'https://api.github.com/repos/Calvras/calvras/releases/latest' || url === 'https://calvras.com/update.json') {
        if (global.__mode === 'offline') throw new Error('Fixture offline');
        const version = global.__version;
        const installer = `https://github.com/Calvras/calvras/releases/download/v${version}/Calvras.Setup.${version}.exe`;
        return new Response(JSON.stringify(url.includes('api.github.com') ? {
          tag_name: 'v' + version,
          assets: [{ name: `Calvras.Setup.${version}.exe`, browser_download_url: installer, digest: 'sha256:' + fixture.sha256 }],
        } : { ok: true, version, installer }), { headers: { 'content-type': 'application/json' } });
      }
      if (String(url).startsWith('https://github.com/Calvras/calvras/releases/download/')) {
        global.__downloads++;
        if (global.__mode === 'missing') return new Response('', { status: 404 });
        if (global.__mode === 'html') return new Response('<html>Not an installer</html>', { headers: { 'content-type': 'text/html' } });
        const bytes = Buffer.alloc(6 * 1024 * 1024, 42);
        bytes.write('MZ');
        const size = global.__mode === 'truncated' ? bytes.length + 100 : bytes.length;
        return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) } });
      }
      return global.__originalFetch(url, options);
    };
  }, { sha256 });
  const page = await app.firstWindow();
  await page.waitForURL('**/signin.html');
  await page.waitForLoadState('domcontentloaded');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const load = async () => {
    await app.evaluate(({ app, BrowserWindow }) => BrowserWindow.getAllWindows()[0].loadFile(app.getAppPath() + '/app.html'));
    await page.waitForSelector('#prompt-input');
    await page.waitForSelector('#app-splash', { state: 'detached', timeout: 6000 });
  };
  await load();
  check('renderer reports actual build version', await page.evaluate(() => getElectronIpc().invoke('app:get-version')) === version);
  const badge = page.locator('#update-badge');
  await badge.waitFor({ state: 'visible' });
  const look = await badge.evaluate(node => {
    const style = getComputedStyle(node);
    return { text: node.textContent.trim(), background: style.backgroundColor, icons: node.querySelectorAll('svg,img').length, drag: style.webkitAppRegion };
  });
  check('button says only upgrade with no icons', look.text === 'upgrade' && look.icons === 0);
  check('button is charcoal grey and accepts title-bar clicks', look.background === 'rgb(48, 48, 48)' && look.drag === 'no-drag');
  await page.screenshot({ path: path.join(out, 'upgrade.png') });

  for (const mode of ['missing', 'html', 'truncated']) {
    await app.evaluate((_electron, mode) => { global.__mode = mode; }, mode);
    await badge.click();
    await page.waitForFunction(() => !document.getElementById('update-badge').disabled && document.getElementById('update-progress-text').textContent.includes('retry'));
    check(`${mode} download reports a retry without launching or quitting`, await app.evaluate(() => global.__opened.length === 0 && global.__quits === 0));
    check(`${mode} failure preserves the upgrade-only button`, (await badge.textContent()).trim() === 'upgrade');
  }

  await app.evaluate(() => { global.__mode = 'valid'; });
  await badge.click();
  await page.waitForFunction(() => !document.getElementById('update-badge').disabled && document.getElementById('update-badge').title.includes('Windows refused'));
  const state = await app.evaluate(() => ({ opened: global.__opened, quits: global.__quits, downloads: global.__downloads }));
  for (const file of state.opened) files.add(file);
  const downloaded = await fs.readFile(state.opened[0]);
  check('real IPC writes every installer byte and reaches Windows shell', downloaded.equals(bytes));
  check('Windows setup failure leaves the app running', state.quits === 0);
  await fs.writeFile(state.opened[0], 'Corrupted setup fixture');
  await app.evaluate(() => { global.__openError = ''; });
  await badge.click();
  await app.evaluate(() => new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (global.__quits) { clearInterval(timer); resolve(); }
      else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('App never quit after setup opened')); }
    }, 20);
  }));
  const retried = await app.evaluate(() => ({ opened: global.__opened, quits: global.__quits, downloads: global.__downloads }));
  for (const file of retried.opened) files.add(file);
  check('retry replaces corrupted setup with a fresh validated download', retried.opened.length === 2 && retried.downloads === state.downloads + 1 && (await fs.readFile(retried.opened[1])).equals(bytes));
  check('successful interactive setup launch quits exactly once', retried.quits === 1);
  check('button stays upgrade while opening setup', (await badge.textContent()).trim() === 'upgrade' && await badge.isDisabled());

  await app.evaluate((_electron, version) => { global.__version = version; }, version);
  await load();
  check('same version shows no upgrade button', await badge.isHidden());
  await app.evaluate(() => { global.__version = '1.0.0'; });
  await load();
  check('older release shows no upgrade button', await badge.isHidden());
  await app.evaluate(() => { global.__mode = 'offline'; });
  await load();
  check('offline check does not invent an update', await badge.isHidden());
  check('no renderer errors', errors.length === 0);
  if (errors.length) console.log(errors);
} finally {
  await app.evaluate(({ app }) => { app.quit = global.__originalQuit; }).catch(() => {});
  await app.close();
  for (const file of files) await fs.rm(file, { force: true });
}
const failed = checks.filter(c => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
