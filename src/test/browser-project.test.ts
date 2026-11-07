import { beforeEach, describe, expect, it } from "vitest";
import { browserBridge } from "../lib/browser-bridge";

/** The panel is a <webview>; this is the part of it the bridge actually calls. */
function fakeWebview(url: string) {
  const loaded: string[] = [];
  return {
    loaded,
    element: {
      addEventListener: () => {},
      removeEventListener: () => {},
      getURL: () => (loaded.length ? loaded[loaded.length - 1] : url),
      getTitle: () => "Harness preview",
      loadURL: async (target: string) => { loaded.push(target); },
    } as any,
  };
}

describe("the browser panel's project binding", () => {
  beforeEach(() => {
    browserBridge.detach();
    browserBridge.bindProject("");
  });

  it("records the folder a page was opened for", () => {
    const view = fakeWebview("http://localhost:5175/");
    browserBridge.attach(view.element);
    browserBridge.bindProject("C:/work/scheduler");
    expect(browserBridge.getSnapshot().project).toBe("C:/work/scheduler");
  });

  it("leaves another project's page alone when one is deleted", () => {
    const view = fakeWebview("http://localhost:5175/");
    browserBridge.attach(view.element);
    browserBridge.bindProject("C:/work/scheduler");
    expect(browserBridge.clearForProject("C:/work/other")).toBe(false);
    expect(browserBridge.getSnapshot().project).toBe("C:/work/scheduler");
    expect(view.loaded).toEqual([]);
  });

  it("clears the page and the binding when its own project goes", () => {
    const view = fakeWebview("http://localhost:5175/");
    browserBridge.attach(view.element);
    browserBridge.bindProject("C:/work/scheduler");
    expect(browserBridge.clearForProject("C:/work/scheduler")).toBe(true);
    expect(view.loaded).toEqual(["about:blank"]);
    expect(browserBridge.getSnapshot().project).toBe("");
    expect(browserBridge.getSnapshot().url).toBe("");
    // The empty state is what the dock shows next, and it says so rather than looking broken.
    expect(browserBridge.getSnapshot().attached).toBe(true);
  });

  it("never clears a page that belongs to no project", () => {
    const view = fakeWebview("https://calvras.com");
    browserBridge.attach(view.element);
    browserBridge.bindProject(null);
    expect(browserBridge.clearForProject("C:/work/scheduler")).toBe(false);
    expect(view.loaded).toEqual([]);
  });

  it("closes the dock through the binding change, not by reaching into React", () => {
    const view = fakeWebview("http://localhost:3000/");
    browserBridge.attach(view.element);
    browserBridge.bindProject("C:/work/scheduler");
    const seen: string[] = [];
    const unsubscribe = browserBridge.subscribe(() => seen.push(browserBridge.getSnapshot().project));
    browserBridge.clearForProject("C:/work/scheduler");
    unsubscribe();
    expect(seen).toEqual([""]);
  });
});
