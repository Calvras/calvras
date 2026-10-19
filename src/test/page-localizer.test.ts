import { beforeEach, describe, expect, it } from "vitest";
import { CLEAR_MARKS_SOURCE, COLLECT_TARGETS_SOURCE, formatTargets, type PageView } from "@/lib/runtime/page-localizer";
import { BROWSER_TOOLS } from "@/lib/runtime/browser-tools";
import { isInAppBrowserTool } from "@/lib/browser-bridge";
import { CALVRAS_SYSTEM_PROMPT } from "@/lib/system-prompt";
import { TOOL_NAMES, TOOL_RISK, validateToolAction } from "@/lib/tool-catalog";

/**
 * The numbered screenshot is what lets the agent act on a page it already opened without searching
 * again, so its coordinate maths is pinned here rather than left to the opt-in browser harness.
 */
const boxes = new Map<Element, { x: number; y: number; width: number; height: number }>();

function giveEachElementABody() {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement) {
    const box = boxes.get(this) ?? { x: 0, y: 0, width: 0, height: 0 };
    return {
      x: box.x, y: box.y, width: box.width, height: box.height,
      top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height,
      toJSON: () => box,
    } as DOMRect;
  };
  document.elementFromPoint = (x: number, y: number) => {
    for (const [element, box] of boxes) {
      if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) return element;
    }
    return document.body;
  };
}

const collect = () => new Function(`return (${COLLECT_TARGETS_SOURCE})`)() as PageView;
const clear = () => new Function(`return (${CLEAR_MARKS_SOURCE})`)() as { ok: boolean };

describe("numbered page capture", () => {
  beforeEach(() => {
    boxes.clear();
    giveEachElementABody();
    document.body.innerHTML = "";
  });

  it("numbers what is on screen and reports the exact spot to click", () => {
    // jsdom reports an empty computed opacity, which the real browser never does, so the fixture
    // states it. Everything else here is the page's own markup.
    document.body.innerHTML = `<h1 style="opacity:1">Feed</h1><button style="opacity:1">Save post</button><input style="opacity:1" name="search" type="text">
      <a style="opacity:1" href="/next">Next page</a><div id="offscreen" style="display:none">Hidden</div>`;
    const [heading, button, input, link, hidden] = [...document.querySelectorAll("h1, button, input, a, div")];
    boxes.set(heading!, { x: 20, y: 10, width: 200, height: 30 });
    boxes.set(button!, { x: 40, y: 60, width: 120, height: 32 });
    boxes.set(input!, { x: 200, y: 60, width: 240, height: 28 });
    boxes.set(link!, { x: 40, y: 120, width: 100, height: 24 });
    boxes.set(hidden!, { x: 40, y: 200, width: 100, height: 24 });

    const view = collect();
    expect(view.viewport).toEqual({ width: 1280, height: 800 });
    expect(view.targets.map((target) => target.label)).toEqual(["Save post", "search", "Next page"]);
    expect(view.targets[0]).toMatchObject({ i: 1, x: 100, y: 76, role: "button" });
    expect(view.targets[1]).toMatchObject({ i: 2, x: 320, y: 74, role: "text" });
    // The list the model reads has to carry the same numbers as the picture it is looking at.
    expect(formatTargets(view)).toContain('2: text "search" at x=320 y=74');
    expect(document.getElementById("__calvras_marks")).not.toBeNull();
    expect(clear().ok).toBe(true);
    expect(document.getElementById("__calvras_marks")).toBeNull();
  });

  it("refuses to number a control the click would never reach", () => {
    document.body.innerHTML = `<button style="opacity:1">Real</button><button style="opacity:1">Underneath</button>`;
    const [top, buried] = [...document.querySelectorAll("button")];
    boxes.set(top!, { x: 100, y: 100, width: 80, height: 30 });
    boxes.set(buried!, { x: 120, y: 110, width: 80, height: 30 });
    const view = collect();
    expect(view.targets.map((target) => target.label)).toEqual(["Real"]);
  });

  it("registers the pointer tools on both browser surfaces and gates them as actuation", () => {
    for (const tool of ["click_at", "hover_at", "drag_at", "type_into_page"]) {
      expect(TOOL_NAMES).toContain(tool as never);
      expect(BROWSER_TOOLS).toContain(tool);
      expect(isInAppBrowserTool(tool)).toBe(true);
      expect(TOOL_RISK[tool as keyof typeof TOOL_RISK]).toBe("external");
    }
    expect(() => validateToolAction({ type: "click_at" })).toThrow(/numbered spot/);
    expect(() => validateToolAction({ type: "drag_at", fromX: 10, fromY: 20 })).toThrow(/fromX/);
    expect(() => validateToolAction({ type: "type_into_page" })).toThrow(/text/);
    expect(validateToolAction({ type: "click_at", x: 100, y: 220 })["x"]).toBe(100);
  });

  it("tells the model to work the open page instead of searching it again", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toContain("somewhere you are standing, not something to re-find");
    expect(CALVRAS_SYSTEM_PROMPT).toContain("numbers every clickable thing");
    expect(CALVRAS_SYSTEM_PROMPT).toContain("Do not web_search again to find your way back");
    expect(CALVRAS_SYSTEM_PROMPT).toContain("type_into_page");
  });
});
