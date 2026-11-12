import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-sidebar-'));
const out = path.resolve('.agents/artifacts/sidebar-nav');
await fs.mkdir(out, { recursive: true });
const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><h1>Reference page</h1>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const testUrl = `http://127.0.0.1:${server.address().port}/`;
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

  check('four nav items, no automations/customizations', await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.primary-nav .nav-item span')].map(s => s.textContent.trim());
    return labels.join('|') === 'New chat|Library|Projects|Plugins';
  }));
  check('chat title removed from top bar', await page.locator('#active-chat-title-wrapper').count() === 0);
  check('brand name removed from sidebar', await page.locator('.sidebar .brand-name').count() === 0);
  check('starts rail-only: drawer collapsed, main flush to rail', await page.evaluate(() => {
    const sb = document.getElementById('sidebar');
    const main = document.querySelector('.main-content');
    return sb.classList.contains('collapsed') && !document.body.classList.contains('sidebar-open')
      && Math.abs(main.getBoundingClientRect().left - 48) < 2;
  }));
  const mainWidthClosed = await page.evaluate(() => document.querySelector('.main-content').getBoundingClientRect().width);

  await page.evaluate(url => {
    const now = Date.now();
    chats.length = 0;
    chats.push(
      { id: 'c1', title: 'Voice chat AI page', workspaceName: 'Dribbble builds', createdAt: now - 8 * 3600e3, updatedAt: now - 8 * 3600e3, messages: [], designReference: { url, title: 'Voice chat AI' } },
      { id: 'c2', title: 'Quarterly report', workspaceName: 'Documents', createdAt: now - 26 * 3600e3, updatedAt: now - 26 * 3600e3, messages: [{ role: 'assistant', content: 'done', trace: [{ tools: [{ kind: 'document', path: 'C:/tmp/report.pdf', title: 'report.pdf', bytes: 2048 }] }] }] },
      { id: 'c3', title: 'Quick question', createdAt: now - 60e3, updatedAt: now - 60e3, messages: [] }
    );
    activeChatId = null;
    renderSidebarHistory();
  }, testUrl);

  await page.locator('#sidebar-uncollapse-btn').click();
  await page.waitForTimeout(450);
  check('sidebar expands', await page.evaluate(() => !document.getElementById('sidebar').classList.contains('collapsed')));
  check('drawer overlays content without shrinking main', await page.evaluate(w => {
    const main = document.querySelector('.main-content');
    const sb = document.getElementById('sidebar').getBoundingClientRect();
    const scrim = getComputedStyle(document.getElementById('sidebar-scrim'));
    return Math.abs(main.getBoundingClientRect().width - w) < 2 && document.body.classList.contains('sidebar-open')
      && sb.left >= 47 && sb.left <= 49 && scrim.opacity === '1' && scrim.pointerEvents === 'auto';
  }, mainWidthClosed));
  check('project folders render with nested chats', await page.evaluate(() => {
    const names = [...document.querySelectorAll('.sidebar-project-row .folder-name')].map(n => n.textContent);
    const kids = document.querySelectorAll('.sidebar-folder-group').length;
    return names.includes('Dribbble builds') && names.includes('Documents') && names.includes('Recents') && kids === 3
      && document.querySelectorAll('.sidebar-folder-children .history-item').length === 3;
  }));
  check('relative timestamps visible and right-aligned', await page.evaluate(() => {
    const row = [...document.querySelectorAll('.history-item')].find(i => i.querySelector('.chat-title').textContent === 'Voice chat AI page');
    const time = row.querySelector('.chat-time');
    const cs = getComputedStyle(time);
    return time.textContent === '8h' && cs.display !== 'none' && time.getBoundingClientRect().right > row.querySelector('.chat-title').getBoundingClientRect().right;
  }));
  await page.screenshot({ path: path.join(out, 'sidebar.png') });

  await page.locator('.sidebar-folder-group .folder-chevron').first().click();
  check('chevron collapses folder children', await page.evaluate(() => {
    const group = document.querySelector('.sidebar-folder-group');
    return group.classList.contains('collapsed') && getComputedStyle(group.querySelector('.sidebar-folder-children')).display === 'none';
  }));
  await page.locator('.sidebar-folder-group .folder-chevron').first().click();
  check('chevron re-expands folder', await page.evaluate(() => !document.querySelector('.sidebar-folder-group').classList.contains('collapsed')));
  await page.locator('.sidebar-project-row').first().click();
  check('folder row selects project', await page.evaluate(() => activeWorkspaceName === 'Dribbble builds' && document.querySelector('.sidebar-project-row').classList.contains('active')));

  await page.locator('#btn-projects-nav').click();
  check('Projects nav opens project picker', await page.evaluate(() => document.getElementById('project-selector-popover').style.display === 'block'));
  await page.locator('#btn-projects-nav').click();
  check('Projects nav closes picker again', await page.evaluate(() => document.getElementById('project-selector-popover').style.display === 'none'));

  await page.locator('#btn-library-nav').click();
  check('Library overlay lists reference + document', await page.evaluate(() => {
    const overlay = document.getElementById('library-plugins-overlay');
    const titles = [...overlay.querySelectorAll('.lp-item-title')].map(t => t.textContent);
    return overlay.style.display === 'flex' && titles.includes('Voice chat AI') && titles.includes('report.pdf')
      && document.getElementById('btn-library-nav').classList.contains('active');
  }));
  await page.locator('#lp-search-input').fill('report');
  check('library search filters', await page.locator('.lp-item').count() === 1);
  await page.locator('#lp-search-input').fill('');
  await page.screenshot({ path: path.join(out, 'library.png') });
  await page.locator('.lp-item').first().click();
  check('reference item opens live preview', await page.evaluate(url => {
    return document.getElementById('library-plugins-overlay').style.display === 'none' && isLivePreviewOpen();
  }, testUrl));
  await page.waitForFunction(() => !document.getElementById('preview-panel').getAnimations().length);
  check('preview split ignores the drawer scrim', await page.evaluate(() => {
    const preview = document.getElementById('preview-panel').getBoundingClientRect().width;
    const chat = document.querySelector('.main-content').getBoundingClientRect().width;
    return Math.abs(preview / (preview + chat) - 0.6) < 0.01;
  }));
  await page.evaluate(() => window.closeLivePreview());

  await page.locator('#btn-plugins-nav').click();
  check('Plugins overlay shows four real switches', await page.evaluate(() => {
    const names = [...document.querySelectorAll('.lp-plugin-name')].map(n => n.textContent);
    return document.getElementById('library-plugins-overlay').style.display === 'flex' && names.length === 4
      && document.querySelectorAll('.lp-switch').length === 4;
  }));
  await page.screenshot({ path: path.join(out, 'plugins.png') });
  const webSwitch = page.locator('.lp-plugin', { hasText: 'Web search & browsing' }).locator('.lp-switch');
  check('web plugin starts enabled', await webSwitch.getAttribute('aria-checked') === 'true');
  await webSwitch.click();
  check('web toggle persists and gates the agent prompt', await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('calvras_plugins') || '{}');
    return stored.web === false && !pluginEnabled('web') && buildAgentSystemPrompt([]).includes('Disabled plugins');
  }));
  check('disabled plugin blocks its tool kinds', await page.evaluate(async () => {
    const result = await executeAgentBlock({ kind: 'web', arg: 'test query', body: '' }, null, {});
    return result.failed === true && /plugin is turned off/.test(result.node.error || '');
  }));
  await webSwitch.click();
  check('re-enabling restores capability', await page.evaluate(() => pluginEnabled('web') && !buildAgentSystemPrompt([]).includes('Disabled plugins')));
  check('pet switch mirrors real pet state', await page.evaluate(() => {
    const row = [...document.querySelectorAll('.lp-plugin')].find(p => p.querySelector('.lp-plugin-name').textContent === 'Desktop pet');
    return row.querySelector('.lp-switch').getAttribute('aria-checked') === String(petEnabled);
  }));
  await page.keyboard.press('Escape');
  check('Escape closes overlay and restores nav state', await page.evaluate(() => document.getElementById('library-plugins-overlay').style.display === 'none' && document.getElementById('btn-new-chat').classList.contains('active')));

  await page.locator('#search-btn').click();
  await page.locator('#sidebar-search-input').fill('quarterly');
  check('conversation search still filters rows', await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.history-item')];
    const visible = rows.filter(r => r.style.display !== 'none');
    return visible.length === 1 && visible[0].querySelector('.chat-title').textContent === 'Quarterly report';
  }));
  await page.locator('#search-btn').click();

  await page.locator('.history-item', { hasText: 'Quick question' }).locator('.chat-title').click();
  check('clicking a chat row opens it without deleting', await page.evaluate(() => activeChatId === 'c3' && chats.length === 3));
  check('opening a chat slides the drawer away', await page.evaluate(() => document.getElementById('sidebar').classList.contains('collapsed') && !document.body.classList.contains('sidebar-open')));

  // Drawer close/open paths: topbar toggle, rail toggle, scrim, Escape, rail search
  await page.locator('#sidebar-uncollapse-btn').click();
  await page.waitForTimeout(450);
  await page.locator('#sidebar-toggle-btn').click();
  await page.waitForTimeout(400);
  check('sidebar collapses from topbar toggle', await page.evaluate(() => document.getElementById('sidebar').classList.contains('collapsed') && !document.body.classList.contains('sidebar-open')));

  await page.locator('#rail-sidebar-btn').click();
  await page.waitForTimeout(450);
  check('rail toggle slides drawer back out', await page.evaluate(() => !document.getElementById('sidebar').classList.contains('collapsed') && document.body.classList.contains('sidebar-open')));
  const scrimPoint = await page.evaluate(() => { const r = document.querySelector('.main-content').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 120 }; });
  await page.mouse.click(scrimPoint.x, scrimPoint.y);
  await page.waitForTimeout(400);
  check('scrim click closes drawer', await page.evaluate(() => document.getElementById('sidebar').classList.contains('collapsed') && !document.body.classList.contains('sidebar-open')));

  await page.locator('#rail-sidebar-btn').click();
  await page.waitForTimeout(450);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('Escape closes drawer', await page.evaluate(() => document.getElementById('sidebar').classList.contains('collapsed')));

  await page.locator('#rail-recents-btn').click();
  await page.waitForTimeout(450);
  check('rail search opens drawer with search box focused', await page.evaluate(() => {
    const box = document.getElementById('sidebar-search-box');
    return !document.getElementById('sidebar').classList.contains('collapsed') && box.style.display === 'block'
      && document.activeElement === document.getElementById('sidebar-search-input');
  }));
  await page.locator('#sidebar-toggle-btn').click();
  await page.waitForTimeout(400);

  // Terminal docks on the right side of the chat column
  const mainBeforeTerm = await page.evaluate(() => document.querySelector('.main-content').getBoundingClientRect().width);
  await page.locator('#terminal-toggle-btn').click();
  await page.waitForTimeout(400);
  check('terminal opens docked right of chat at full height', await page.evaluate(w => {
    const t = document.getElementById('terminal-panel');
    const main = document.querySelector('.main-content');
    const tr = t.getBoundingClientRect(); const mr = main.getBoundingClientRect();
    return t.style.display === 'flex' && tr.left >= mr.right - 1 && Math.abs(tr.height - window.innerHeight) < 2
      && mr.width < w - 100 && document.getElementById('terminal-toggle-btn').classList.contains('active');
  }, mainBeforeTerm));
  await page.locator('#terminal-input').fill('echo hello');
  await page.locator('#terminal-input').press('Enter');
  await page.waitForTimeout(250);
  check('terminal command executes and reports state', await page.evaluate(() => document.getElementById('terminal-output').textContent.includes('No workspace selected')));
  await page.screenshot({ path: path.join(out, 'terminal.png') });
  await page.keyboard.press('Control+`');
  await page.waitForTimeout(300);
  check('Ctrl+` closes dock and restores chat width', await page.evaluate(w => {
    const t = document.getElementById('terminal-panel');
    return t.style.display === 'none' && Math.abs(document.querySelector('.main-content').getBoundingClientRect().width - w) < 2;
  }, mainBeforeTerm));
  await page.keyboard.press('Control+`');
  await page.waitForTimeout(300);
  await page.locator('#terminal-close-btn').click();
  check('terminal close button hides dock', await page.evaluate(() => document.getElementById('terminal-panel').style.display === 'none'));

  check('rail keeps four navs + avatar, settings slider removed', await page.evaluate(() => {
    const ids = [...document.querySelectorAll('#codex-rail .rail-btn')].map(b => b.id);
    return ids.join('|') === 'rail-home-btn|rail-sidebar-btn|rail-recents-btn|rail-projects-btn'
      && !document.getElementById('settings-btn') && !document.querySelector('.rail-divider')
      && !!document.getElementById('user-profile-btn');
  }));
  await page.screenshot({ path: path.join(out, 'rail.png') });
  await page.keyboard.press('Control+,');
  check('Ctrl+, opens settings dialog', await page.evaluate(() => document.getElementById('settings-modal').style.display === 'flex'));
  await page.keyboard.press('Control+,');
  check('Ctrl+, closes settings dialog again', await page.evaluate(() => document.getElementById('settings-modal').style.display === 'none'));
  await page.evaluate(() => document.getElementById('env-settings-btn').click());
  check('workspace gear still opens settings', await page.evaluate(() => document.getElementById('settings-modal').style.display === 'flex'));
  await page.locator('#close-settings-modal').click();
  check('settings close button hides dialog', await page.evaluate(() => document.getElementById('settings-modal').style.display === 'none'));

  check('no page errors', errors.length === 0);
  if (errors.length) console.log(errors.join('\n'));
} finally {
  await app.close();
  server.close();
}
const failed = checks.filter(c => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);