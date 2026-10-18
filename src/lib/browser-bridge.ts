import { pixelDiffScript, summarizeFidelity } from "./image-fidelity";

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
]);

export function isInAppBrowserTool(type: string): boolean {
  return IN_APP_BROWSER_TOOLS.has(type);
}

export function hasInAppBrowser(): boolean {
  return typeof window !== "undefined" && Boolean((window as any).__electron?.browserCapturePage);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  right: "ArrowRight", pageup: "PageUp", pagedown: "PageDown", home: "Home", end: "End",
};

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
    return element;
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
    return { ok: true, url: element.getURL(), title };
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
    return { ok: true, ...page };
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
    const literal = JSON.stringify(selector);
    const text = JSON.stringify(value);
    const result = await element.executeJavaScript(`(() => {
      const target = document.querySelector(${literal});
      if (!target) throw new Error("No element matches " + ${literal});
      target.scrollIntoView({ block: "center", inline: "center" });
      target.focus();
      const value = ${text};
      if (target instanceof HTMLSelectElement) {
        // A select ignores the input value setter entirely, so the form would silently
        // submit its default option. Match on the option's value or its visible label.
        const wanted = value.trim().toLowerCase();
        const labels = (option) => (option.textContent || "").trim().toLowerCase();
        const choice = [...target.options].find((option) => (option.value || "").toLowerCase() === wanted || labels(option) === wanted)
          || [...target.options].find((option) => labels(option).includes(wanted) || (wanted.length > 2 && wanted.includes(labels(option))));
        if (!choice) throw new Error(${literal} + " is a dropdown with these options: " + ([...target.options].map((option) => (option.textContent || "").trim() || option.value).join(" | ") || "none") + ". Pick one of those.");
        target.value = choice.value;
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
      return { tag: target.tagName.toLowerCase(), type: format, value: target.value ?? target.textContent };
    })()`).catch((error: any) => { throw new Error(error?.message || `No element matches ${selector}`); });
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

  async screenshot(fullPage = true): Promise<any> {
    const element = await this.requirePage();
    let id = 0;
    try { id = element.getWebContentsId(); } catch { /* not attached yet */ }
    if (!id) throw new Error("The browser surface is not ready for screenshots yet. Wait for the page and try again.");
    const shot = await (window as any).__electron.browserCapturePage(id, fullPage);
    return { ok: true, url: element.getURL(), title: element.getTitle(), mimeType: "image/png", image: shot.image };
  }

  /** Renders the live page and measures it against the screenshot the user sent. */
  async compareWithReference(referenceDataUrl: string): Promise<any> {
    if (!referenceDataUrl) throw new Error("There is no screenshot from the user to compare against.");
    const element = await this.requirePage();
    let id = 0;
    try { id = element.getWebContentsId(); } catch { /* not attached yet */ }
    if (!id) throw new Error("The browser surface is not ready for screenshots yet. Wait for the page and try again.");
    const shot = await (window as any).__electron.browserCapturePage(id, false);
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
    throw new Error(`No visible element matched "${selector}" within ${timeout}ms. Use read_page to inspect the current page.`);
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
    await (window as any).__electron.browserSetFileInput(id, selector, projectPath, relativePath);
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
      case "take_screenshot": data = await this.screenshot(args["fullPage"] !== false); break;
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
