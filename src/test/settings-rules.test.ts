// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ApprovalNeeded, PermissionScope, actionHost, actionProgram } from '../lib/runtime/permissions';
import { blockReason, hostMatches, sanitizePolicies } from '../lib/policy-rules';
import { policyNotes } from '../lib/system-prompt';
import { DEFAULT_POLICIES } from '../lib/preferences';
import type { ToolAction } from '../lib/tool-catalog';

const ask = (scope: PermissionScope, action: ToolAction) => {
  try { scope.require(action); return "ran"; }
  catch (error) { if (error instanceof ApprovalNeeded) return "asked"; throw error; }
};

describe("settings rules the agent cannot bypass", () => {
  it("reads the host out of the action, wherever it hides", () => {
    expect(actionHost({ type: "navigate_browser", url: "https://github.com/login" })).toBe("github.com");
    expect(actionHost({ type: "run_command", command: "curl -s https://api.openai.com/v1/models" })).toBe("api.openai.com");
    expect(actionHost({ type: "write_file", path: "src/app.tsx" })).toBe("");
    expect(actionProgram({ type: "run_command", command: "docker compose up" })).toBe("docker");
    expect(actionProgram({ type: "write_file", path: "a" })).toBe("");
  });

  it("matches a rule to its host and subdomains only", () => {
    expect(hostMatches("github.com", "api.github.com")).toBe(true);
    expect(hostMatches("github.com", "notgithub.com")).toBe(false);
    expect(hostMatches("https://github.com/foo", "github.com")).toBe(true);
  });

  it("blocks a denied tool even in Turbo Mode, without an approval prompt", () => {
    const scope = new PermissionScope("full", { toolRules: { delete_file: "deny" } });
    expect(() => scope.require({ type: "delete_file", path: "src/keep.ts" })).toThrow(/blocked in Settings/);
    expect(scope.list()).toHaveLength(0);
  });

  it("interrupts Turbo Mode for a tool set to ask, and silences the preset for one set to allow", () => {
    const gated = new PermissionScope("full", { toolRules: { git_push: "ask" } });
    expect(ask(gated, { type: "git_push" })).toBe("asked");
    const relaxed = new PermissionScope("ask", { toolRules: { write_file: "allow" } });
    expect(ask(relaxed, { type: "write_file", path: "a.ts", content: "x" })).toBe("ran");
  });

  it("denies a host for reading and a site for acting, separately", () => {
    const rules = { networkRules: [{ pattern: "evil.example", effect: "deny" as const }], browserRules: [{ pattern: "shop.example", effect: "deny" as const }] };
    const scope = new PermissionScope("full", rules);
    expect(() => scope.require({ type: "search_documentation", url: "https://evil.example/docs" })).toThrow(/denies evil.example/);
    expect(() => scope.require({ type: "click_element", selector: "#buy" })).not.toThrow();
    scope.mode = "automatic";
    expect(() => scope.require({ type: "navigate_browser", url: "https://shop.example/checkout" })).toThrow(/Browser Actuation Rules/);
  });

  it("lets a pre-approved command and an allowed host skip the prompt", () => {
    const scope = new PermissionScope("automatic", { outsideSandboxCommands: ["docker"], networkRules: [{ pattern: "registry.example", effect: "allow" }] });
    expect(ask(scope, { type: "run_command", command: "docker build ." })).toBe("ran");
    expect(ask(scope, { type: "run_command", command: "npm install gotrue" })).toBe("asked");
    expect(ask(scope, { type: "run_command", command: "curl https://registry.example/package" })).toBe("ran");
    expect(ask(scope, { type: "run_command", command: "rm -rf https://registry.example/x" })).toBe("asked");
  });

  it("holds edits back until the plan is approved, whatever the preset says", () => {
    const scope = new PermissionScope("full", { planReview: "ask" });
    expect(ask(scope, { type: "run_build" })).toBe("asked");
    expect(ask(scope, { type: "read_file", path: "a.ts" })).toBe("ran");
    scope.decision(scope.list()[0]!.id, "once");
    // The plan is cleared and full access owns the workspace, so the write runs. What still stops
    // for the user is the thing a quiet run cannot undo.
    expect(ask(scope, { type: "write_file", path: "a.ts", content: "x" })).toBe("ran");
    expect(ask(scope, { type: "delete_file", path: "a.ts" })).toBe("asked");
    scope.decision(scope.list().filter((item) => item.status === "pending").at(-1)!.id, "task");
    expect(ask(scope, { type: "write_file", path: "b.ts", content: "x" })).toBe("ran");
  });

  it("asks before the agent runs its own JavaScript in the page", () => {
    const scope = new PermissionScope("full", { browserJs: "ask" });
    expect(ask(scope, { type: "run_page_script", code: "document.title" })).toBe("asked");
    expect(ask(new PermissionScope("full"), { type: "run_page_script", code: "document.title" })).toBe("ran");
  });

  it("rejects junk coming over the wire and keeps the defaults", () => {
    const policies = sanitizePolicies({ toolRules: { read_file: "maybe", run_command: "deny" }, networkRules: [{ pattern: "https://a.com/x", effect: "no" }], outsideSandboxCommands: ["ok", "../bad"] });
    expect(policies.toolRules).toEqual({ run_command: "deny" });
    expect(policies.networkRules).toEqual([]);
    expect(policies.outsideSandboxCommands).toEqual(["ok"]);
    expect(sanitizePolicies(undefined).networkRules).toEqual(DEFAULT_POLICIES.networkRules);
  });

  it("tells the model about the rules it has to work around", () => {
    const notes = policyNotes(sanitizePolicies({ toolRules: { delete_file: "deny" }, browserRules: [{ pattern: "bank.example", effect: "deny" }], planReview: "ask", outsideSandboxCommands: ["docker"] }));
    expect(notes).toContain("[USER SETTINGS]");
    expect(notes).toContain("Plan review is ON");
    expect(notes).toContain("delete file");
    expect(notes).toContain("bank.example");
    expect(notes).toContain("docker");
    expect(policyNotes(DEFAULT_POLICIES)).toBe("");
    expect(blockReason({ toolRules: {}, networkRules: [], browserRules: [] }, "read_file", "", false)).toBe("");
  });
});
