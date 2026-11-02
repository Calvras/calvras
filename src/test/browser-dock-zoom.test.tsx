import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RightDock from "../components/RightDock";

let snapshot = { attached: true, ready: true, url: "", title: "", loading: false, project: "C:/project" };
const listeners = new Set<() => void>();

vi.mock("@/lib/browser-bridge", () => ({
  isInAppBrowserTool: () => true,
  hasInAppBrowser: () => true,
  browserBridge: {
    subscribe: (listen: () => void) => { listeners.add(listen); return () => listeners.delete(listen); },
    getSnapshot: () => snapshot,
    attach: vi.fn(),
    navigate: vi.fn(async () => {}),
    goBack: vi.fn(),
    goForward: vi.fn(),
  },
}));

function showPage(next: Partial<typeof snapshot>) {
  act(() => { snapshot = { ...snapshot, ...next }; listeners.forEach((listen) => listen()); });
}

beforeEach(() => { localStorage.clear(); snapshot = { attached: true, ready: true, url: "", title: "", loading: false, project: "C:/project" }; });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function dock(browserActive = false) {
  return render(
    <div className="chat-page">
      <RightDock
        open
        tab="browser"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        projectPath="C:/project"
        projectName="fixture"
        showBrowser
        showAgents={false}
        browserActive={browserActive}
        agents={[]}
        jobs={[]}
        execute={vi.fn(async () => ({ ok: true }))}
      />,
    </div>,
  );
}

describe("the preview's full-screen toggle", () => {
  it("offers zoom only once a page is actually showing", () => {
    dock();
    expect(screen.queryByRole("button", { name: "Full screen preview" })).not.toBeInTheDocument();
    showPage({ url: "http://localhost:5177/", title: "Cloudflare Replica" });
    expect(screen.getByRole("button", { name: "Full screen preview" })).toBeInTheDocument();
  });

  it("spreads the page over the window and hands back the unzoom arrow", () => {
    dock();
    showPage({ url: "http://localhost:5177/" });
    const zoom = screen.getByRole("button", { name: "Full screen preview" });
    fireEvent.click(zoom);
    expect(document.querySelector(".browser-dock")).toHaveAttribute("data-zoomed", "true");
    const unzoom = screen.getByRole("button", { name: "Exit full screen preview" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector(".browser-dock")).toHaveAttribute("data-zoomed", "false");
    fireEvent.click(unzoom);
    expect(document.querySelector(".browser-dock")).toHaveAttribute("data-zoomed", "true");
  });

  it("still lets the edge resize with the agent driving the page", () => {
    showPage({ url: "http://localhost:5177/" });
    dock(true);
    const handle = screen.getByRole("separator", { name: "Resize browser panel" });
    expect(handle).not.toHaveAttribute("aria-disabled");
    const before = Number(handle.getAttribute("aria-valuenow"));
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    // jsdom measures the panel at 0 wide, so the clamp lands it on the floor; the number matters
    // less than the fact that a locked panel never moved it at all.
    expect(Number(handle.getAttribute("aria-valuenow"))).not.toBe(before);
  });
});
