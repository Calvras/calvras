import { describe, expect, it, vi } from "vitest";
import { parseAgentReply, runAgent, type ToolFeedback } from "../lib/agent-run";

const reply = (message: string, actions: unknown[] = [], status = "complete") => JSON.stringify({ message, actions, status });
const list = { type: "list_dir", path: "." } as const;
const command = { type: "run_command", command: "npm run build" } as const;
function options(responses: string[]) {
  return {
    prompt: "Inspect the project and build it", signal: new AbortController().signal,
    infer: vi.fn().mockImplementation(async () => responses.shift()),
    execute: vi.fn().mockImplementation(async (actions) => actions.map((action: ToolFeedback["action"]) => ({ action, ok: true, result: { entries: [{ name: "package.json" }], exitCode: 0 } }))),
    onFeedback: vi.fn(), maxSteps: 5,
  };
}
describe("real agent loop", () => {
  it("requires page inspection after opening the browser", async () => {
    const config=options([reply("Open.",[{type:"open_browser",url:"http://localhost:3000"}],"continue"),reply("Verified."),reply("Inspect.",[{type:"inspect_element",selector:"body"}],"continue"),reply("Page verified.")]);
    expect((await runAgent(config)).status).toBe("finished");
    expect(config.infer.mock.calls[2]?.[0]).toContain("Opening a browser is not UI verification");
  });
  // The failure the user saw: a chat answer landed, and the loop asked for it again under Thinking…,
  // three times, because a no-action round always counted as a round that had to keep working.
  it("ends a conversation turn on its first reply instead of asking again", async () => {
    const onPhaseComplete = vi.fn();
    const config = { ...options([reply("1. Python\n2. Go", [], "continue")]), onPhaseComplete };
    const outcome = await runAgent(config);
    expect(outcome).toMatchObject({ status: "finished", message: "1. Python\n2. Go" });
    expect(config.infer).toHaveBeenCalledTimes(1);
    expect(config.execute).not.toHaveBeenCalled();
    expect(onPhaseComplete).toHaveBeenCalledWith("1. Python\n2. Go");
  });
  it("keeps a submitted target closed when the receipt it quoted was never read", async () => {
    const config = options([
      reply("Read the listing, queued it.", [{ type: "read_page" }, { type: "queue_batch", title: "jobs", targets: [{ url: "http://127.0.0.1/post/4", label: "Data Engineer" }] }], "continue"),
      reply("Applied to it.", [{ type: "report_batch", id: "post/4", status: "done", reference: "REF-9F3A" }], "continue"),
      reply("Reading what the site actually said.", [{ type: "read_page" }], "continue"),
      reply("Now it really went in.", [{ type: "report_batch", id: "post/4", status: "done", reference: "48466F17" }], "continue"),
      reply("One application, confirmed by the page."),
    ]);
    config.maxSteps = 8;
    config.execute.mockImplementation(async (actions: any[]) => actions.map((action) => ({
      action,
      ok: true,
      result: action.type === "read_page"
        ? { text: 'Data Engineer <a href="http://127.0.0.1/post/4">apply</a> — Application received — Cobalt. Reference 48466F17' }
        : action.type === "queue_batch" || action.type === "report_batch" ? { queued: 0, running: 0, done: 1, blocked: 0, skipped: 0 }
          : { exitCode: 0 },
    })));
    const outcome = await runAgent(config);
    const prompts = config.infer.mock.calls.map((call: string[]) => String(call[0]));
    const nudged = prompts.find((prompt) => prompt.includes("[BATCH RECEIPT UNREAD]"));
    expect(nudged).toContain("REF-9F3A");
    expect(nudged).toContain("do not send it again");
    // Finished work never goes back on the queue: reopening it is what made a live run submit the same
    // posting twice, because a second application looks like a faster way to earn the receipt.
    const reopened = config.execute.mock.calls.filter((call: any[]) => (call[0] as any[]).some((action) => action.type === "report_batch" && action.status === "running"));
    expect(reopened).toHaveLength(0);
    expect(prompts.some((prompt) => prompt.includes("[BATCH TARGET UNSEEN]"))).toBe(false);
    expect(outcome.status).toBe("finished");
  });
  it("does not execute repeated unchanged inspections and advances to edits", async () => {
    const config = options([reply("Read.",[list],"continue"),reply("Read again.",[list],"continue"),reply("Implement.",[{type:"write_file",path:"app.ts",content:"export const ready=true"}],"continue"),reply("Verify.",[{type:"run_tests"}],"continue"),reply("Verified.")]);
    expect((await runAgent(config)).status).toBe("finished");
    expect(config.execute).toHaveBeenCalledTimes(3);
    expect(config.infer.mock.calls[2]?.[0]).toContain("REPEATED INSPECTION BLOCKED");
  });
  it("runs the model's launch action from inspected files and lets the model confirm readiness", async () => {
    const config = options([]);
    const onPhaseComplete = vi.fn();
    config.execute.mockResolvedValueOnce([{ action: list, ok: true, result: { entries: [{ path: "package.json", type: "file" }] } }])
      .mockResolvedValueOnce([{ action: { type: "start_server", command: "pnpm run dev" }, ok: true, result: { ready: true, url: "http://localhost:5173" } }]);
    config.infer.mockImplementation(async (prompt: string) => prompt.includes("[SERVER READY]")
      ? reply("The server is running at http://localhost:5173 and responds to requests.")
      : reply("The dev script is available. Starting it now.", [{ type: "start_server", command: "pnpm run dev" }], "continue"));
    const outcome = await runAgent({ ...config, initialActions: [list], finishOnServerReady: true, onPhaseComplete });
    expect(outcome.status).toBe("finished");
    expect(config.execute).toHaveBeenNthCalledWith(1, [list]);
    expect(config.execute).toHaveBeenLastCalledWith([{ type: "start_server", command: "pnpm run dev" }]);
    expect(config.infer).toHaveBeenCalledTimes(2);
    expect(onPhaseComplete).toHaveBeenLastCalledWith("The server is running at http://localhost:5173 and responds to requests.");
  });
  it("probes a server the model claims is live instead of accepting the claim", async () => {
    const config = options([
      reply("Wrote the API.", [{ type: "write_file", path: "server.mjs", content: "export const x=1" }], "continue"),
      reply("Ran it once.", [{ type: "run_command", command: "node --check server.mjs" }], "continue"),
      reply("The roster API is verified by starting the server successfully on port 4134."),
      reply("It listens now.", [{ type: "start_server", command: "node server.mjs" }], "continue"),
      reply("The server is running at http://localhost:4134 and answers requests."),
    ]);
    config.maxSteps = 8;
    config.execute.mockImplementation(async (actions: any[]) => actions.map((action) => ({
      action,
      ok: true,
      result: action.type === "check_server" ? { ready: false, running: false, output: "No managed server is running." }
        : action.type === "start_server" ? { ready: true, url: "http://localhost:4134" }
          : { entries: [], exitCode: 0 },
    })));
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("finished");
    // the loop injected its own check_server probe before allowing completion
    expect(config.infer.mock.calls[3]?.[0]).toContain("SERVER NOT LISTENING");
    expect(config.execute.mock.calls.some((call) => (call[0] as any[]).some((action) => action.type === "check_server"))).toBe(true);
  });
  it("refuses to finish a port task whose service is not listening", async () => {
    const config = options([
      reply("Wrote it.", [{ type: "write_file", path: "server.mjs", content: "export const server=1" }], "continue"),
      reply("All routes work.", [{ type: "run_tests" }], "continue"),
      reply("The roster API is complete and every test passes."),
      reply("Now it stays up.", [{ type: "start_server", command: "node server.mjs" }], "continue"),
      reply("Roster API listening on port 4134."),
    ]);
    config.prompt = "Build server.mjs: the server listens on port 4134 and stores users in node:sqlite.";
    config.maxSteps = 8;
    config.execute.mockImplementation(async (actions: any[]) => actions.map((action) => ({
      action,
      ok: true,
      result: action.type === "check_server" ? { ready: false, running: false, output: "No managed server is running." }
        : action.type === "start_server" ? { ready: true, url: "http://localhost:4134" }
          : { entries: [], exitCode: 0 },
    })));
    expect((await runAgent(config)).status).toBe("finished");
    expect(config.infer.mock.calls.some((call) => String(call[0]).includes("Port 4134 answers nothing"))).toBe(true);
  });
  it("notes verified readiness to the model instead of a canned completion message", async () => {
    const config = options([
      reply("Starting the server.", [{ type: "start_server", command: "npm run dev" }], "continue"),
      reply("The server is running at http://localhost:3000 and responding."),
    ]);
    config.execute.mockResolvedValue([{ action: { type: "start_server", command: "npm run dev" }, ok: true, result: { ready: true, url: "http://localhost:3000" } }]);
    const outcome = await runAgent({ ...config, finishOnServerReady: true });
    expect(outcome.status).toBe("finished");
    expect(outcome.message).toContain("http://localhost:3000");
    expect(config.infer).toHaveBeenCalledTimes(2);
    expect(config.infer.mock.calls[1]?.[0]).toContain("[SERVER READY]");
  });
  it("treats no-workspace skipped actions as guidance, not executed work or failures", async () => {
    const onPhaseComplete = vi.fn();
    const config = options([reply("I'll look around.", [list], "continue"), reply("Hey! What would you like to talk about?")]);
    config.execute.mockResolvedValue([{ action: list, ok: false, result: { skipped: true, noWorkspace: true, error: "No project folder is selected and this message is conversation." } }]);
    const outcome = await runAgent({ ...config, onPhaseComplete });
    expect(outcome.status).toBe("finished");
    expect(outcome.message).toBe("Hey! What would you like to talk about?");
    expect(config.infer.mock.calls[1]?.[0]).toContain("No project folder is selected and this message is conversation");
    expect(config.infer.mock.calls[1]?.[0]).not.toContain("Previous tools failed");
    expect(onPhaseComplete).toHaveBeenLastCalledWith("Hey! What would you like to talk about?");
  });
  it("finishes with the model's own report when a command legitimately fails", async () => {
    const report = "The command failed with MODULE_NOT_FOUND, and the directory listing proves the file is absent.";
    const config = options([
      reply("Triggering the failure.", [{ type: "run_command", command: "node missing.js" }], "continue"),
      reply(report), reply(report), reply(report), reply(report), reply(report),
    ]);
    config.maxSteps = 10;
    config.execute.mockResolvedValue([{ action: { type: "run_command", command: "node missing.js" }, ok: false, result: { exitCode: 1, output: "Error: Cannot find module 'missing.js'" } }]);
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("finished");
    expect(outcome.message).toEqual(report);
  });
  it("executes a legacy plan automatically without a separate approval step", async () => {
    const onPhaseComplete = vi.fn();
    const config = options([
      JSON.stringify({ message: "I'll read the entry point.", plan: "Read the entry point", actions: [], status: "complete" }),
      reply("Reading the entry point.", [list], "continue"),
      reply("Found the project entry point."),
    ]);
    expect((await runAgent({ ...config, requiresTools: true, onPhaseComplete })).status).toBe("finished");
    expect(config.execute).toHaveBeenCalledExactlyOnceWith([list]);
    expect(onPhaseComplete.mock.calls.map(([message]) => message)).toEqual(["I'll read the entry point.", "Reading the entry point.", "Found the project entry point."]);
  });
  it("takes the first server inspection action before invoking inference", async () => {
    const events: string[] = [];
    const config = options([reply("Ready.")]);
    const originalExecute = config.execute.getMockImplementation()!;
    config.execute.mockImplementation(async (actions) => { events.push("inspect"); return originalExecute(actions); });
    config.infer.mockImplementation(async () => { events.push("infer"); return reply("The scripts are available."); });
    await runAgent({ ...config, initialActions: [{ type: "read_file", path: "package.json" }] });
    expect(events).toEqual(["inspect", "infer"]);
  });
  it("streams the public reply before inference completes", async () => {
    const onMessageDelta = vi.fn();
    const config = options([]);
    config.infer.mockImplementation(async (_prompt, onDelta) => {
      onDelta('{"message":"Reading the file');
      expect(onMessageDelta).toHaveBeenCalledWith("Reading the file");
      return reply("Hello.");
    });
    await runAgent({ ...config, onMessageDelta });
  });
  it("runs a type check itself when the model claims completion without verification", async () => {
    const config = options([reply("Updating.", [{ type: "write_file", path: "app.ts", content: "export {}" }], "continue"), reply("Done."), reply("Verified.")]);
    expect((await runAgent(config)).status).toBe("finished");
    expect(config.execute).toHaveBeenNthCalledWith(2, [{ type: "run_typecheck" }]);
    expect(config.infer.mock.calls[2]?.[0]).toContain("[AUTO-VERIFY]");
  });
  it("finishes with the model's own report when the automatic check is unsuitable for the project", async () => {
    const config = options([
      reply("Updating.", [{ type: "write_file", path: "app.ts", content: "export {}" }], "continue"),
      reply("Done."),
      reply("This project has no typecheck script, so the build is the right check."),
      reply("The build is the check here; nothing failed."),
      reply("The edit is in place and the project has no typecheck script."),
      reply("Nothing else is pending; the failing check was the typecheck script that does not exist."),
      reply("All changes are complete and the build output confirms them."),
    ]);
    config.maxSteps = 12;
    config.execute.mockImplementation(async (actions) => actions.map((action: ToolFeedback["action"]) => action.type === "run_typecheck" ? { action, ok: false, result: { error: "Missing script: typecheck" } } : { action, ok: true, result: { exitCode: 0 } }));
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("finished");
    expect(outcome.message).toContain("complete");
    expect(config.infer.mock.calls[2]?.[0]).toContain("run a more appropriate check");
    expect(config.infer.mock.calls[2]?.[0]).toContain("it reported problems");
  });
  it("checks server readiness before reporting completion", async () => {
    const config = options([reply("Starting.", [{ type: "start_server", command: "npm run dev" }], "continue"), reply("Done."), reply("Checking.", [{ type: "check_server" }], "continue"), reply("Server ready.")]);
    config.execute.mockResolvedValueOnce([{ action: { type: "start_server", command: "npm run dev" }, ok: true, result: { ready: false, running: true } }]).mockResolvedValueOnce([{ action: { type: "check_server" }, ok: true, result: { ready: true, url: "http://localhost:3000" } }]);
    expect((await runAgent(config)).status).toBe("finished");
    expect(config.execute).toHaveBeenCalledTimes(2);
  });
  it("does not mistake a file read for server readiness", async () => {
    const config = options([reply("Starting.", [{ type: "start_server", command: "npm run dev" }], "continue"), reply("Reading.", [list], "continue"), reply("Done."), reply("The server is still starting.", [], "blocked")]);
    config.execute.mockResolvedValueOnce([{ action: { type: "start_server", command: "npm run dev" }, ok: true, result: { ready: false } }]).mockResolvedValueOnce([{ action: list, ok: true, result: { entries: [] } }]);
    expect((await runAgent(config)).status).toBe("blocked");
    expect(config.infer.mock.calls[3]?.[0]).toContain("check_server readiness");
  });
  it("accepts a verified alternative build command after replanning", async () => {
    const config = options([reply("Building.", [command], "continue"), reply("Using the actual build tool.", [{ type: "run_command", command: "npx vite build" }], "continue"), reply("Build verified.")]);
    config.execute.mockResolvedValueOnce([{ action: command, ok: false, result: { exitCode: 1 } }]).mockResolvedValueOnce([{ action: { type: "run_command", command: "npx vite build" }, ok: true, result: { exitCode: 0 } }]);
    expect((await runAgent(config)).status).toBe("finished");
  });
  it("does not spend a whole run announcing a plan without acting", async () => {
    const config = { ...options([reply("I'll plan.", [], "continue"), reply("Still planning.", [], "continue"), reply("Replanning.", [], "continue"), reply("Almost there.", [], "continue"), reply("One more plan.", [], "continue")]), requiresTools: true, maxSteps: 20 };
    expect((await runAgent(config)).status).toBe("blocked");
    expect(config.infer).toHaveBeenCalledTimes(5);
  });
  it("parses code containing braces inside JSON strings", () => {
    expect(parseAgentReply(reply("Update.", [{ type: "write_file", path: "x.ts", content: "const brace = '}';" }])).actions).toHaveLength(1);
  });
  it("publishes a conversational answer without tool calls", async () => {
    const onPhaseComplete = vi.fn();
    const config = { ...options([reply("Hey! What would you like to work on?")]), onPhaseComplete };
    expect((await runAgent(config)).status).toBe("finished");
    expect(onPhaseComplete).toHaveBeenCalledExactlyOnceWith("Hey! What would you like to work on?");
    expect(config.execute).not.toHaveBeenCalled();
  });
  it("publishes the final answer after tool phases", async () => {
    const onPhaseComplete = vi.fn();
    const config = { ...options([reply("Checking files.", [list], "continue"), reply("Found package.json.")]), onPhaseComplete };
    await runAgent(config);
    expect(onPhaseComplete.mock.calls.map(([message]) => message)).toEqual(["Checking files.", "Found package.json."]);
  });
  it("publishes a blocked explanation", async () => {
    const onPhaseComplete = vi.fn();
    await runAgent({ ...options([reply("Select a project folder first.", [], "blocked")]), onPhaseComplete });
    expect(onPhaseComplete).toHaveBeenCalledExactlyOnceWith("Select a project folder first.");
  });
  it("retains tool results across multiple actions and updates", async () => {
    const config = options([reply("I'll inspect the folder.", [list], "continue"), reply("The project has a build script; I'll run it.", [command], "continue"), reply("Build passed.")]);
    const result = await runAgent(config);
    expect(result.status).toBe("finished");
    expect(config.execute).toHaveBeenCalledTimes(2);
    expect(config.onFeedback.mock.calls.map((call) => call[0]).filter(Boolean)).toEqual(["I'll inspect the folder.", "The project has a build script; I'll run it."]);
    const finalPrompt = config.infer.mock.calls[2]?.[0];
    expect(finalPrompt).toContain("package.json");
    expect(finalPrompt).toContain("npm run build");
  });
  it("does not accept completion with unresolved failed tools", async () => {
    const config = options([reply("I'll run the build.", [command], "continue"), reply("Everything is done."), reply("The build failed and needs configuration.", [], "blocked")]);
    config.execute.mockResolvedValue([{ action: command, ok: false, result: { exitCode: 1, output: "Missing script: build" } }]);
    expect((await runAgent(config)).status).toBe("blocked");
    expect(config.infer.mock.calls[2]?.[0]).toContain("Previous tools failed");
  });
  it("does not treat a promised inspection as work performed", async () => {
    const config = { ...options([reply("I'll inspect your folder."), reply("I'll list the files.", [list], "continue"), reply("Found package.json.")]), requiresTools: true };
    expect((await runAgent(config)).status).toBe("finished");
    expect(config.execute).toHaveBeenCalledTimes(1);
  });
  it("requires a failed command to pass again even after unrelated successful work", async () => {
    const config = options([reply("I'll build.", [command], "continue"), reply("I'll inspect.", [list], "continue"), reply("All done."), reply("The build is still failing.", [], "blocked")]);
    config.execute.mockResolvedValueOnce([{ action: command, ok: false, result: { exitCode: 1 } }]).mockResolvedValueOnce([{ action: list, ok: true, result: { entries: [] } }]);
    expect((await runAgent(config)).status).toBe("blocked");
  });
  it("reports the action limit instead of claiming success", async () => {
    const config = { ...options([reply("I'll inspect.", [list], "continue")]), maxSteps: 1 };
    expect(await runAgent(config)).toEqual({ status: "limit" });
  });
  it("stops before executing actions after cancellation", async () => {
    const controller = new AbortController();
    const config = { ...options([]), signal: controller.signal, infer: vi.fn(async () => { controller.abort(); return reply("I'll inspect.", [list]); }) };
    expect(await runAgent(config)).toEqual({ status: "stopped" });
    expect(config.execute).not.toHaveBeenCalled();
  });
  it("does not accept a completion claim when a requested change had no effect", async () => {
    const config = { ...options([reply("I removed that section for you."), reply("It is gone now."), reply("I could not change it.", [], "blocked")]), requiresTools: true, requiresWork: true };
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("blocked");
    expect(config.infer.mock.calls[1]?.[0]).toContain("nothing in the workspace has changed");
    expect(config.infer.mock.calls[1]?.[0]).toContain("not a substitute");
  });
  it("stops on the agent's own words and never recites the run state to the user", async () => {
    const stuck = [reply("I removed the section."), reply("It is gone now."), reply("Really, it is gone."), reply("The folder is unchanged? No."), reply("I am done.")];
    const config = { ...options(stuck), requiresTools: true, requiresWork: true, maxSteps: 12 };
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("blocked");
    // The loop keeps its own bookkeeping out of the chat: no canned sentence about what stayed
    // open, no instruction to retry. The agent's last line is what the user keeps.
    expect(outcome.error).toBeUndefined();
    expect(outcome.message).toBe("I am done.");
    expect(config.infer).toHaveBeenCalledTimes(5);
  });
  it("keeps a run alive through a malformed reply instead of ending the turn", async () => {
    const config = { ...options([reply("Writing.", [{ type: "write_file", path: "app.ts" }], "continue"), "not json at all", reply("Writing it properly.", [{ type: "write_file", path: "app.ts", content: "export {}" }], "continue"), reply("Verifying.", [{ type: "run_typecheck" }], "continue"), reply("Done.")]), maxSteps: 20 };
    expect((await runAgent(config)).status).toBe("finished");
    expect(config.infer.mock.calls[1]?.[0]).toContain("RESPONSE FORMAT ERROR");
  });
  it("will not let a run finish while its own phase plan still has steps", async () => {
    const plan = [
      reply("Planning.", [{ type: "create_task_list", tasks: [{ id: "1", title: "Shell", status: "pending" }, { id: "2", title: "Feed", status: "pending" }] }], "continue"),
      reply("Step one done.", [{ type: "track_progress", id: "1", status: "done" }], "continue"),
      reply("All finished, the app is ready."),
      reply("Building the feed.", [{ type: "write_file", path: "feed.ts", content: "export const feed = []" }], "continue"),
      reply("Marking it.", [{ type: "track_progress", id: "2", status: "done" }], "continue"),
      reply("Checked.", [{ type: "run_typecheck" }], "continue"),
      reply("The feed is built too."),
    ];
    const config = { ...options(plan), maxSteps: 20 };
    const board: { id: string; title: string; status: string }[] = [];
    config.execute.mockImplementation(async (actions: any[]) => actions.map((action) => {
      if (action.type === "create_task_list") { board.length = 0; board.push(...action.tasks.map((task: any) => ({ ...task }))); }
      if (action.type === "track_progress") { const task = board.find((item) => item.id === action.id); if (task) task.status = action.status; }
      return { action, ok: true, result: ["create_task_list", "track_progress"].includes(action.type) ? { tasks: board } : { entries: [], exitCode: 0 } };
    }));
    expect((await runAgent(config)).status).toBe("finished");
    expect(config.infer.mock.calls[2]?.[0]).toContain('the next unfinished step is "Feed"');
    expect(config.infer.mock.calls[3]?.[0]).toContain("PLAN HAS STEPS LEFT");
    expect((config.execute.mock.calls[2]?.[0] as any[])[0].type).toBe("write_file");
  });
  it("accepts completion once a change request produced real work", async () => {    const config = { ...options([reply("Editing.", [{ type: "write_file", path: "app.ts", content: "export {}" }], "continue"), reply("Verifying.", [{ type: "run_typecheck" }], "continue"), reply("Removed the section.")]), requiresTools: true, requiresWork: true };
    expect((await runAgent(config)).status).toBe("finished");
  });
  it("does not mistake a screenshot for the requested change", async () => {
    const config = { ...options([reply("Looking.", [{ type: "open_browser", url: "http://localhost:3000" }], "continue"), reply("I removed it."), reply("I cannot verify that change.", [], "blocked")]), requiresTools: true, requiresWork: true };
    expect((await runAgent(config)).status).toBe("blocked");
  });
  it("rejects an invented action and tells the model what a file write is missing", () => {
    expect(() => parseAgentReply(reply("update", [{ type: "imaginary_tool" }]))).toThrow("Unsupported action");
    expect(() => parseAgentReply(reply("update", [{ type: "write_file", path: "app.ts" }]))).toThrow("content field");
  });
  it("swallows an inference failure instead of handing it to the user as a reply", async () => {
    const config = options([]);
    // The first reply lands and its work runs; the model then goes away mid-task.
    let calls = 0;
    config.infer.mockImplementation(async () => {
      if (++calls === 1) return reply("Wiring the endpoint up now.", [{ type: "write_file", path: "app.ts", content: "export {}" }], "continue");
      throw new Error("HTTP 503: the model is rate limited");
    });
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("blocked");
    expect(outcome.error).toBeUndefined();
    expect(outcome.message).toBe("Wiring the endpoint up now.");
  });
  it("keeps the last thing the agent said when the loop itself fails", async () => {
    const config = options([]);
    config.infer.mockRejectedValue(new Error("HTTP 503"));
    expect(await runAgent(config)).toEqual({ status: "blocked" });
    expect(config.onFeedback).not.toHaveBeenCalled();
  });

  function longRun() {
    // Each detailed result is clipped to 8000 chars, so a run has to clear the
    // working-memory window before compression is expected to fire.
    const reads = Array.from({ length: 20 }, (_, index) => ({ type: "read_file" as const, path: `src/file${index}.ts` }));
    const config = options([reply("Reading the codebase.", reads, "continue"), reply("Done after the memory check.")]);
    config.execute.mockResolvedValue(reads.map((action) => ({ action, ok: true, result: { content: "x".repeat(20_000) } })));
    return { config, reads };
  }

  it("compresses long working memory and continues from the summary", async () => {
    const { config, reads } = longRun();
    const onCompression = vi.fn();
    const compress = vi.fn(async (_transcript: string) => "Goal: finish the task. Read src/file0.ts through src/file5.ts. Next: make the edit.");
    const outcome = await runAgent({ ...config, compress, onCompression, maxSteps: 3 });
    expect(outcome.status).toBe("finished");
    expect(compress).toHaveBeenCalledOnce();
    // The summary input keeps the original task and the freshest evidence; only the
    // oldest detail is trimmed.
    expect(compress.mock.calls[0]?.[0]).toContain("Inspect the project and build it");
    expect(compress.mock.calls[0]?.[0]).toContain(reads[reads.length - 1]!.path);
    expect(onCompression.mock.calls.map(([state]) => state)).toEqual(["compressing", "compressed"]);
    expect(config.infer.mock.calls[1]?.[0]).toContain("[COMPRESSED WORKING MEMORY]");
    expect(config.infer.mock.calls[1]?.[0]).toContain("src/file0.ts");
  });

  it("keeps working with a deterministic digest when compression credits run out", async () => {
    const { config } = longRun();
    const onCompression = vi.fn();
    const outcome = await runAgent({
      ...config,
      compress: async () => { throw new Error("Payment required"); },
      onCompression,
      maxSteps: 3,
    });
    expect(outcome.status).toBe("finished");
    expect(onCompression).toHaveBeenLastCalledWith("compressed", expect.stringContaining("Action ledger"));
    expect(config.infer.mock.calls[1]?.[0]).toContain("[COMPRESSED WORKING MEMORY]");
    expect(config.infer.mock.calls[1]?.[0]).toContain("ok read_file src/file0.ts");
  });
});

describe("rendered preview gate", () => {
  const start = { type: "start_server", command: "npm run dev" };
  const broken = { preview: { ok: true, healthy: false, issues: ["The page is blank: it has no visible text, media, or interactive elements."], url: "http://localhost:5173" } };
  const clean = { preview: { ok: true, healthy: true, issues: [], url: "http://localhost:5173" } };

  it("blocks completion while the preview is unhealthy and unblocks after a fresh clean check", async () => {
    const config = options([
      reply("Starting the dev server.", [start], "continue"),
      reply("Done."),
      reply("Verified. The page renders with a headline and navigation."),
    ]);
    config.execute = vi.fn()
      .mockResolvedValueOnce([{ action: start, ok: true, result: { ready: true, url: "http://localhost:5173", ...broken } }])
      .mockResolvedValueOnce([{ action: { type: "check_preview" }, ok: true, result: { healthy: true, ...clean } }]);
    const outcome = await runAgent({ ...config, maxSteps: 8 });
    expect(outcome.status).toBe("finished");
    expect(config.execute).toHaveBeenLastCalledWith([{ type: "check_preview" }]);
    expect(config.execute).toHaveBeenCalledTimes(2);
    expect(config.infer.mock.calls[2]?.[0]).toContain("PREVIEW VERIFIED");
  });

  it("releases a dead preview gate instead of ending the run on it", async () => {
    const config = options([
      reply("Starting the dev server.", [start], "continue"),
      reply("Done."), reply("Really done."), reply("It is finished."), reply("I am done."),
      reply("The code is written; the preview port never answered, so the page itself is the one thing I could not verify."),
    ]);
    config.execute = vi.fn()
      .mockResolvedValueOnce([{ action: start, ok: true, result: { ready: true, url: "http://localhost:5173", ...broken } }])
      .mockResolvedValue([{ action: { type: "check_preview" }, ok: true, result: { healthy: false, ...broken } }]);
    const outcome = await runAgent({ ...config, maxSteps: 12 });
    // Four reloads is the budget. After that the unrenderable page becomes a caveat the
    // agent has to state, not a reason to stop the work.
    expect(config.infer.mock.calls[5]?.[0]).toContain("PREVIEW UNVERIFIABLE");
    expect(config.infer.mock.calls[5]?.[0]).toContain("blank");
    expect(outcome.status).toBe("finished");
    expect(outcome.error).toBeUndefined();
    expect(config.execute).toHaveBeenCalledTimes(5);
  });

  it("marks a passing preview stale after an edit and rechecks before accepting completion", async () => {
    const write = { type: "write_file", path: "src/App.tsx", content: "export default () => null" };
    const config = options([
      reply("Starting the dev server.", [start], "continue"),
      reply("Editing the hero.", [write], "continue"),
      reply("Done."),
      reply("Done and verified."),
      reply("Confirmed."),
    ]);
    config.execute = vi.fn()
      .mockResolvedValueOnce([{ action: start, ok: true, result: { ready: true, url: "http://localhost:5173", ...clean } }])
      .mockResolvedValueOnce([{ action: write, ok: true, result: { ok: true } }])
      .mockResolvedValueOnce([{ action: { type: "check_preview" }, ok: true, result: { healthy: true, ...clean } }])
      .mockResolvedValueOnce([{ action: { type: "run_typecheck" }, ok: true, result: { ok: true } }]);
    const outcome = await runAgent({ ...config, maxSteps: 10 });
    expect(outcome.status).toBe("finished");
    expect(config.infer.mock.calls[2]?.[0]).toContain("FAILS verification");
    expect(config.execute).toHaveBeenNthCalledWith(3, [{ type: "check_preview" }]);
    expect(config.infer.mock.calls[3]?.[0]).toContain("PREVIEW VERIFIED");
  });
});
