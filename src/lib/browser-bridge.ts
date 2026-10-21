import { pixelDiffScript, summarizeFidelity } from "./image-fidelity";
import { CLEAR_MARKS_SOURCE, COLLECT_TARGETS_SOURCE, FIRST_SCREEN_SOURCE, PAGE_MEDIA_SOURCE, formatTargets, targetSummary, type PageView } from "./runtime/page-localizer";

/**
 * Drives the visible <webview> browser panel from the same tool calls the agent
 * uses in the headless runtime. Only Electron exposes __electron; in a plain
 * browser preview these actions continue through RuntimeClient instead.
 */

type WebviewElement = HTMLElement & {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  getWebContentsId(): number;
  executeJavaScript(code: string): Promise<any>;
  sendInputEvent(event: any): void;
  insertCSS(css: string): Promise<string>;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
};

export type BrowserSnapshot = {
  attached: boolean;
  ready: boolean;
  url: string;
  title: string;
  loading: boolean;
};

const IN_APP_BROWSER_TOOLS = new Set([
  "open_browser", "navigate_browser", "read_page", "take_screenshot", "click_element",
  "fill_input", "inspect_element", "check_console_errors", "scroll_page", "press_page_key",
  "go_back", "wait_for_element", "upload_file_to_page", "run_page_script",
  "click_at", "hover_at", "drag_at", "type_into_page",
]);

export function isInAppBrowserTool(type: string): boolean {
  return IN_APP_BROWSER_TOOLS.has(type);
}

export function hasInAppBrowser(): boolean {
  return typeof window !== "undefined" && Boolean((window as any).__electron?.browserCapturePage);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PAGE_DEADLINE_MS = 45_000;

/** Resolves with whatever the panel answers within the deadline, and with an error the agent can act on if it never does. */
function within<T>(pending: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([pending, deadline]).finally(() => {
    clearTimeout(timer);
    // A result that lands after the deadline belongs to a round the run already moved past.
    pending.catch(() => {});
  });
}

/**
 * A page that stops answering must never strand a run that has hours of work left. Every evaluation
 * sent into the panel gets this deadline, so a wedged page — a script of its own that never returns,
 * a main thread stuck in a loop — comes back as a readable tool error the agent can route around,
 * instead of an await that hangs the turn forever.
 */
function evalInPage(element: WebviewElement, source: string, timeoutMs = PAGE_DEADLINE_MS): Promise<any> {
  return within(element.executeJavaScript(source), timeoutMs, `The page in the browser panel did not answer within ${Math.round(timeoutMs / 1000)}s. It is stuck inside its own script: stop waiting on it, reload the address with open_browser, and work the page with click_at and fill_input.`);
}

/** The page handle the browser tools work through: the element itself, with bounded evaluations. */
function withPageDeadline(element: WebviewElement): WebviewElement {
  return new Proxy(element, {
    get(target, property) {
      if (property === "executeJavaScript") return (source: string) => evalInPage(target, source);
      const value = (target as any)[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function webUrl(input: unknown): string {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("A website URL is required.");
  const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Browser URLs must use HTTP or HTTPS without embedded credentials.");
  }
  return url.href;
}

const KEY_NAMES: Record<string, string> = {
  ctrl: "Control", control: "Control", cmd: "Meta", meta: "Meta", alt: "Alt", shift: "Shift",
  enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", tab: "Tab", space: "Space",
  backspace: "Backspace", delete: "Delete", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft",
  right: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  pageup: "PageUp", pagedown: "PageDown", home: "Home", end: "End",
};

/** A pointer position the model read off its own numbered screenshot, checked before it reaches the mouse. */
function spot(args: Record<string, any>, xKey = "x", yKey = "y") {
  const x = Number(args[xKey]);
  const y = Number(args[yKey]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 20000 || y > 20000) {
    throw new Error(`${xKey} and ${yKey} must be coordinates from the numbered screenshot. Take one with take_screenshot if you do not have them.`);
  }
  return { x: Math.round(x), y: Math.round(y) };
}

/** The page-side body of `fill_input`, kept as a function so the dropdown, tick-box and date
 * matching can be run against a real form in a test instead of only inside a live webview. */
/** The page's own words: headings, alerts and the visible text, for a result that has to answer
 * without another model round just to look. */
export function proseScript(): string {
  return "(() => { const clean = (v) => String(v ?? '').replace(/\\s+/g, ' ').trim(); const words = () => clean((document.body?.innerText || document.body?.textContent) ?? ''); return { headings: clean(Array.from(document.querySelectorAll('h1,h2,h3,[role=alert],.error,.success,.receipt')).map((n) => n.textContent).join(' | ')).slice(0, 600), text: words().slice(0, 1800) }; })()";
}

export function fillScript(selector: string, value: string): string {
  const literal = JSON.stringify(selector);
  const text = JSON.stringify(value);
  return `(() => {
  const target = document.querySelector(${literal});
  if (!target) throw new Error("No element matches " + ${literal});
  if (target.scrollIntoView) target.scrollIntoView({ block: "center", inline: "center" });
  target.focus();
  const value = ${text};
  const wanted = value.trim().toLowerCase();
  if (target instanceof HTMLSelectElement) {
    // A select ignores the input value setter entirely, so the form would silently
    // submit its default option. Match on the option's value or its visible label.
    const labels = (option) => (option.textContent || "").trim().toLowerCase();
    const choice = [...target.options].find((option) => (option.value || "").toLowerCase() === wanted || labels(option) === wanted)
      || [...target.options].find((option) => labels(option).includes(wanted) || (wanted.length > 2 && wanted.includes(labels(option))));
    if (!choice) throw new Error(${literal} + " is a dropdown with these options: " + ([...target.options].map((option) => (option.textContent || "").trim() || option.value).join(" | ") || "none") + ". Pick one of those.");
    target.value = choice.value;
  } else if (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio")) {
    // Ticking means changing "checked" — writing value would submit the box still unticked,
    // which is how a consent checkbox ends up silently unagreed.
    const tick = ["true", "on", "yes", "check", "checked", "1"].includes(wanted);
    const untick = ["false", "off", "no", "uncheck", "unchecked", "0"].includes(wanted);
    const groupLabel = ((target.labels && target.labels[0] ? target.labels[0].textContent : "") || target.getAttribute("aria-label") || "").trim().toLowerCase();
    if (target.type === "radio" && wanted && !tick && !untick && (wanted === (target.value || "").toLowerCase() || (wanted.length > 2 && (groupLabel.includes(wanted) || wanted.includes(groupLabel))))) target.checked = true;
    else if (tick) target.checked = true;
    else if (untick) target.checked = false;
    else throw new Error(${literal} + " is a " + target.type + ", currently " + (target.checked ? "ticked" : "unticked") + ". Fill it with \\"on\\" to tick it" + (target.type === "checkbox" ? " or \\"off\\" to clear it" : ", or with the option label you want selected") + ".");
  } else if (target.isContentEditable) {
    target.textContent = value;
  } else {
    const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(target, value); else target.value = value;
  }
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
  const format = target instanceof HTMLInputElement ? (target.type || "text") : target.tagName.toLowerCase();
  if (["date", "datetime-local", "month", "week", "time", "number"].includes(format) && target.value !== value.trim()) {
    throw new Error(${literal} + " kept \\"" + target.value + "\\" instead of \\"" + value + "\\"; a " + format + " field needs its exact format (for example 2026-11-14 or 19:30).");
  }
  return { tag: target.tagName.toLowerCase(), type: format, value: target.value ?? target.textContent, checked: target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio") ? target.checked : undefined };
})()`;
}

class BrowserBridge {
  private element: WebviewElement | null = null;
  private cleanups: (() => void)[] = [];
  private errors: string[] = [];
  private errorCursor = 0;
  private listeners = new Set<() => void>();
  private snapshot: BrowserSnapshot = { attached: false, ready: false, url: "", title: "", loading: false };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): BrowserSnapshot => this.snapshot;

  private update(patch: Partial<BrowserSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private rememberError(message: string) {
    if (!message.trim()) return;
    this.errors.push(message.slice(0, 4000));
    if (this.errors.length > 200) {
      this.errors.shift();
      if (this.errorCursor > 0) this.errorCursor -= 1;
    }
  }

  attach(element: WebviewElement | null) {
    if (!element || this.element === element) return;
    this.detachAll();
    this.element = element;
    this.update({ attached: true });
    const on = (name: string, handler: (...args: any[]) => void) => {
      element.addEventListener(name, handler as EventListener);
      this.cleanups.push(() => element.removeEventListener(name, handler as EventListener));
    };
    const applySelectionCss = () => {
      try { void element.insertCSS("::selection{background:rgba(59,130,246,.35)}").catch(() => {}); }
      catch { /* the webview is not ready for injection yet */ }
    };
    on("dom-ready", () => {
      this.update({ ready: true, url: element.getURL(), title: element.getTitle() });
      applySelectionCss();
    });
    on("did-start-loading", () => this.update({ loading: true }));
    on("did-stop-loading", () => this.update({ loading: false, url: element.getURL(), title: element.getTitle() }));
    on("did-navigate", (event: any) => this.update({ url: event?.url || element.getURL(), title: element.getTitle() }));
    on("did-navigate-in-page", (event: any) => this.update({ url: event?.url || element.getURL() }));
    on("page-title-updated", (event: any) => this.update({ title: event?.title || element.getTitle() }));
    on("console-message", (event: any, level?: number | string, message?: string) => {
      const severity = typeof level === "string" ? level : event?.level ?? level;
      const text = message ?? event?.message ?? "";
      if (severity === "error" || severity === 3) this.rememberError(text);
    });
    on("did-fail-load", (event: any) => {
      if (event?.isMainFrame === false) return;
      if (event?.errorCode === -3) return; // aborted: redirects and cancelled loads
      this.rememberError(`${event?.errorDescription || "Load failed"} ${event?.validatedURL || ""}`.trim());
      this.update({ loading: false, url: element.getURL(), title: element.getTitle() });
    });
    on("render-process-gone", (event: any) => this.rememberError(`The browser page crashed: ${event?.details?.reason || "unknown reason"}`));
    on("new-window", (event: any) => {
      const url = event?.url;
      if (typeof url === "string" && /^https?:/i.test(url)) {
        event.preventDefault?.();
        void element.loadURL(url).catch((error) => this.rememberError(error?.message || "Could not open the link."));
      }
    });
  }

  detach(element?: WebviewElement | null) {
    if (element && element !== this.element) return;
    this.detachAll();
    this.update({ attached: false, ready: false, url: "", title: "", loading: false });
  }

  private detachAll() {
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    this.element = null;
  }

  getConsoleErrors(): string[] {
    return [...this.errors];
  }

  /** Errors accumulated since the previous agent action — surfaced with its result. */
  newErrors(): string[] {
    const fresh = this.errors.slice(this.errorCursor).slice(-12);
    this.errorCursor = this.errors.length;
    return fresh;
  }

  clearConsoleErrors(): void {
    this.errors = [];
    this.errorCursor = 0;
  }

  private async requireElement(): Promise<WebviewElement> {
    const deadline = Date.now() + 8000;
    while (!this.element) {
      if (Date.now() > deadline) throw new Error("The in-app browser is not open. Open the browser panel and try again.");
      await sleep(50);
    }
    return this.element;
  }

  private async requirePage(): Promise<WebviewElement> {
    const element = await this.requireElement();
    const deadline = Date.now() + 4000;
    while (!this.snapshot.ready && Date.now() < deadline) await sleep(50);
    if (element.getURL() === "about:blank" || element.getURL() === "") {
      throw new Error("Open a website with open_browser before using this tool.");
    }
    return withPageDeadline(element);
  }

  private async waitForStop(element: WebviewElement): Promise<string> {
    let failure = "";
    const failed = new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        element.removeEventListener("did-stop-loading", finish);
        element.removeEventListener("did-fail-load", onFail);
        resolve();
      };
      const onFail = (event: any) => {
        if (event?.isMainFrame === false || event?.errorCode === -3) return;
        failure = `${event?.errorDescription || "Load failed"} (${event?.errorCode ?? "unknown"})`;
        finish();
      };
      const timer = setTimeout(finish, 25000);
      element.addEventListener("did-stop-loading", finish);
      element.addEventListener("did-fail-load", onFail);
    });
    return failed.then(() => failure);
  }

  async navigate(input: unknown): Promise<any> {
    const url = webUrl(input);
    const element = await this.requireElement();
    const failed = this.waitForStop(element);
    try {
      await element.loadURL(url);
    } catch (error) {
      // loadURL rejects on DNS/connection errors; the did-fail-load handler may
      // also record it. Report a single readable message below.
      const message = error instanceof Error ? error.message : "Navigation failed.";
      await failed;
      this.rememberError(message);
      throw new Error(`Could not load ${url}: ${message}`);
    }
    const failure = await failed;
    if (failure) throw new Error(`Could not load ${url}: ${failure}`);
    await sleep(120);
    let title = "";
    try { title = element.getTitle(); } catch { /* the page may be mid-navigation */ }
    // The page is open and the user's sentence is about the page. Handing back only a title costs
    // the agent a whole round to find out where it landed, so the open carries the first screenful:
    // its text, and the numbered controls with the coordinates they can be clicked at.
    const firstScreen = await within(element.executeJavaScript(FIRST_SCREEN_SOURCE), 5000, "The page opened but did not report its own text within 5s. Look at it with take_screenshot instead.").catch(() => null);
    const view = await within(element.executeJavaScript(COLLECT_TARGETS_SOURCE), 5000, "The page opened but did not list its controls within 5s. Look at it with take_screenshot instead.").catch(() => null) as PageView | null;
    if (view) void element.executeJavaScript(CLEAR_MARKS_SOURCE).catch(() => {});
    return {
      ok: true,
      url: element.getURL(),
      title,
      ...(firstScreen?.text ? { firstScreen } : {}),
      ...(view ? { onScreen: targetSummary(view), numbered: formatTargets(view).slice(0, 3000) } : {}),
      continueFromHere: "This page is open and already read. Carry on with the request from here — answer from the text above, or click the numbered coordinates. Do not spend a round opening, searching for, or screenshotting this page again before the request is done.",
    };
  }

  /**
   * Loads a server preview without taking control of the page. Failures stay
   * inside the panel instead of becoming agent tool errors.
   */
  async preview(input: unknown, options?: { reload?: boolean }): Promise<any> {
    const url = webUrl(input);
    const element = await this.requireElement();
    let current = "";
    try { current = element.getURL(); } catch { /* the webview may still be booting */ }
    if (current === url && !options?.reload) return { ok: true, url, title: element.getTitle(), reused: true };
    const failed = this.waitForStop(element);
    try {
      if (current === url) element.reload();
      else await element.loadURL(url);
    } catch { await failed; return { ok: false, url }; }
    const failure = await failed;
    if (failure) return { ok: false, url, error: failure };
    await sleep(350);
    let title = "";
    try { title = element.getTitle(); } catch { /* the page may be mid-navigation */ }
    return { ok: true, url: element.getURL(), title };
  }

  async readPage(): Promise<any> {
    const element = await this.requirePage();
    const page = await element.executeJavaScript(`(() => ({
      title: document.title,
      url: location.href,
      text: (document.body?.innerText ?? "").slice(0, 30000),
      links: [...document.querySelectorAll("a[href]")].slice(0, 80).map((anchor) => ({ text: (anchor.textContent ?? "").trim().slice(0, 120), href: anchor.href }))
    }))()`);
    const media = await element.executeJavaScript(PAGE_MEDIA_SOURCE).catch(() => null);
    return { ok: true, ...page, ...(media ? { media } : {}) };
  }

  /** Layout facts used to judge whether a preview is blank, unstyled, or erroring. */
  async probe(): Promise<any> {
    const element = await this.requirePage();
    return element.executeJavaScript(`(() => {
      const clean = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
      const text = clean(document.body?.innerText);
      const all = [...document.querySelectorAll("body *")];
      let visibleElements = 0;
      let richElements = 0;
      for (const node of all) {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
        visibleElements += 1;
        const tag = node.tagName;
        if (["IMG", "SVG", "CANVAS", "VIDEO", "PICTURE", "IFRAME", "BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(tag) || (tag === "A" && node.getAttribute("href"))) richElements += 1;
      }
      const overlay = document.querySelector("vite-error-overlay, nextjs-portal, [data-nextjs-dialog], #webpack-dev-server-client-overlay");
      let overlayText = "";
      if (overlay) {
        const root = overlay.shadowRoot || overlay;
        overlayText = clean(root.textContent).slice(0, 1200);
      }
      return {
        url: location.href,
        title: document.title,
        text: text.slice(0, 6000),
        textLength: text.length,
        visibleElements,
        richElements,
        styleTags: document.querySelectorAll("style").length,
        stylesheetLinks: document.querySelectorAll('link[rel="stylesheet"]').length,
        stylesheetCount: document.styleSheets.length,
        bodyHeight: Math.round(document.body?.scrollHeight ?? 0),
        viewportHeight: window.innerHeight,
        overlay: overlay ? overlay.tagName.toLowerCase() : "",
        overlayText,
      };
    })()`);
  }

  async click(selector: string): Promise<any> {
    const element = await this.requirePage();
    const literal = JSON.stringify(selector);
    const result = await element.executeJavaScript(`(() => {
      const target = document.querySelector(${literal});
      if (!target) throw new Error("No element matches " + ${literal});
      target.scrollIntoView({ block: "center", inline: "center" });
      target.click();
      return { tag: target.tagName.toLowerCase(), text: (target.textContent ?? "").trim().slice(0, 200) };
    })()`).catch((error: any) => { throw new Error(error?.message || `No element matches ${selector}`); });
    await sleep(250);
    return { ok: true, clicked: selector, element: result, url: element.getURL() };
  }

  async fill(selector: string, value: string): Promise<any> {
    const element = await this.requirePage();
    const result = await element.executeJavaScript(fillScript(selector, value)).catch((error: any) => { throw new Error(error?.message || `No element matches ${selector}`); });
    return { ok: true, filled: selector, element: result };
  }

  async inspect(selector: string): Promise<any> {
    const element = await this.requirePage();
    const literal = JSON.stringify(selector);
    return element.executeJavaScript(`(() => {
      const target = document.querySelector(${literal});
      if (!target) throw new Error("No element matches " + ${literal});
      const style = getComputedStyle(target);
      const rect = target.getBoundingClientRect();
      return {
        tag: target.tagName.toLowerCase(),
        text: (target.textContent ?? "").slice(0, 12000),
        html: target.outerHTML.slice(0, 20000),
        attributes: Object.fromEntries([...target.attributes].map((attribute) => [attribute.name, attribute.value])),
        value: target.value ?? null,
        checked: target.checked ?? null,
        disabled: target.disabled ?? null,
        placeholder: target.placeholder ?? null,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        styles: { display: style.display, visibility: style.visibility, color: style.color, background: style.backgroundColor },
      };
    })()`).catch((error: any) => { throw new Error(error?.message || `No element matches ${selector}`); });
  }

  async screenshot(fullPage = false): Promise<any> {
    const element = await this.requirePage();
    let id = 0;
    try { id = element.getWebContentsId(); } catch { /* not attached yet */ }
    if (!id) throw new Error("The browser surface is not ready for screenshots yet. Wait for the page and try again.");
    // Numbering happens before the capture so the image the model reads carries the same numbers it
    // is told to click; the overlay comes straight back off so the user sees the real page.
    const view = fullPage ? null : (await element.executeJavaScript(COLLECT_TARGETS_SOURCE).catch(() => null)) as PageView | null;
    const shot = await within((window as any).__electron.browserCapturePage(id, fullPage), 30_000, "The browser panel did not return a picture within 30s. The page it is holding is stuck: reload the address with open_browser before looking again.").catch(async (error: any) => {
      this.rememberError(error?.message || "The browser panel did not answer.");
      throw error;
    }) as { image: string };
    if (view) await element.executeJavaScript(CLEAR_MARKS_SOURCE).catch(() => {});
    const framing = fullPage
      ? { framing: "whole page — nothing is numbered here, and click_at needs a viewport screenshot. Take the default take_screenshot to act on the page." }
      : { framing: "viewport — every numbered box below is inside this image at the coordinates given, so click_at can use them as they are." };
    return {
      ok: true, url: element.getURL(), title: element.getTitle(), mimeType: "image/png", image: shot.image,
      ...framing, view: view ? targetSummary(view) : null, ...(view ? { numbered: formatTargets(view) } : {}),
    };
  }

  /** Slide the real cursor to a spot in a few steps, the way a hand moves a mouse across a page. */
  private async glide(element: WebviewElement, x: number, y: number) {
    const start = await element.executeJavaScript("(() => { const el = document.querySelector('body'); return { x: (window.__calvrasPointer && window.__calvrasPointer.x) || 0, y: (window.__calvrasPointer && window.__calvrasPointer.y) || 0 }; })()").catch(() => ({ x: 0, y: 0 }));
    const from = { x: Number(start?.x) || 0, y: Number(start?.y) || 0 };
    const steps = 8;
    for (let step = 1; step <= steps; step += 1) {
      element.sendInputEvent({
        type: "mouseMove",
        x: Math.round(from.x + (x - from.x) * (step / steps)),
        y: Math.round(from.y + (y - from.y) * (step / steps)),
      });
      await sleep(8);
    }
    element.executeJavaScript(`(() => { window.__calvrasPointer = { x: ${x}, y: ${y} }; return true; })()`).catch(() => {});
  }

  async clickAt(x: number, y: number, options?: { button?: string; double?: boolean }): Promise<any> {
    const element = await this.requirePage();
    const before = { url: element.getURL(), title: element.getTitle(), text: await this.openingText(element) };
    await this.glide(element, x, y);
    const button = options?.button === "right" ? "right" : "left";
    const clickCount = options?.double ? 2 : 1;
    element.sendInputEvent({ type: "mouseDown", x, y, button, clickCount });
    await sleep(40);
    element.sendInputEvent({ type: "mouseUp", x, y, button, clickCount });
    await this.settle(element);
    // Report what the pointer actually landed on, and what that control holds now. Without it a
    // click on a 13px tick box and a click beside it look identical in the result, and a form
    // gets submitted with the consent box still empty.
    const hit = await element.executeJavaScript(`(() => {
      const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
      if (!el) return null;
      const clean = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
      const box = el.getBoundingClientRect();
      const wrapper = el.closest("label");
      const control = el.matches("input,select,textarea") ? el : (wrapper ? wrapper.querySelector("input,select,textarea") : null);
      return {
        tag: el.tagName.toLowerCase(),
        text: (clean(el.textContent) || clean(el.getAttribute("aria-label") || "") || el.id || "").slice(0, 90),
        center: { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) },
        ...(control ? { control: { tag: control.tagName.toLowerCase(), type: String(control.type || ""), checked: control.checked === true, value: clean(control.value).slice(0, 40) } } : {}),
      };
    })()`).catch(() => null);
    // A click that moved the page already knows the answer the next round would pay for: the
    // reference code, the error under the field, the section that opened. Reading it here turns
    // "click, then think, then screenshot, then think" into one round per real move. A two-step
    // form never changes its URL, so compare what the page says, not just where it is.
    const landedSomewhere = before.url !== element.getURL() || before.title !== element.getTitle();
    const worthReading = landedSomewhere || /button|submit|^a$/.test(hit?.tag || "");
    const read = worthReading ? await this.prose(element) : null;
    const pageMoved = landedSomewhere || Boolean(read && read.text.slice(0, before.text.length) !== before.text);
    return {
      ok: true, clicked: { x, y }, hit, url: element.getURL(), title: element.getTitle(),
      ...(pageMoved && read ? { pageChanged: { from: before.title, to: element.getTitle() }, nowShowing: read.headings || read.text, note: landedSomewhere
        ? "The click took you somewhere new and this is what the page says — no screenshot round needed to learn that. The old numbered view is gone, so take a fresh screenshot before clicking by number again."
        : "This is what the page says after the click — read the new step or the error here instead of spending a round on a screenshot." } : {}),
    };
  }

  private prose(element: WebviewElement) {
    return element.executeJavaScript(proseScript()).then((value) => value as { headings: string; text: string }).catch(() => null);
  }

  /** A short fingerprint of the page as it stands, so a click that quietly opened step two of a
   * form still reports the change instead of leaving the agent to pay a round to notice it. */
  private openingText(element: WebviewElement) {
    return element.executeJavaScript("(() => String((document.body?.innerText || document.body?.textContent) ?? '').replace(/\\s+/g, ' ').trim().slice(0, 200))()").then((value) => String(value ?? "")).catch(() => "");
  }

  /** Gives a click a moment to actually navigate instead of reporting the pre-click page. */
  private async settle(element: WebviewElement) {
    for (let i = 0; i < 12; i += 1) {
      const ready = await element.executeJavaScript("document.readyState").catch(() => "complete");
      if (ready === "complete") break;
      await sleep(200);
    }
    await sleep(400);
  }

  async hoverAt(x: number, y: number): Promise<any> {
    const element = await this.requirePage();
    await this.glide(element, x, y);
    await sleep(250);
    return { ok: true, hovered: { x, y }, url: element.getURL() };
  }

  async dragAt(fromX: number, fromY: number, toX: number, toY: number): Promise<any> {
    const element = await this.requirePage();
    await this.glide(element, fromX, fromY);
    element.sendInputEvent({ type: "mouseDown", x: fromX, y: fromY, button: "left", clickCount: 1 });
    await sleep(60);
    const steps = 14;
    for (let step = 1; step <= steps; step += 1) {
      element.sendInputEvent({
        type: "mouseMove",
        x: Math.round(fromX + (toX - fromX) * (step / steps)),
        y: Math.round(fromY + (toY - fromY) * (step / steps)),
      });
      await sleep(14);
    }
    element.sendInputEvent({ type: "mouseUp", x: toX, y: toY, button: "left", clickCount: 1 });
    await sleep(300);
    return { ok: true, from: { x: fromX, y: fromY }, to: { x: toX, y: toY }, url: element.getURL() };
  }

  /** Types through the keyboard into whatever the agent just clicked, character by character. */
  async typeIntoPage(text: string): Promise<any> {
    if (!text) throw new Error("Provide the text to type into the focused field.");
    if (text.length > 6000) throw new Error("Keep typed text under 6000 characters.");
    const element = await this.requirePage();
    for (const character of text) {
      if (character === "\n") {
        element.sendInputEvent({ type: "keyDown", keyCode: "Return" });
        element.sendInputEvent({ type: "keyUp", keyCode: "Return" });
      } else {
        element.sendInputEvent({ type: "char", keyCode: character });
      }
      await sleep(12);
    }
    await sleep(200);
    return { ok: true, typed: text.length, url: element.getURL() };
  }

  /** Renders the live page and measures it against the screenshot the user sent. */
  async compareWithReference(referenceDataUrl: string): Promise<any> {
    if (!referenceDataUrl) throw new Error("There is no screenshot from the user to compare against.");
    const element = await this.requirePage();
    let id = 0;
    try { id = element.getWebContentsId(); } catch { /* not attached yet */ }
    if (!id) throw new Error("The browser surface is not ready for screenshots yet. Wait for the page and try again.");
    const shot = await within((window as any).__electron.browserCapturePage(id, false), 30_000, "The browser panel did not return a picture within 30s, so the page could not be compared. Reload it with open_browser and compare again.") as { image: string };
    const raw = await element.executeJavaScript(pixelDiffScript(referenceDataUrl, shot.image));
    const fidelity = summarizeFidelity(raw);
    return {
      ok: true,
      url: element.getURL(),
      ...fidelity,
      fidelity,
      ...(fidelity.heatmap ? { image: fidelity.heatmap, mimeType: "image/png" } : {}),
    };
  }

  async scroll(direction: string, amount?: number): Promise<any> {    const element = await this.requirePage();
    const distance = Math.min(Math.max(Number(amount) || 650, 50), 8000);
    const delta = String(direction).toLowerCase() === "up" ? -distance : distance;
    const position = await element.executeJavaScript(`(() => {
      window.scrollBy({ top: ${delta}, behavior: "smooth" });
      return { x: window.scrollX, y: window.scrollY };
    })()`);
    return { ok: true, scrolled: delta < 0 ? "up" : "down", amount: distance, position, url: element.getURL() };
  }

  async pressKey(keys: string): Promise<any> {
    if (!keys.trim()) throw new Error("Provide keys to press, for example Enter or Control+A.");
    const element = await this.requirePage();
    const parts = keys.split("+").map((part) => part.trim()).filter(Boolean);
    if (!parts.length || parts.length > 5) throw new Error("Provide at most 5 keys joined with +.");
    const modifiers = parts.slice(0, -1).map((part) => KEY_NAMES[part.toLowerCase()] || part);
    const last = parts[parts.length - 1] ?? "";
    if (!last) throw new Error("Provide keys to press, for example Enter or Control+A.");
    const keyCode = KEY_NAMES[last.toLowerCase()] || (last.length === 1 ? last.toUpperCase() : last.charAt(0).toUpperCase() + last.slice(1));
    for (const modifier of modifiers) element.sendInputEvent({ type: "keyDown", keyCode: modifier });
    element.sendInputEvent({ type: "keyDown", keyCode, modifiers: modifiers.map((item) => item.toLowerCase()) });
    if (keyCode.length === 1 && !modifiers.length) element.sendInputEvent({ type: "char", keyCode });
    element.sendInputEvent({ type: "keyUp", keyCode, modifiers: modifiers.map((item) => item.toLowerCase()) });
    for (const modifier of [...modifiers].reverse()) element.sendInputEvent({ type: "keyUp", keyCode: modifier });
    await sleep(120);
    return { ok: true, keys, url: element.getURL() };
  }

  async goBack(): Promise<any> {
    const element = await this.requirePage();
    if (!element.canGoBack()) throw new Error("There is no previous page in the browser history.");
    const failed = this.waitForStop(element);
    element.goBack();
    const failure = await failed;
    if (failure) throw new Error(`Could not go back: ${failure}`);
    return { ok: true, url: element.getURL(), title: element.getTitle() };
  }

  async goForward(): Promise<any> {
    const element = await this.requirePage();
    if (!element.canGoForward()) throw new Error("There is no next page in the browser history.");
    const failed = this.waitForStop(element);
    element.goForward();
    const failure = await failed;
    if (failure) throw new Error(`Could not go forward: ${failure}`);
    return { ok: true, url: element.getURL(), title: element.getTitle() };
  }

  async waitForElement(selector: string, timeoutMs?: number): Promise<any> {
    const element = await this.requirePage();
    const literal = JSON.stringify(selector);
    const timeout = Math.min(Math.max(Number(timeoutMs) || 15000, 1000), 60000);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = await element.executeJavaScript(`(() => {
        const target = document.querySelector(${literal});
        return Boolean(target && (target.offsetWidth || target.offsetHeight || target.getClientRects().length));
      })()`);
      if (found) return { ok: true, selector, url: element.getURL(), title: element.getTitle() };
      await sleep(350);
    }
    throw new Error(`No visible element matched "${selector}" within ${timeout}ms. Take a take_screenshot and click the numbered spot instead of waiting on a selector.`);
  }

  /** Runs the agent's own script body in the page. Gated by the Browser JavaScript policy. */
  async script(code: string): Promise<any> {
    if (!code.trim()) throw new Error("Provide the JavaScript to run in the page.");
    const element = await this.requirePage();
    const value = await element.executeJavaScript(`(async () => { ${code} })()`).catch((error: any) => { throw new Error(error?.message || "The page rejected the script."); });
    let result: unknown = value ?? null;
    try { result = JSON.parse(JSON.stringify(result ?? null)); } catch { result = String(result); }
    return { ok: true, result, url: element.getURL() };
  }

  async uploadFile(selector: string, projectPath: string, relativePath: string): Promise<any> {
    if (!projectPath) throw new Error("Select a workspace folder so Calvras can attach files that live inside it.");
    if (!relativePath.trim()) throw new Error("Provide the file path inside the workspace.");
    const element = await this.requirePage();
    const id = element.getWebContentsId();
    await within((window as any).__electron.browserSetFileInput(id, selector, projectPath, relativePath), 20_000, `The panel did not attach ${relativePath} to ${selector} within 20s. Check the selector points at the real input[type=file] and try again.`);
    return { ok: true, selector, uploaded: relativePath, url: element.getURL() };
  }

  async execute(type: string, args: Record<string, any>, projectPath: string | null | undefined): Promise<any> {
    let data: any;
    switch (type) {
      case "open_browser":
      case "navigate_browser": data = await this.navigate(args["url"]); break;
      case "read_page": data = await this.readPage(); break;
      case "click_element": data = await this.click(String(args["selector"] ?? "")); break;
      case "fill_input": data = await this.fill(String(args["selector"] ?? ""), String(args["value"] ?? args["text"] ?? "")); break;
      case "inspect_element": data = await this.inspect(String(args["selector"] ?? "")); break;
      case "take_screenshot": data = await this.screenshot(args["fullPage"] === true); break;
      case "click_at": { const at = spot(args); data = await this.clickAt(at.x, at.y, { button: String(args["button"] ?? ""), double: args["double"] === true || Number(args["clicks"]) >= 2 }); break; }
      case "hover_at": { const at = spot(args); data = await this.hoverAt(at.x, at.y); break; }
      case "drag_at": { const from = spot(args, "fromX", "fromY"); const to = spot(args, "toX", "toY"); data = await this.dragAt(from.x, from.y, to.x, to.y); break; }
      case "type_into_page": data = await this.typeIntoPage(String(args["text"] ?? args["value"] ?? "")); break;
      case "check_console_errors": {
        const errors = this.getConsoleErrors();
        if (args["clear"] === true) this.clearConsoleErrors();
        else this.newErrors();
        return { ok: true, url: this.snapshot.url, errors, count: errors.length };
      }
      case "scroll_page": data = await this.scroll(String(args["direction"] ?? "down"), args["amount"]); break;
      case "press_page_key": data = await this.pressKey(String(args["keys"] ?? "")); break;
      case "go_back": data = await this.goBack(); break;
      case "wait_for_element": data = await this.waitForElement(String(args["selector"] ?? ""), args["timeoutMs"]); break;
      case "upload_file_to_page": data = await this.uploadFile(String(args["selector"] ?? ""), String(projectPath ?? ""), String(args["path"] ?? "")); break;
      case "run_page_script": data = await this.script(String(args["code"] ?? "")); break;
      default: throw new Error(`The visible browser cannot run ${type}.`);
    }
    if (data && typeof data === "object") {
      const consoleErrors = this.newErrors();
      if (consoleErrors.length) data.consoleErrors = consoleErrors;
    }
    return data;
  }
}

export const browserBridge = new BrowserBridge();
