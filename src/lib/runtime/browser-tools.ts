import type { Browser, BrowserContext, Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeProjectPath } from './file-tools';
import { CLEAR_MARKS_SOURCE, COLLECT_TARGETS_SOURCE, PAGE_MEDIA_SOURCE, formatTargets, targetSummary, type PageView } from './page-localizer';

// Loaded only when a browser tool actually runs, and kept out of the bundle: the hosted build has no
// browser to launch, and dragging playwright (plus the electron it references) into the server output
// costs ~7 MB and a 269 MB file lock. prepare-electron-runtime.mjs ships the real package beside the
// desktop server so this import resolves from disk there.
async function launchChromium() {
  const specifier = 'playwright';
  const { chromium } = (await import(/* @vite-ignore */ specifier)) as typeof import('playwright');
  return chromium.launch({ headless: true });
}

export const BROWSER_TOOLS = ['open_browser', 'navigate_browser', 'take_screenshot', 'click_element', 'fill_input', 'inspect_element', 'check_console_errors', 'test_responsive_layout', 'read_page', 'scroll_page', 'press_page_key', 'go_back', 'wait_for_element', 'upload_file_to_page', 'run_page_script', 'click_at', 'hover_at', 'drag_at', 'type_into_page'];
type Session = { context: BrowserContext; page: Page; errors: string[]; allowedOrigins: Set<string>; externalNetworkApproved: boolean };
const sessions = new Map<string, Promise<Session>>();
const queues = new Map<string, Promise<unknown>>();
let browser: Promise<Browser> | undefined;

function webUrl(input: unknown): string {
  const url = new URL(String(input ?? ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Browser URLs must use HTTP or HTTPS without embedded credentials.');
  return url.href;
}

async function getSession(projectPath: string): Promise<Session> {
  const key = path.resolve(projectPath);
  if (!sessions.has(key)) {
    const pending = (async () => {
      browser ??= launchChromium().catch((error) => {
        browser = undefined;
        throw new Error(`Browser launch failed. Install the browser with npx playwright install chromium. ${error.message}`);
      });
      const context = await (await browser).newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: 'block' });
      const allowedOrigins = new Set<string>();
      let session: Session;
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      cdp.on('Fetch.requestPaused', async (event) => {
        const requestUrl = new URL(event.request.url);
        const protocol = requestUrl.protocol;
        if (!['http:', 'https:', 'data:', 'blob:'].includes(protocol)) { await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); return; }
        if (['http:', 'https:'].includes(protocol) && !session.externalNetworkApproved && !allowedOrigins.has(requestUrl.origin)) {
          session.errors.push(`Blocked unapproved browser origin: ${requestUrl.origin}`);
          if (session.errors.length > 200) session.errors.shift();
          await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
          return;
        }
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
      });
      context.on('page', (newPage) => { if (newPage !== page) void newPage.close(); });
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(20_000);
      const errors: string[] = [];
      const remember = (value: string) => { errors.push(value); if (errors.length > 200) errors.shift(); };
      page.on('pageerror', (error) => remember(error.message));
      page.on('console', (message) => { if (message.type() === 'error') remember(message.text()); });
      page.on('dialog', (dialog) => { void dialog.dismiss(); });
      session = { context, page, errors, allowedOrigins, externalNetworkApproved: false };
      return session;
    })();
    sessions.set(key, pending);
    pending.catch(() => sessions.delete(key));
  }
  return sessions.get(key)!;
}

async function screenshot(page: Page, fullPage = true) {
  const directory = path.join(tmpdir(), 'calvras-browser-artifacts');
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${randomUUID()}.png`);
  const bytes = await page.screenshot({ path: filePath, fullPage, timeout: 15_000 });
  return { path: filePath, mimeType: 'image/png', image: `data:image/png;base64,${bytes.toString('base64')}` };
}

/** A coordinate the model read off its own numbered screenshot, checked before it reaches the mouse. */
function point(args: Record<string, unknown>, xKey = 'x', yKey = 'y') {
  const x = Number(args[xKey]);
  const y = Number(args[yKey]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 20000 || y > 20000) {
    throw new Error(`${xKey} and ${yKey} must be coordinates from the numbered screenshot. Take one with take_screenshot if you do not have them.`);
  }
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Number the clickable things, capture the page with the numbers on it, then take them back off.
 * A viewport capture is the default because that is the space its own coordinates live in.
 */
async function captureView(page: Page, fullPage: boolean) {
  const view = fullPage ? null : (await page.evaluate(COLLECT_TARGETS_SOURCE)) as PageView;
  const shot = await screenshot(page, fullPage);
  if (view) await page.evaluate(CLEAR_MARKS_SOURCE).catch(() => {});
  const framing = fullPage
    ? { framing: 'whole page — nothing is numbered here, and click_at needs a viewport capture. Take the default take_screenshot to act on the page.' }
    : { framing: 'viewport — every numbered box below is inside this image at the coordinates given, so click_at can use them as they are.' };
  return { ...shot, ...framing, view: targetSummary(view), ...(view ? { numbered: formatTargets(view) } : {}) };
}

/** The runtime must authorize network access before calling this executor. */
export async function executeBrowserTool(type: string, args: Record<string, unknown>, projectPath: string): Promise<any> {
  // A project owns one page. Serialize its actions to prevent concurrent agents
  // navigating away while another action is filling or inspecting that page.
  const key = path.resolve(projectPath);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => executeAction(type, args, projectPath));
  queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}

async function executeAction(type: string, args: Record<string, unknown>, projectPath: string): Promise<any> {
  if (!BROWSER_TOOLS.includes(type)) throw new Error(`Unknown browser tool: ${type}`);
  if (args['url'] !== undefined) webUrl(args['url']);
  const session = await getSession(projectPath);
  const { page, errors } = session;
  if (type === 'open_browser' || type === 'navigate_browser') {
    const url = webUrl(args['url']);
    session.allowedOrigins.clear();
    session.allowedOrigins.add(new URL(url).origin);
    session.externalNetworkApproved = args['externalNetworkApproved'] === true;
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    return { url: page.url(), title: await page.title(), status: response?.status() ?? null };
  }
  if (page.url() === 'about:blank') throw new Error('Open a website with open_browser before using this tool.');
  if (type === 'take_screenshot') return { ok: true, ...await captureView(page, args['fullPage'] === true) };
  if (type === 'read_page') {
    const pageData = await page.evaluate(() => ({
      title: document.title, url: location.href,
      text: (document.body?.innerText ?? '').slice(0, 30000),
      links: [...document.querySelectorAll('a[href]')].slice(0, 80).map((anchor) => ({ text: (anchor.textContent ?? '').trim().slice(0, 120), href: (anchor as HTMLAnchorElement).href })),
    }));
    const media = await page.evaluate(PAGE_MEDIA_SOURCE).catch(() => null);
    return { ok: true, ...pageData, ...(media ? { media } : {}) };
  }
  if (type === 'click_at') {
    const at = point(args);
    // Travel to the spot instead of teleporting: menus, tooltips and card hover states only open
    // when the pointer actually passes over them, which is what a person on a laptop gets.
    await page.mouse.move(at.x, at.y, { steps: 10 });
    await page.mouse.click(at.x, at.y, {
      button: String(args['button']).toLowerCase() === 'right' ? 'right' : 'left',
      clickCount: args['double'] === true || Number(args['clicks']) >= 2 ? 2 : 1,
    });
    await page.waitForTimeout(400);
    return { ok: true, clicked: at, url: page.url(), title: await page.title() };
  }
  if (type === 'hover_at') {
    const at = point(args);
    await page.mouse.move(at.x, at.y, { steps: 10 });
    await page.waitForTimeout(250);
    return { ok: true, hovered: at, url: page.url() };
  }
  if (type === 'drag_at') {
    const from = point(args, 'fromX', 'fromY');
    const to = point(args, 'toX', 'toY');
    await page.mouse.move(from.x, from.y, { steps: 6 });
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 14 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(300);
    return { ok: true, from, to, url: page.url() };
  }
  if (type === 'type_into_page') {
    const text = String(args['text'] ?? args['value'] ?? '');
    if (!text) throw new Error('Provide the text to type into the focused field.');
    if (text.length > 6000) throw new Error('Keep typed text under 6000 characters.');
    await page.keyboard.type(text, { delay: 12 });
    await page.waitForTimeout(200);
    return { ok: true, typed: text.length, url: page.url() };
  }
  if (type === 'run_page_script') {
    const code = String(args['code'] || '');
    if (!code.trim()) throw new Error('Provide the JavaScript to run in the page.');
    // Playwright evaluates the expression in page context; the body must return a
    // JSON-serializable value, which the agent reads back as `result`.
    const value = await page.evaluate(`(async () => { ${code} })()`);
    return { ok: true, url: page.url(), result: value ?? null };
  }
  if (type === 'scroll_page') {
    const amount = Math.min(Math.max(Number(args['amount']) || 650, 50), 8000);
    await page.mouse.wheel(0, String(args['direction']).toLowerCase() === 'up' ? -amount : amount);
    return { ok: true, scrolled: String(args['direction']).toLowerCase() === 'up' ? 'up' : 'down', amount };
  }
  if (type === 'press_page_key') {
    if (typeof args['keys'] !== 'string' || !args['keys'].trim()) throw new Error('Provide keys to press, for example Enter or Control+A.');
    const keys = args['keys'].split('+').map((part) => {
      const key = part.trim().toLowerCase();
      const named: Record<string, string> = { ctrl: 'Control', control: 'Control', cmd: 'Meta', meta: 'Meta', alt: 'Alt', shift: 'Shift', enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space', backspace: 'Backspace', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End' };
      const word = key.replace(/[^a-z0-9]/g, "");
      return named[key] || (word.length === 1 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1));
    });
    if (keys.length > 5) throw new Error('Provide at most 5 keys joined with +.');
    await page.keyboard.press(keys.join('+'));
    return { ok: true, keys: args['keys'] };
  }
  if (type === 'go_back') {
    const response = await page.goBack({ waitUntil: 'domcontentloaded' });
    return { ok: true, url: page.url(), title: await page.title(), status: response?.status() ?? null };
  }
  if (type === 'wait_for_element') {
    const selector = String(args['selector'] ?? '');
    if (!selector) throw new Error('A selector is required.');
    const timeout = Math.min(Math.max(Number(args['timeoutMs']) || 15000, 1000), 60000);
    await page.locator(selector).first().waitFor({ state: 'visible', timeout });
    return { ok: true, selector, url: page.url() };
  }
  if (type === 'upload_file_to_page') {
    const selector = String(args['selector'] ?? '');
    if (!selector) throw new Error('A selector is required.');
    if (typeof args['path'] !== 'string' || !args['path'].trim()) throw new Error('Provide the file path inside the workspace.');
    const target = await safeProjectPath(projectPath, args['path']);
    await page.locator(selector).first().setInputFiles(target);
    return { ok: true, selector, uploaded: args['path'], url: page.url() };
  }
  if (type === 'check_console_errors') {
    const result = [...errors];
    if (args['clear'] === true) errors.length = 0;
    return { url: page.url(), errors: result, count: result.length };
  }
  if (type === 'test_responsive_layout') {
    const widths = Array.isArray(args['widths']) ? args['widths'].map(Number) : [375, 768, 1280];
    if (!widths.length || widths.length > 8 || widths.some((width) => !Number.isInteger(width) || width < 240 || width > 3840)) throw new Error('Provide 1–8 integer widths between 240 and 3840.');
    const previous = page.viewportSize();
    const layouts = [];
    try {
      for (const width of widths) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const dimensions = await page.evaluate(() => ({ viewportWidth: innerWidth, contentWidth: document.documentElement.scrollWidth, horizontalOverflow: document.documentElement.scrollWidth > innerWidth }));
        layouts.push({ width, ...dimensions, ...await screenshot(page) });
      }
    } finally { if (previous) await page.setViewportSize(previous); }
    return { layouts, consoleErrors: [...errors] };
  }
  const selector = String(args['selector'] ?? '');
  if (!selector || selector.length > 2000) throw new Error('A selector is required.');
  const locator = page.locator(selector).first();
  if (type === 'click_element') {
    await locator.click();
    return { clicked: selector, url: page.url() };
  }
  if (type === 'fill_input') {
    await locator.fill(String(args['value'] ?? args['text'] ?? ''));
    return { filled: selector };
  }
  return locator.evaluate((element) => { const field = element as HTMLElement & { value?: unknown; checked?: unknown; disabled?: unknown; placeholder?: unknown }; return ({ tag: element.tagName.toLowerCase(), text: (element.textContent ?? '').slice(0, 12000), html: element.outerHTML.slice(0, 20000), attributes: Object.fromEntries([...element.attributes].map((attr) => [attr.name, attr.value])), value: field.value ?? null, checked: field.checked ?? null, disabled: field.disabled ?? null, placeholder: field.placeholder ?? null, bounds: element.getBoundingClientRect().toJSON(), styles: { display: getComputedStyle(element).display, color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor } }); });
}

export async function closeBrowserSessions(projectPath?: string): Promise<void> {
  if (projectPath) {
    const key = path.resolve(projectPath);
    const session = sessions.get(key);
    sessions.delete(key);
    if (session) await (await session).context.close();
    return;
  }
  const pending = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(pending.map(async (session) => (await session).context.close()));
  const active = browser;
  browser = undefined;
  if (active) await (await active).close();
}
