import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlugin, deletePlugin, enabledPluginsPrompt, loadPlugins, savePlugins, updatePlugin } from "../lib/plugins";

describe("plugins", () => {
  beforeEach(() => localStorage.clear());

  it("creates an enabled plugin and persists it", () => {
    const plugin = createPlugin({ name: "Use pnpm", description: "Package rules", instructions: "Always use pnpm." });
    expect(plugin.enabled).toBe(true);
    expect(loadPlugins()).toMatchObject([{ id: plugin.id, name: "Use pnpm", description: "Package rules", instructions: "Always use pnpm." }]);
  });

  it("requires a name and instructions", () => {
    expect(() => createPlugin({ name: "   ", instructions: "Do work." })).toThrow(/name/i);
    expect(() => createPlugin({ name: "Empty", instructions: "   " })).toThrow(/instructions/i);
  });

  it("edits, pauses, and deletes a plugin", () => {
    const plugin = createPlugin({ name: "One", instructions: "First rule." });
    const updated = updatePlugin(plugin.id, { name: "Two", instructions: "Second rule.", enabled: false });
    expect(updated[0]).toMatchObject({ id: plugin.id, name: "Two", instructions: "Second rule.", enabled: false });
    expect(deletePlugin(plugin.id)).toEqual([]);
    expect(loadPlugins()).toEqual([]);
  });

  it("injects only enabled plugin instructions into the prompt", () => {
    createPlugin({ name: "House rules", description: "Team conventions", instructions: "Use pnpm and run the typecheck." });
    const paused = createPlugin({ name: "Paused rule", instructions: "Never run the tests." });
    updatePlugin(paused.id, { enabled: false });

    const prompt = enabledPluginsPrompt();
    expect(prompt).toContain("[ENABLED PLUGINS]");
    expect(prompt).toContain("Plugin: House rules — Team conventions");
    expect(prompt).toContain("Use pnpm and run the typecheck.");
    expect(prompt).not.toContain("Never run the tests.");
    expect(prompt).toContain("[/ENABLED PLUGINS]");
  });

  it("returns no prompt block when every plugin is paused", () => {
    const plugin = createPlugin({ name: "Paused", instructions: "Stay quiet." });
    updatePlugin(plugin.id, { enabled: false });
    expect(enabledPluginsPrompt()).toBe("");
  });

  it("announces saved changes for the app's plugin badge", () => {
    const listener = vi.fn();
    window.addEventListener("calvras:plugins", listener);
    const plugins = [createPlugin({ name: "Notify", instructions: "Say hi." })];
    savePlugins(plugins);
    expect(listener).toHaveBeenCalled();
    window.removeEventListener("calvras:plugins", listener);
  });
});
