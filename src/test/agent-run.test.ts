import { describe, expect, it, vi } from "vitest";
import { parseAgentReply, runAgent, type ToolFeedback } from "../lib/agent-run";

const reply = (message: string, actions: unknown[] = [], status = "complete") => JSON.stringify({ message, actions, status });
const list = { type: "list_dir", path: "." };
const command = { type: "run_command", command: "npm run build" };
function options(responses: string[]) {
  return {
    prompt: "Inspect the project and build it", signal: new AbortController().signal,
    infer: vi.fn().mockImplementation(async () => responses.shift()),
    execute: vi.fn().mockImplementation(async (actions) => actions.map((action: ToolFeedback["action"]) => ({ action, ok: true, result: { entries: [{ name: "package.json" }], exitCode: 0 } }))),
    onFeedback: vi.fn(), maxSteps: 5,
  };
}
describe("real agent loop", () => {
  it("retains tool results across multiple actions and updates", async () => {
    const config = options([reply("I'll inspect the folder.", [list], "continue"), reply("The project has a build script; I'll run it.", [command], "continue"), reply("Build passed.")]);
    const result = await runAgent(config);
    expect(result.status).toBe("finished");
    expect(config.execute).toHaveBeenCalledTimes(2);
    expect(config.onFeedback.mock.calls.map((call) => call[0])).toEqual(["I'll inspect the folder.", "The project has a build script; I'll run it."]);
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
    expect((await runAgent(config)).status).toBe("limit");
  });
  it("stops before executing actions after cancellation", async () => {
    const controller = new AbortController();
    const config = { ...options([]), signal: controller.signal, infer: vi.fn(async () => { controller.abort(); return reply("I'll inspect.", [list]); }) };
    expect((await runAgent(config)).status).toBe("stopped");
    expect(config.execute).not.toHaveBeenCalled();
  });
  it("rejects unsupported actions and missing file contents", () => {
    expect(() => parseAgentReply(reply("update", [{ type: "imaginary_tool" }]))).toThrow("Unsupported action");
    expect(() => parseAgentReply(reply("update", [{ type: "write_file", path: "app.ts" }]))).toThrow("Missing file contents");
  });
});
