// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentSession } from "../lib/runtime/agent-runtime";
import { ApprovalNeeded } from "../lib/runtime/permissions";
import type { ToolAction } from "../lib/tool-catalog";

/** A saved key the machine does not hold, so the probe tests prove the runtime reaches the
 * store by provider name without depending on (or echoing) anybody's real credential. */
const SAVED_GEMINI_KEY = "AIzaTEST-ONLY-not-a-real-credential";
vi.mock("../lib/runtime/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime/providers")>();
  return {
    ...actual,
    providerKeys: () => ({ openrouter: "", gemini: SAVED_GEMINI_KEY, hf: "" }),
    providerKeySource: (provider: string) => (provider === "gemini" ? "the key saved in Calvras" : ""),
  };
});

let root: string;
let session: AgentSession;
const infer = vi.fn(async (prompt: string, _delta?: unknown, system?: string) => {
  if (system?.includes('"tasks"')) return JSON.stringify({ tasks: [{ title: "Inspect source", status: "pending" }] });
  if (system?.includes('"matches"')) return JSON.stringify({ matches: [{ path: "app.ts", reason: "Actual entry point" }, { path: "invented.ts", reason: "Invalid" }] });
  if (system?.includes('"content"')) return JSON.stringify({ content: "export const answer = 42;\n" });
  return "This code exports an answer.";
});
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-advanced-"));
  await fs.writeFile(path.join(root, "app.ts"), "export const answer = 40;\n");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node -e \"console.log('checks passed')\"" } }));
  await fs.writeFile(path.join(root, "AGENTS.md"), "Preserve public exports.");
  session = new AgentSession(root, "full", infer);
});
afterEach(async () => { session.stop(); vi.unstubAllGlobals(); if (path.resolve(root).startsWith(path.join(os.tmpdir(), "calvras-advanced-"))) await fs.rm(root, { recursive: true, force: true }); });
async function approve(action: ToolAction) {
  let id = "";
  try { return await session.execute(action); } catch (error) { if (error instanceof ApprovalNeeded) id = error.approval.id; else throw error; }
  expect(id).not.toBe(""); const { token } = session.decide(id, "once"); return session.execute(action, { approvalToken: token! });
}
describe("advanced runtime executes real operations", () => {
  it("plans and tracks tasks with persistent memory and project rules", async () => {
    const result = await session.execute({ type: "plan_tasks", task: "Inspect this project" });
    expect(result.tasks[0].title).toBe("Inspect source");
    await session.execute({ type: "track_progress", id: result.tasks[0].id, status: "done" });
    expect((await session.execute({ type: "read_task" })).tasks[0].status).toBe("done");
    await session.execute({ type: "write_memory", key: "style", value: "Preserve public exports" });
    expect((await session.execute({ type: "read_memory" })).rules).toContain("Preserve public exports");
    const reopened = new AgentSession(root, "automatic", infer); expect(reopened.context()).toContain("Preserve public exports"); reopened.stop();
  });
  it("generates and refactors actual files with recoverable checkpoints", async () => {
    for (const type of ["generate_tests", "generate_documentation", "refactor_code"] as const) {
      // Even in full access these write files, so each one is approved before it runs.
      const result = await approve({ type, path: "app.ts", ...(type === "generate_tests" ? { outputPath: "app.test.ts" } : {}) });
      expect(result.ok).toBe(true); expect(result.checkpointId).toBeTruthy();
    }
    expect(await fs.readFile(path.join(root, "app.test.ts"), "utf8")).toContain("42");
    expect(await fs.readFile(path.join(root, "app.ts.md"), "utf8")).toContain("42");
    expect(await fs.readFile(path.join(root, "app.ts"), "utf8")).toContain("42");
    expect((await session.execute({ type: "explain_code", path: "app.ts" })).message).toContain("exports");
  });
  it("runs relevant verification and detects actual source patterns", async () => {
    expect((await session.execute({ type: "verify_changes", check: "run_tests" })).output).toContain("checks passed");
    await fs.writeFile(path.join(root, "unsafe.ts"), "eval(userInput)");
    const result = await session.execute({ type: "detect_security_issues" });
    expect(result.findings).toContainEqual({ path: "unsafe.ts", line: 1, code: "dynamic-evaluation" });
  });
  it("uses semantic ranking only for actual files and hides environment values", async () => {
    const ranked = await session.execute({ type: "semantic_search", query: "Where does the answer come from?" });
    expect(ranked.matches).toHaveLength(1); expect(ranked.matches[0].path).toBe("app.ts");
    const secret = "fixture-test-private-value";
    const result = await approve({ type: "manage_environment_variables", operation: "set", key: "SERVICE_KEY", value: secret });
    expect(result.value).toBe("[redacted]"); expect(JSON.stringify(session.status())).not.toContain(secret);
    expect(await fs.readFile(path.join(root, ".env.local"), "utf8")).toContain(secret);
    expect((await session.execute({ type: "read_file", path: ".env.local" })).ok).toBe(false);
  });
  it("fetches docs and GitHub in full access without inventing results", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(String(url).includes("github") ? JSON.stringify({ name: "fixture-repo" }) : "<main>Official documentation</main>", { headers: { "Content-Type": String(url).includes("github") ? "application/json" : "text/html" } })));
    expect((await session.execute({ type: "search_documentation", url: "https://example.org/docs" })).content).toContain("Official documentation");
    expect((await session.execute({ type: "github_request", endpoint: "/repos/example/fixture" })).data.name).toBe("fixture-repo");
  });
  it("executes an approved deployment command against a local fixture", async () => {
    const result = await approve({ type: "deploy_application", command: "node -e \"console.log('deployment command completed')\"" });
    expect(result.ok).toBe(true); expect(result.output).toContain("deployment command completed");
  });
  it("provides explicit questions and never hides unsupported setup", async () => {
    expect(await session.execute({ type: "ask_user", question: "Which account?" })).toMatchObject({ needsInput: true, question: "Which account?" });
    expect(await approve({ type: "request_user_approval", question: "May I continue?" })).toMatchObject({ approved: true, decidedBy: "full_access_mode" });
    expect(await session.execute({ type: "list_mcp_tools" })).toMatchObject({ tools: [], needsSetup: expect.any(String) });
  });
  it("refuses an ask_user that carries no question instead of showing a blank card", async () => {
    // The user got a card reading "What information is missing?" with an empty answer box: the
    // runtime's fallback for a question the model never put in its question field.
    await expect(session.execute({ type: "ask_user", options: ["Enter API Key"] } as ToolAction)).rejects.toThrow(/question field/);
  });
  it("searches the live web and reports only the citations the engine returned", async () => {
    const html = `<a class="result__a" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent("https://tanstack.com/start")}&amp;rut=x">TanStack Start</a><a class="result__snippet" href="#">The full-stack framework for React.</a>`;
    const fetchStub = vi.fn(async () => new Response(html, { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    const result = await session.execute({ type: "web_search", query: "tanstack start" });
    expect(result.ok).toBe(true);
    expect(result.results).toEqual([{ title: "TanStack Start", url: "https://tanstack.com/start", snippet: "The full-stack framework for React." }]);
    expect(result.engine).toBe("DuckDuckGo");
    expect(String(result.instruction)).toContain("do not add any you were not given");
  });
  it("says the search failed instead of returning an empty success the model could pad", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>rate limited</html>", { status: 200 })));
    const result = await session.execute({ type: "web_search", query: "anything" });
    expect(result.ok).toBe(false);
    expect(result.results).toBeUndefined();
    expect(String(result.error)).toContain("No web engine returned results");
    expect(result.engines.map((attempt: any) => attempt.engine)).toEqual(["DuckDuckGo", "DuckDuckGo Lite"]);
  });
  it("refuses to treat a pressed-control flag as approval for a tool the agent chose", async () => {
    // Full access owns the workspace, so a write or a delete no longer proves anything here. The
    // probe is a git restore instead: only the chat's own Undo and Apply/Discard buttons may carry
    // that flag, and the runtime checks the action type, so it still asks the user.
    await session.execute({ type: "write_file", path: "keep.ts", content: "x" }, {});
    await expect(session.execute({ type: "git_restore", path: "keep.ts" }, { userInitiated: true })).rejects.toBeInstanceOf(ApprovalNeeded);
    expect(await fs.stat(path.join(root, "keep.ts")).then(() => true, () => false)).toBe(true);
  });
});
describe("probe_key tests a key the user names or one Calvras already holds", () => {
  /** The endpoint the probe hits is chosen by the harness, so the assertions are about what the
   * runtime sends and what it hands back — never about a live provider account. */
  function stubFetch(status: number, body: string) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any) => {
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(body, { status });
    }));
    return calls;
  }
  it("reaches the stored key from a provider name alone and sends it to that provider's endpoint", async () => {
    const calls = stubFetch(200, `{"models":["gemini-2.5-flash"], "key":"${SAVED_GEMINI_KEY}"}`);
    const result = await session.execute({ type: "probe_key", provider: "gemini" });
    expect(result.status).toBe(200);
    expect(calls[0]?.url).toContain("generativelanguage.googleapis.com");
    expect(calls[0]?.headers["x-goog-api-key"]).toBe(SAVED_GEMINI_KEY);
    // An endpoint that echoes the credential back must not put it in front of the model or the user.
    expect(JSON.stringify(result)).not.toContain(SAVED_GEMINI_KEY);
    expect(result.response).toContain("[redacted]");
    // Which copy answered is part of the answer: an environment variable can shadow the saved key,
    // and a rejection means something different for each of them.
    expect(result.keySource).toBe("the key saved in Calvras");
  });
  it("says plainly when the named provider has no key saved rather than probing a blank header", async () => {
    const calls = stubFetch(200, "{}");
    const result = await session.execute({ type: "probe_key", provider: "hf" });
    expect(String(result.error)).toContain("No key is saved for hf");
    expect(calls.length).toBe(0);
  });
  it("names every way to supply a key when the call carries neither a url nor a provider", async () => {
    const result = await session.execute({ type: "probe_key" });
    expect(String(result.error)).toContain("needs a url, or a provider name");
  });
  it("refuses a provider it cannot resolve instead of silently probing the wrong account", async () => {
    const result = await session.execute({ type: "probe_key", provider: "anthropic" });
    expect(String(result.error)).toContain('one of "gemini", "openrouter" or "hf"');
  });
  it("calls a rejected key rejected", async () => {
    stubFetch(401, `{"error":{"message":"No credentials provided for key sk-or-v1-FAKETHISISNOTREAL"}}`);
    const result = await session.execute({ type: "probe_key", url: "https://openrouter.ai/api/v1/auth/key", key: "sk-or-v1-FAKETHISISNOTREAL" });
    expect(result.status).toBe(401);
    expect(String(result.verdict)).toContain("REJECTED");
    expect(JSON.stringify(result)).not.toContain("FAKETHISISNOTREAL");
  });
  it("calls an unfunded account a billing wall, not a broken key", async () => {
    stubFetch(402, `{"error":{"message":"You have no credits"}}`);
    const result = await session.execute({ type: "probe_key", url: "https://huggingface.co/api/v1/inference/any", key: "hf_FAKEFORSAMPLEONLY000000" });
    expect(String(result.verdict)).toContain("billing wall");
    expect(JSON.stringify(result)).not.toContain("hf_FAKEFORSAMPLEONLY000000");
  });
  it("refuses an http endpoint, since a key must never travel unencrypted", async () => {
    const result = await session.execute({ type: "probe_key", url: "http://example.com/any", key: "anything" });
    expect(String(result.error)).toContain("HTTPS");
  });
});
