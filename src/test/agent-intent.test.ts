import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { agentIntent, asksToReproduce } from "../lib/agent-intent";
import { CALVRAS_SYSTEM_PROMPT, workerSystemPrompt } from "../lib/system-prompt";
import { ApprovalNeeded, PermissionScope } from "../lib/runtime/permissions";
import { DEFAULT_POLICIES } from "../lib/policy-rules";

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

/** Each rule here exists because a real build of the user's got it wrong. */
describe("the rules a real build taught it", () => {
  it("knows the company behind it", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/built by Calvras, the company/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/never claim to be nameless/i);
  });
  it("builds a mobile ask as a mobile app at phone size", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/means a mobile app, not a web page/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/390x844/);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/never downgrades a mobile request/i);
  });
  it("reproduces vectors and real 3d, and researches a technique it cannot see", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/real inline SVG paths/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/three\.js/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/a research step rather than a guess/i);
  });
  it("breaks out of a failing install instead of looping on it", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/two failed attempts on the same package is the limit/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/never spend a run reinstalling/i);
  });
  it("keeps the narration human and spends thinking where it pays", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/banned as an update/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/never re-open a file you just read/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/calm, precise software engineer/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/never insulting/i);
  });
  it("grants full access over the workspace but not over removal", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/Full access buys the WORKSPACE AND THE TERMINAL/);
    const scope = new PermissionScope("full");
    expect(() => scope.require({ type: "write_file", path: "a.ts", content: "x" })).not.toThrow();
    expect(() => scope.require({ type: "search_replace", path: "a.ts", search: "x", replace: "y" })).not.toThrow();
    expect(() => scope.require({ type: "delete_file", path: "a.ts" })).toThrow(ApprovalNeeded);
    expect(() => scope.require({ type: "undo_edit", checkpointId: "cp-1" })).toThrow(ApprovalNeeded);
    expect(() => scope.require({ type: "resolve_worker", id: "job-1", action: "apply" })).toThrow(ApprovalNeeded);
  });
  it("takes the running task over when the user sends during it", async () => {
    expect(DEFAULT_POLICIES.queuedDelivery).toBe("interrupt");
    const source = await readFile("src/routes/index.tsx", "utf8");
    const start = source.indexOf("if (isLoading) {");
    const branch = source.slice(start, source.indexOf("if (runtimeRef.current &&", start));
    expect(branch).toContain('delivery === "immediate"');
    expect(branch).toContain('delivery === "queue"');
    expect(/handleStop\(\);\s*\}\s*$/.test(branch)).toBe(true);
    expect(branch.indexOf("writeQueue")).toBeGreaterThan(branch.indexOf('delivery === "queue"'));
  });
});
