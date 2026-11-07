// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { browserBridge } from "../lib/browser-bridge";

/**
 * The user asked for the preview to stop refreshing on its own. The page the panel already holds is
 * what a check has to measure, so a check that did not ask for a clean load must leave it alone — and
 * say so, rather than letting a render read from a live page pass as a freshly loaded one.
 */
function panelAt(url: string) {
  const handlers: Record<string, any> = {};
  const element = {
    addEventListener: (name: string, handler: any) => { handlers[name] = handler; },
    removeEventListener: () => {},
    getURL: () => url,
    getTitle: () => "Harness preview",
    loadURL: vi.fn(async (target: string) => { handlers["did-stop-loading"]?.({ url: target }); }),
    reload: vi.fn(() => { handlers["did-stop-loading"]?.({ url }); }),
  };
  browserBridge.detach();
  browserBridge.attach(element as any);
  handlers["dom-ready"]?.();
  return element;
}

describe("the preview the panel is already holding", () => {
  it("measures it without reloading it", async () => {
    const element = panelAt("http://localhost:5178/");
    const result = await browserBridge.preview("http://localhost:5178/");
    expect(result).toMatchObject({ ok: true, reused: true });
    expect(element.reload).not.toHaveBeenCalled();
    expect(element.loadURL).not.toHaveBeenCalled();
    // The same page with a different trailing slash is not a reason to load it again.
    await expect(browserBridge.preview("http://localhost:5178")).resolves.toMatchObject({ reused: true });
  });

  it("still loads a page it is not showing, and reloads only when a clean load was asked for", async () => {
    const element = panelAt("https://www.cloudflare.com/");
    await expect(browserBridge.preview("http://localhost:5178/")).resolves.toMatchObject({ ok: true });
    expect(element.loadURL).toHaveBeenCalledWith("http://localhost:5178/");

    const held = panelAt("http://localhost:5178/");
    await expect(browserBridge.preview("http://localhost:5178/", { reload: true })).resolves.toMatchObject({ ok: true });
    expect(held.reload).toHaveBeenCalledTimes(1);
  });
});
