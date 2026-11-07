import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatePill } from "../components/UpdatePill";
import { RELEASE_VERSION, updateManifest } from "../lib/release";

function desktop(overrides: Record<string, unknown> = {}) {
  const listeners = new Set<(state: any) => void>();
  const bridge = {
    appVersion: async () => RELEASE_VERSION,
    updateDownload: vi.fn(async () => ({ ok: true })),
    updateInstall: vi.fn(async () => ({ ok: true })),
    onUpdateState: (callback: (state: any) => void) => { listeners.add(callback); return () => listeners.delete(callback); },
    ...overrides,
  };
  Object.defineProperty(window, "__electron", { value: bridge, configurable: true });
  return { emit: (state: any) => { for (const callback of listeners) callback(state); } };
}

function publish(version: string) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => "application/json; charset=utf-8" }, json: async () => ({ ...updateManifest(), version, installer: `https://github.com/Calvras/calvras/releases/download/v${version}/Calvras-Setup-${version}.exe` }) })));
}

beforeEach(() => { desktop(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Object.defineProperty(window, "__electron", { value: undefined, configurable: true }); });

describe("the workspace tools update pill", () => {
  it("stays out of the tools row while this build is the published one", async () => {
    publish(RELEASE_VERSION);
    render(<UpdatePill />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not invent an update when the feed cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    render(<UpdatePill />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows a milky Update in a browser tab nothing, because there is no app to update", async () => {
    Object.defineProperty(window, "__electron", { value: undefined, configurable: true });
    publish("99.0.0");
    render(<UpdatePill />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("appears the moment a newer version is published", async () => {
    publish("99.0.0");
    render(<UpdatePill />);
    const pill = await screen.findByRole("button", { name: /Calvras 99\.0\.0 is published/ });
    expect(pill).toHaveClass("settings-milk");
    expect(pill).toHaveTextContent("Update");
  });

  it("downloads on the first click, then restarts on the second", async () => {
    publish("99.0.0");
    const { emit } = desktop();
    render(<UpdatePill />);
    const pill = await screen.findByRole("button", { name: /Calvras 99\.0\.0 is published/ });

    fireEvent.click(pill);
    await waitFor(() => expect(bridgeDownload()).toHaveBeenCalledWith({ url: "https://github.com/Calvras/calvras/releases/download/v99.0.0/Calvras-Setup-99.0.0.exe", version: "99.0.0" }));

    act(() => { emit({ state: "downloading", received: 42, total: 100, percent: 42 }); });
    const busy = screen.getByRole("button", { name: /Downloading Calvras 99\.0\.0/ });
    expect(busy).toHaveTextContent("Updating 42%");
    expect(busy).toBeDisabled();

    act(() => { emit({ state: "ready", file: "C:\\Users\\me\\AppData\\Roaming\\Calvras\\updates\\Calvras-Setup-99.0.0.exe", bytes: 100 }); });
    const restart = await screen.findByRole("button", { name: /is on this computer/ });
    expect(restart).toHaveTextContent("Restart");
    fireEvent.click(restart);
    await waitFor(() => expect(bridgeInstall()).toHaveBeenCalledWith("C:\\Users\\me\\AppData\\Roaming\\Calvras\\updates\\Calvras-Setup-99.0.0.exe"));
  });

  it("offers a retry that says what actually went wrong", async () => {
    publish("99.0.0");
    desktop({ updateDownload: vi.fn(async () => ({ ok: false, error: "That build is not published yet (the download answered as text/html), so nothing was installed." })) });
    render(<UpdatePill />);
    fireEvent.click(await screen.findByRole("button", { name: /Calvras 99\.0\.0 is published/ }));
    const retry = await screen.findByRole("button", { name: /not published yet/ });
    expect(retry).toHaveTextContent("Try again");
    expect(retry).toBeEnabled();
  });

  it("keeps the pill honest when the download fails mid-flight", async () => {
    publish("99.0.0");
    const { emit } = desktop();
    render(<UpdatePill />);
    fireEvent.click(await screen.findByRole("button", { name: /Calvras 99\.0\.0 is published/ }));
    act(() => { emit({ state: "downloading", received: 10, total: 100, percent: 10 }); });
    act(() => { emit({ state: "failed", error: "The download stopped after 10 bytes, so the update was discarded." }); });
    expect((await screen.findByRole("button", { name: /stopped after 10 bytes/ })).textContent).toBe("Try again");
  });
});

function bridgeDownload() {
  return (window as any).__electron.updateDownload as ReturnType<typeof vi.fn>;
}
function bridgeInstall() {
  return (window as any).__electron.updateInstall as ReturnType<typeof vi.fn>;
}
