import { describe, expect, it } from "vitest";
import { agentIntent, asksToReproduce } from "../lib/agent-intent";
import { CALVRAS_SYSTEM_PROMPT, workerSystemPrompt } from "../lib/system-prompt";

describe("automatic task continuation", () => {
  it.each(["launch it", "start the app", "can you check if it launches?", "run this project"])("inspects the selected project for %s", (text) => {
    expect(agentIntent(text, [], true)).toMatchObject({ requiresTools: true, initialActions: [{ type: "list_dir", path: "." }] });
  });
  it.each(["do it", "continue", "go ahead", "next step"])("resolves %s against the earlier request", (text) => {
    expect(agentIntent(text, ["hey", "launch the app"], true)).toMatchObject({ requiresTools: true, initialActions: [{ type: "list_dir", path: "." }], request: "launch the app" });
  });
  it("does not inspect files for greetings or explanations", () => {
    expect(agentIntent("hey", [], true).requiresTools).toBe(false);
    expect(agentIntent("how does the server run?", [], true).initialActions).toEqual([]);
  });
  it.each(["run tests", "run lint", "run the electron app", "build the app and start the server"])("keeps %s in the full task loop", (text) => {
    expect(agentIntent(text, [], true).finishOnServerReady).toBe(false);
  });
  it("keeps the server shortcut and does not invent a workspace", () => {
    expect(agentIntent("run the server", [], true).initialActions).toEqual([{ type: "read_file", path: "package.json" }]);
    expect(agentIntent("launch it", [], false).initialActions).toEqual([]);
  });
  it.each(["remove the hero section", "delete the sidebar", "add a footer", "change the button color", "fix the build", "help me search for jobs and apply"])("requires a real side effect for %s", (text) => {
    expect(agentIntent(text, [], true)).toMatchObject({ requiresTools: true, requiresWork: true });
  });
  it.each(["how do I remove a section?", "what does this error mean?", "take a screenshot", "check the logs"])("does not require a side effect for %s", (text) => {
    expect(agentIntent(text, [], true).requiresWork).toBe(false);
  });
  it("carries the side-effect requirement through a follow-up", () => {
    expect(agentIntent("do it", ["please remove that section"], true)).toMatchObject({ requiresWork: true, request: "please remove that section" });
  });
  it.each([
    'Use web_search once for "electron release notes"',
    "call delegate_task with role researcher",
    "read_file package.json and tell me the version",
  ])("keeps %s in the task loop because it names a real tool", (text) => {
    expect(agentIntent(text, [], true).requiresTools).toBe(true);
  });
  it("does not turn a greeting into work because a word looks like a tool", () => {
    expect(agentIntent("hey there", [], true).requiresTools).toBe(false);
    expect(agentIntent("what is a file?", [], true).requiresTools).toBe(false);
  });
  it("forbids the refusal the model invented once: that it may not use tools", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/never say you are restricted from using tools/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/names one of your tools, or asks you to look something up, is work/i);
  });
  it("gives a worker no delegation tools to reach for", () => {
    // The live researcher died on its own delegate_task call because the shared prompt
    // advertised one, so the worker prompt must not name those tools at all.
    const worker = workerSystemPrompt("researcher");
    for (const name of ["delegate_task", "ask_subagent", "read_agent", "list_agents", "cancel_agent"]) {
      expect(CALVRAS_SYSTEM_PROMPT).toContain(name);
      expect(worker).not.toContain(name);
    }
    expect(worker).toMatch(/you have no subagents of your own/i);
    // Everything else the worker needs is still there.
    expect(worker).toContain("read_file");
    expect(worker).toMatch(/web_search/);
  });
});

describe("screenshot as a build target", () => {
  it.each([
    "duplicate this screen",
    "recreate this exactly",
    "make it look like the image",
    "rebuild this ui from the screenshot",
    "same page as shown here",
  ])("arms the pixel comparison for %s", (text) => {
    expect(asksToReproduce(text)).toBe(true);
  });
  it.each([
    "what does this error say?",
    "why is this broken?",
    "explain this dashboard",
    "the app is slow, fix the query",
  ])("leaves %s as context, not a target", (text) => {
    expect(asksToReproduce(text)).toBe(false);
  });
});
