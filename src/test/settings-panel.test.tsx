import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../components/SettingsPanel";
import { readPreferences, readPolicies } from "../lib/preferences";
import { TOOL_NAMES } from "../lib/tool-catalog";

const values = new Map<string, string>();

const goto = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const row = (title: string) => within(screen.getByText(title).closest(".settings-row") as HTMLElement);

beforeEach(() => {
  values.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("settings", () => {
  it("opens full screen with the rail always visible and no model provider UI", () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("complementary")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show settings sections" })).toBeNull();
    expect(screen.queryByLabelText("Provider API key")).toBeNull();
    expect(screen.queryByLabelText("Model provider")).toBeNull();
    expect(screen.queryByLabelText("Pinned model")).toBeNull();
  });

  it("persists the security preset and effort, then notifies listeners", () => {
    const policies = vi.fn(); window.addEventListener("calvras:policies", policies);
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Security Preset"), { target: { value: "full" } });
    expect(values.get("calvras_access_mode")).toBe("full");
    expect(readPolicies().securityPreset).toBe("full");
    expect(readPreferences().accessMode).toBe("full");
    expect(policies).toHaveBeenCalledTimes(1);

    const preferences = vi.fn(); window.addEventListener("calvras:preferences", preferences);
    fireEvent.change(screen.getByLabelText("Default response effort"), { target: { value: "Thorough" } });
    expect(JSON.parse(values.get("calvras_preferences") || "{}")).toMatchObject({ effort: "Thorough" });
    expect(preferences).toHaveBeenCalledTimes(1);
    window.removeEventListener("calvras:policies", policies);
    window.removeEventListener("calvras:preferences", preferences);
  });

  it("routes each subagent role onto an engine of its own", () => {
    const preferences = vi.fn(); window.addEventListener("calvras:preferences", preferences);
    render(<SettingsPanel open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Implementation worker effort"), { target: { value: "Thorough" } });
    fireEvent.change(screen.getByLabelText("Implementation worker model"), { target: { value: "gemini-3.8-flash" } });
    expect(readPreferences().workerRouting.builder).toEqual({ effort: "Thorough", model: "gemini-3.8-flash" });
    // A role nobody touched keeps its own route instead of inheriting the edit.
    expect(readPreferences().workerRouting.researcher).toEqual({ effort: "Quick", model: "" });
    expect(JSON.parse(values.get("calvras_preferences") || "{}")).toMatchObject({ workerRouting: { builder: { effort: "Thorough", model: "gemini-3.8-flash" } } });
    expect(preferences).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Verification worker effort"), { target: { value: "Quick" } });
    expect(readPreferences().workerRouting).toEqual({ builder: { effort: "Thorough", model: "gemini-3.8-flash" }, verifier: { effort: "Quick", model: "" }, researcher: { effort: "Quick", model: "" } });
    window.removeEventListener("calvras:preferences", preferences);
  });

  it("stores the queued delivery choice as a policy", () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("group", { name: "Queued Messages" })).getByRole("button", { name: "Send Immediately" }));
    expect(readPolicies().queuedDelivery).toBe("immediate");
    expect(within(screen.getByRole("group", { name: "Queued Messages" })).getByRole("button", { name: "Send Immediately" })).toHaveAttribute("aria-pressed", "true");
  });

  it("applies appearance changes to the document", () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);
    goto("Appearance");
    fireEvent.click(screen.getByRole("switch", { name: "Reduce motion" }));
    expect(document.documentElement.dataset["reduceMotion"]).toBe("true");
    fireEvent.change(screen.getByLabelText("Workspace tone"), { target: { value: "midnight" } });
    expect(document.documentElement.dataset["palette"]).toBe("midnight");
  });

  it("saves a per-tool override from the tool permissions dialog", () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);
    fireEvent.click(row("Tool Permissions").getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog", { name: "Tool Permissions" });
    fireEvent.change(within(dialog).getByLabelText("Search tools"), { target: { value: "run_command" } });
    const tool = within(within(dialog).getByRole("group", { name: "Permission for run_command" }));
    fireEvent.click(tool.getByRole("button", { name: "deny" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save tool permissions" }));
    expect(readPolicies().toolRules).toEqual({ run_command: "deny" });
    expect(row("Tool Permissions").getByText(String(TOOL_NAMES.length))).toBeInTheDocument();
  });

  it("normalizes a pasted URL and rejects a value that is not a hostname", () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);
    fireEvent.click(row("Network Access Rules").getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog", { name: "Network Access Rules" });
    fireEvent.change(within(dialog).getByLabelText("Hostname"), { target: { value: "bad hostname!" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter a hostname");
    fireEvent.change(within(dialog).getByLabelText("Rule effect"), { target: { value: "deny" } });
    fireEvent.change(within(dialog).getByLabelText("Hostname"), { target: { value: "https://api.openai.com/v1/chat" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(within(dialog).getByText("api.openai.com")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save network rules" }));
    expect(readPolicies().networkRules).toContainEqual({ pattern: "api.openai.com", effect: "deny" });
  });

  it("lists remembered folders in the rail and saves a per-project override", () => {
    values.set("calvras_projects", JSON.stringify([{ name: "Calvras", path: "C:/repo/calvras" }]));
    render(<SettingsPanel open onOpenChange={vi.fn()} />);
    goto("Calvras");
    fireEvent.change(screen.getByLabelText("Project security preset"), { target: { value: "ask" } });
    expect(JSON.parse(values.get("calvras_project_policies") || "{}")).toEqual({ "C:/repo/calvras": { securityPreset: "ask" } });
    goto("General");
    fireEvent.click(row("Security Preset").getByRole("button", { name: /Modified in 1 project/ }));
    expect(screen.getByText("Calvras · ask")).toBeInTheDocument();
  });

  it("records application switches locally even without the desktop bridge", async () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);
    goto("Application");
    fireEvent.click(screen.getByRole("switch", { name: "Prevent Sleep" }));
    expect(readPolicies().preventSleep).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Enable Remote Control" }));
    expect(readPolicies().remoteControl).toBe(true);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/desktop app/i));
  });

  it("hands the device name to the desktop shell so the menu bar can show it", async () => {
    const setDeviceName = vi.fn(async (name: string) => ({ label: `Calvras — ${name}`, inMenuBar: false }));
    (window as unknown as { __electron?: unknown }).__electron = { setDeviceName };
    try {
      render(<SettingsPanel open onOpenChange={vi.fn()} />);
      goto("Application");
      fireEvent.change(screen.getByLabelText("Device Name"), { target: { value: "Studio Mini" } });
      await waitFor(() => expect(setDeviceName).toHaveBeenCalledWith("Studio Mini"));
      expect(readPolicies().deviceName).toBe("Studio Mini");
    } finally { delete (window as unknown as { __electron?: unknown }).__electron; }
  });

  it("keeps feedback on this computer and shows the activity log", () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);
    goto("Provide Feedback");
    fireEvent.change(screen.getByLabelText("Feedback"), { target: { value: "The agent stopped early." } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(JSON.parse(values.get("calvras_feedback") || "[]")[0]).toMatchObject({ text: "The agent stopped early." });
    goto("Account");
    fireEvent.click(screen.getByRole("switch", { name: "Enable Telemetry" }));
    expect(readPolicies().telemetry).toBe(false);
  });

  it("shows the Google account photo as the avatar, and the logo when there is none", () => {
    values.set("calvras_user", JSON.stringify({ provider: "google", email: "hello@calvras.com", name: "Shikari", picture: "https://lh3.googleusercontent.com/a/fixture", joinedAt: 1 }));
    render(<SettingsPanel open onOpenChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Account" }).querySelector("img")).toHaveAttribute("src", "https://lh3.googleusercontent.com/a/fixture");
    values.set("calvras_user", JSON.stringify({ provider: "google", email: "hello@calvras.com", joinedAt: 1 }));
    render(<SettingsPanel open onOpenChange={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: "Account" }).at(-1)!.querySelector("img")).toHaveAttribute("src", "/calvras-logo.png");
  });

  it("puts Usage above Shortcuts and totals the agent's real work", async () => {
    values.set("calvras_usage_log", JSON.stringify([{ at: Date.now(), kind: "task" }, { at: Date.now(), kind: "task" }]));
    values.set("calvras_chat_messages", JSON.stringify([{ role: "user" }, { role: "assistant" }, { role: "assistant" }]));
    const onOpenChange = vi.fn();
    const hrefs: string[] = [];
    const original = Object.getOwnPropertyDescriptor(window, "location");
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: { get href() { return "http://localhost:3000/app"; }, set href(value: string) { hrefs.push(value); } } });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => ({ ok: true, json: async () => String(input).endsWith("/api/agent/usage")
      ? { available: true, projects: 3, toolCalls: 41, failures: 2, byTool: [{ tool: "run_command", calls: 21, failures: 1 }, { tool: "write_file", calls: 20, failures: 1 }], tasksDone: 5, tasksOpen: 1, firstAt: Date.parse("2026-10-01T00:00:00.000Z"), lastAt: Date.now(), capped: false }
      : String(input).endsWith("/api/agent/payments") ? { hasKey: true, live: true, keyHint: "…88ba", merchantId: "" }
      : { ok: false, plans: [], error: "Calvras has no Payments AI merchant id saved yet." } })));
    try {
      render(<SettingsPanel open onOpenChange={onOpenChange} />);
      const rail = within(screen.getByRole("complementary"));
      const labels = rail.getAllByRole("button").map((button) => button.textContent);
      expect(labels.indexOf("Usage")).toBeGreaterThanOrEqual(0);
      expect(labels.indexOf("Usage")).toBeLessThan(labels.indexOf("Shortcuts"));

      goto("Usage");
      await waitFor(() => expect(screen.getByText("41")).toBeInTheDocument());
      expect(screen.getByText("What Calvras has actually done on this computer, and how to move up a plan.")).toBeInTheDocument();
      expect(screen.getByText("Tasks handed to the agent")).toBeInTheDocument();
      expect(screen.getByText("Replies written back")).toBeInTheDocument();
      expect(screen.getByText("Tool calls recorded · 2 failed")).toBeInTheDocument();
      expect(screen.getByText(new Date(Date.parse("2026-10-01T00:00:00.000Z")).toLocaleDateString())).toBeInTheDocument();
      expect(screen.getByText("run_command")).toBeInTheDocument();
      expect(screen.getByText("21 calls · 1 failed")).toBeInTheDocument();
      expect(row("Agent tasks").getByText("5 finished · 1 still open across those folders.")).toBeInTheDocument();
      expect(row("Store credential").getByText(/ends …88ba/)).toBeInTheDocument();

      const upgrade = screen.getByRole("button", { name: "Upgrade plan" });
      expect(upgrade).toHaveClass("settings-milk");
      fireEvent.click(upgrade);
      expect(hrefs).toEqual(["https://calvras.com/pricing"]);
      expect(onOpenChange).toHaveBeenCalledWith(false);

      // Payment belongs to the website: the pill opens the browser pricing page and never navigates the app.
      const openExternal = vi.fn(async () => true);
      Object.defineProperty(window, "__electron", { configurable: true, value: { openExternal } });
      fireEvent.click(screen.getByRole("button", { name: "Upgrade plan" }));
      await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://calvras.com/pricing"));
      expect(hrefs).toEqual(["https://calvras.com/pricing"]);
      delete (window as unknown as { __electron?: unknown }).__electron;
    } finally {
      if (original) Object.defineProperty(window, "location", original);
    }
  });

  it("closes from Escape and reports the close request", () => {
    const onOpenChange = vi.fn();
    render(<SettingsPanel open onOpenChange={onOpenChange} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
