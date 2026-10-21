import { describe, expect, it, vi } from "vitest";
import { executeInOrder, feedbackContext } from "../lib/agent-context";
import type { AgentAction } from "../lib/agent-run";

describe("safe concurrency and compact context", () => {
  it("overlaps independent reads but waits at every write barrier", async () => {
    const events: string[] = [];
    const actions: AgentAction[] = [{ type: "read_file", path: "a" }, { type: "read_file", path: "b" }, { type: "write_file", path: "c", content: "new" }, { type: "read_file", path: "c" }];
    const results = await executeInOrder(actions, async (action) => {
      events.push(`start ${action.type} ${action.path}`);
      await new Promise((resolve) => setTimeout(resolve, action.path === "a" ? 15 : 1));
      events.push(`end ${action.type} ${action.path}`);
      return { action, ok: true, result: {} };
    }, new AbortController().signal);
    expect(events.slice(0, 2)).toEqual(["start read_file a", "start read_file b"]);
    expect(events.indexOf("start write_file c")).toBeGreaterThan(events.indexOf("end read_file a"));
    expect(events.indexOf("start read_file c")).toBeGreaterThan(events.indexOf("end write_file c"));
    expect(results.map((result) => result.action)).toEqual(actions);
  });
  it("overlaps a run of page fills but still waits at a click", async () => {
    const events: string[] = [];
    const actions: AgentAction[] = [
      { type: "fill_input", selector: "#name", value: "Shikari" },
      { type: "fill_input", selector: "#email", value: "shikari@example.com" },
      { type: "fill_input", selector: "#why", value: "four years of TypeScript" },
      { type: "click_element", selector: "#submit" },
      { type: "fill_input", selector: "#late", value: "after the click" },
    ];
    await executeInOrder(actions, async (action) => {
      events.push(`start ${action["selector"]}`);
      await new Promise((resolve) => setTimeout(resolve, action["selector"] === "#name" ? 15 : 1));
      events.push(`end ${action["selector"]}`);
      return { action, ok: true, result: {} };
    }, new AbortController().signal);
    expect(events.slice(0, 3)).toEqual(["start #name", "start #email", "start #why"]);
    expect(events.indexOf("start #submit")).toBeGreaterThan(events.indexOf("end #why"));
    expect(events.indexOf("start #late")).toBeGreaterThan(events.indexOf("end #submit"));
  });
  it("does not begin work after cancellation", async () => {
    const controller = new AbortController(); controller.abort(); const execute = vi.fn();
    await expect(executeInOrder([{ type: "list_dir" }], execute, controller.signal)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it("compresses old output and does not repeat file write payloads", () => {
    const feedback = [{ action: { type: "write_file" as const, path: "app.ts", content: "x".repeat(50000) }, ok: true, result: { output: "a".repeat(50000), exitCode: 0 } }];
    expect(feedbackContext(feedback).length).toBeLessThan(8500);
    expect(feedbackContext(feedback, false).length).toBeLessThan(1000);
    expect(feedbackContext(feedback)).not.toContain('"content"');
  });
});
