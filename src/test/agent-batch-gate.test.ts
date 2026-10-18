// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgent, type AgentAction, type ToolFeedback } from "../lib/agent-run";
import { batchStatus, claimBatch, enqueueBatch, reportBatch } from "../lib/runtime/batch-queue";

const reply = (message: string, actions: unknown[] = [], status = "complete") => JSON.stringify({ message, actions, status });
const BATCH = ["queue_batch", "next_batch", "report_batch", "batch_status"];

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/**
 * Runs the gate against the real ledger in a temp project, so the counts the model sees are
 * the counts a real apply-run would see — no scripted numbers that can drift out of agreement.
 */
async function build(prompt: string, responses: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), "calvras-batch-gate-"));
  roots.push(root);
  const execute = vi.fn(async (actions: AgentAction[]): Promise<ToolFeedback[]> => {
    const feedback: ToolFeedback[] = [];
    for (const action of actions) {
      if (!BATCH.includes(action.type)) { feedback.push({ action, ok: true, result: { ok: true } }); continue; }
      try {
        const result = action.type === "queue_batch"
          ? await enqueueBatch(root, String(action["title"] || "Acme roles"), (action["targets"] || []) as any[])
          : action.type === "next_batch"
            ? await claimBatch(root, Number(action["count"] ?? 3))
            : action.type === "report_batch"
              ? await reportBatch(root, String(action.id), action["status"] as any, String(action["note"] || ""), String(action["reference"] || ""))
              : await batchStatus(root);
        feedback.push({ action, ok: true, result: result as any });
      } catch (error) {
        feedback.push({ action, ok: false, result: { ok: false, error: error instanceof Error ? error.message : "ledger error" } });
      }
    }
    return feedback;
  });
  const infer = vi.fn(async (_prompt: string): Promise<string> => responses.shift() ?? reply("Done."));
  return { prompt, signal: new AbortController().signal, infer, execute, onFeedback: vi.fn(), onPhaseComplete: vi.fn(), maxSteps: 20 };
}

const fiveRoles = Array.from({ length: 5 }, (_, index) => ({ url: `https://acme.test/jobs/${index + 1}`, label: `Role ${index + 1}` }));
const queue = (message: string) => reply(message, [{ type: "queue_batch", title: "Acme roles", targets: fiveRoles }], "continue");
const claim = (message: string) => reply(message, [{ type: "next_batch", count: 3 }], "continue");
const applied = (id: number, reference = `APP-${id}`) => reply(`Applied to role ${id}.`, [{ type: "report_batch", id: `acme.test/jobs/${id}`, status: "done", reference }], "continue");
const promptsOf = (config: Awaited<ReturnType<typeof build>>) => config.infer.mock.calls.map((call) => String(call[0]));

describe("batch completion gate", () => {
  it("keeps working the queue instead of stopping with targets left", async () => {
    const config = await build("Apply to every backend role listed on acme.test/jobs", [
      queue("Queued the whole list."),
      claim("Claimed a chunk."),
      applied(1),
      reply("All done."),
      claim("Claimed more."),
      applied(2), applied(3), applied(4), applied(5),
      reply("Finished every role on the list."),
    ]);
    const outcome = await runAgent(config);
    expect(outcome.message).toBe("Finished every role on the list.");
    const prompts = promptsOf(config);
    expect(prompts.some((prompt) => prompt.includes("[BATCH NOT FINISHED]"))).toBe(true);
    expect(prompts.find((prompt) => prompt.includes("[BATCH NOT FINISHED]"))).toContain("4 of 5 targets are still waiting");
    expect(prompts.some((prompt) => prompt.includes("[BATCH LEFT OPEN]"))).toBe(false);
  });

  it("lets a run that refuses to continue stop, but only after telling the user what is left", async () => {
    const config = await build("Apply to every backend role listed on acme.test/jobs", [
      queue("Queued the whole list."),
      claim("Claimed a chunk."),
      applied(1),
      reply("Done."), reply("Really done."), reply("Stopping now."), reply("Stopped for now."),
    ]);
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("finished");
    const last = promptsOf(config).at(-1)!;
    expect(last).toContain("[BATCH LEFT OPEN]");
    expect(last).toContain("do not present the run as complete");
    expect(outcome.message).toBe("Stopped for now.");
  });

  it("accepts a run whose remaining targets are blocked or skipped, not just done", async () => {
    const config = await build("Apply to every backend role listed on acme.test/jobs", [
      queue("Queued the whole list."),
      claim("Claimed a chunk."),
      applied(1), applied(2), applied(3),
      reply("Two need a captcha.", [{ type: "report_batch", id: "acme.test/jobs/4", status: "blocked", note: "captcha, which I will not solve" }], "continue"),
      reply("Last one is stale.", [{ type: "report_batch", id: "acme.test/jobs/5", status: "skipped", note: "posting closed" }], "continue"),
      reply("Done: three applied, one blocked on a captcha, one posting had closed."),
    ]);
    const outcome = await runAgent(config);
    expect(outcome.message).toContain("three applied");
    expect(promptsOf(config).some((prompt) => prompt.includes("BATCH"))).toBe(false);
  });

  it("stays out of the way when the run never used the ledger", async () => {
    const config = await build("What does this README say?", [reply("Reading.", [{ type: "read_file", path: "README.md" }], "continue"), reply("It says Node 24.")]);
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("finished");
    expect(promptsOf(config).some((prompt) => prompt.includes("BATCH"))).toBe(false);
  });
});
