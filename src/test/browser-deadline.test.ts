// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserBridge } from "../lib/browser-bridge";

/**
 * Endurance rule for the browser panel: a page that stops answering has to come back as a tool error
 * the run can route around. An await that never settles is how an hours-long batch dies mid-queue
 * with the Stop button still showing, which is the failure this guards against.
 */
function stuckPage() {
  const handlers: Record<string, any> = {};
  const element = {
    addEventListener: (name: string, handler: any) => { handlers[name] = handler; },
    removeEventListener: () => {},
    getURL: () => "https://acme.test/post/1",
    getTitle: () => "Backend Engineer — Northwind",
    insertCSS: async () => "",
    getWebContentsId: () => 7,
    // A page whose main thread is wedged never resolves anything sent into it.
    executeJavaScript: () => new Promise(() => {}),
  };
  browserBridge.attach(element as any);
  handlers["dom-ready"]?.();
  return element;
}

describe("a page that stops answering", () => {
  afterEach(() => { browserBridge.detach(); vi.useRealTimers(); });

  it("answers with an error instead of waiting forever on the page", async () => {
    vi.useFakeTimers();
    stuckPage();
    const reading = browserBridge.readPage();
    const refused = expect(reading).rejects.toThrow(/did not answer within 45s/);
    await vi.advanceTimersByTimeAsync(46_000);
    await refused;
  });

  it("does not let the agent's own page script pin the run", async () => {
    vi.useFakeTimers();
    stuckPage();
    const running = browserBridge.script("while (true) { /* the page never comes back */ }");
    const refused = expect(running).rejects.toThrow(/did not answer within 45s/);
    await vi.advanceTimersByTimeAsync(46_000);
    await refused;
  });
});
