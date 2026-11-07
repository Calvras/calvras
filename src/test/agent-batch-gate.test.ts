// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgent, type AgentAction, type ToolFeedback } from "../lib/agent-run";
import { batchStatus, claimBatch, enqueueBatch, readBatch, reportBatch } from "../lib/runtime/batch-queue";

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
      if (!BATCH.includes(action.type)) { feedback.push({ action, ok: true, result: { ok: true, ...(typeof action["text"] === "string" ? { text: action["text"] } : {}) } }); continue; }
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
  return { root, prompt, signal: new AbortController().signal, infer, execute, onFeedback: vi.fn(), onPhaseComplete: vi.fn(), maxSteps: 20 };
}

const fiveRoles = Array.from({ length: 5 }, (_, index) => ({ url: `https://acme.test/jobs/${index + 1}`, label: `Role ${index + 1}` }));
// The listing is read in the same round it is queued, exactly as a real run does it: the queue is
// built from hrefs the page showed, not addresses written from memory.
const queue = (message: string) => reply(message, [
  { type: "read_page", text: fiveRoles.map((role) => `${role.label} <a href="${role.url}">apply</a>`).join("\n") },
  { type: "queue_batch", title: "Acme roles", targets: fiveRoles },
], "continue");
const claim = (message: string) => reply(message, [{ type: "next_batch", count: 3 }], "continue");
const applied = (id: number, reference = `APP-${id}`) => reply(`Applied to role ${id}.`, [
  { type: "read_page", text: `Application received. Your reference is ${reference}.` },
  { type: "report_batch", id: `acme.test/jobs/${id}`, status: "done", reference },
], "continue");
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
    const nudged = prompts.find((prompt) => prompt.includes("[BATCH NOT FINISHED]"))!;
    expect(nudged).toContain("4 of 5 targets are still open");
    expect(nudged).toContain("The ledger released your claim on");
    expect(nudged).not.toMatch(/more completion attempt|allowed to stop|Stopping for now/);
    expect(prompts.some((prompt) => prompt.includes("[BATCH LEFT OPEN]"))).toBe(false);
  });

  it("hands the run new work every time it tries to stop, until the queue is actually empty", async () => {
    const config = await build("Apply to every backend role listed on acme.test/jobs", [
      queue("Queued the whole list."),
      claim("Claimed a chunk."),
      applied(1),
      reply("Done."), reply("Really done."), reply("That is everything."), reply("Finished."),
      applied(2), applied(3), applied(4), applied(5),
      reply("Applied to all five roles on the list."),
    ]);
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("finished");
    expect(outcome.message).toBe("Applied to all five roles on the list.");
    expect(outcome.message).not.toMatch(/stopping|stopped for now/i);
    const prompts = promptsOf(config);
    expect(prompts.filter((prompt) => prompt.includes("[BATCH NOT FINISHED]")).length).toBeGreaterThanOrEqual(3);
    expect(prompts.some((prompt) => prompt.includes("[BATCH LEFT OPEN]"))).toBe(false);
    expect(await batchStatus(config.root)).toMatchObject({ done: 5, queued: 0, running: 0 });
  });

  it("refuses to let a blocked reply strand an open queue", async () => {
    const config = await build("Apply to every backend role listed on acme.test/jobs", [
      queue("Queued the whole list."),
      claim("Claimed a chunk."),
      applied(1),
      reply("This site is too much for me, I am stopping.", [], "blocked"),
      applied(2), applied(3), applied(4), applied(5),
      reply("Applied to all five: 5 done, 0 blocked, 0 skipped of 5."),
    ]);
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("finished");
    expect(outcome.message).toContain("5 done");
    const prompts = promptsOf(config);
    expect(prompts.filter((prompt) => prompt.includes("[BATCH NOT FINISHED]")).length).toBeGreaterThanOrEqual(1);
    expect(prompts.some((prompt) => /BATCH CLOSED/.test(prompt))).toBe(false);
    expect(await batchStatus(config.root)).toMatchObject({ done: 5, queued: 0, running: 0 });
  });

  it("never spends the queue on a round where the model never answered", async () => {
    // An empty blocked round is the turn loop handing back a provider that would not reply, not the
    // agent choosing an outcome. Claiming out here would release every target and, after three such
    // rounds, close the whole board as blocked on a quota blip.
    const config = await build("Apply to every backend role listed on acme.test/jobs", [
      queue("Queued the whole list."),
      claim("Claimed a chunk."),
      reply("", [], "blocked"),
    ]);
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("blocked");
    const state = await batchStatus(config.root);
    expect(state.blocked).toBe(0);
    expect(state.queued + state.running).toBeGreaterThan(0);
  });

  it("closes a target the run keeps dropping, so an abandoned queue still drains to zero", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calvras-claim-out-"));
    roots.push(root);
    await enqueueBatch(root, "Acme roles", fiveRoles);
    await claimBatch(root, 3);
    let state = await claimBatch(root, 0);
    expect(state.claim_cleared).toBe(true);
    expect(state.dropped.map((item) => item.id)).toEqual(["acme.test/jobs/1", "acme.test/jobs/2", "acme.test/jobs/3"]);
    // A released claim goes behind everything untouched, so the chunk that comes back is new work.
    expect(state.claimed.map((item) => item.id)).toEqual(["acme.test/jobs/4", "acme.test/jobs/5", "acme.test/jobs/1"]);
    for (let round = 0; round < 10 && state.queued + state.running > 0; round += 1) state = await claimBatch(root, 0);
    expect(state.queued + state.running).toBe(0);
    expect(state.blocked).toBe(5);
    const ledger = await readBatch(root);
    expect(ledger.items.every((item) => item.status === "blocked" && item.released >= 3)).toBe(true);
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

  it("keeps a submitted target closed and demands the page's own receipt", async () => {
    const config = await build("Apply to every backend role listed on acme.test/jobs", [
      reply("Queued the one role.", [{ type: "read_page", text: `Role 1 <a href="${fiveRoles[0]!.url}">apply</a>` }, { type: "queue_batch", title: "Acme roles", targets: [fiveRoles[0]!] }], "continue"),
      claim("Claimed it."),
      reply("Applied and closed it.", [{ type: "report_batch", id: "acme.test/jobs/1", status: "done", reference: "APP-99" }], "continue"),
      reply("Reading the confirmation page.", [{ type: "read_page", text: "Application received. Your reference is APP-1." }], "continue"),
      reply("That is the real one.", [{ type: "report_batch", id: "acme.test/jobs/1", status: "done", reference: "APP-1" }], "continue"),
      reply("Applied to the only role on the list."),
    ]);
    const outcome = await runAgent(config);
    expect(outcome.message).toContain("Applied to the only role");
    const nudged = promptsOf(config).find((prompt) => prompt.includes("[BATCH RECEIPT UNREAD]"));
    expect(nudged).toContain("APP-99");
    expect(nudged).toContain("do not send it again");
    // Finished work never goes back on the queue — that is what made a live run submit the same form twice.
    const actions = config.execute.mock.calls.flat(2 as never) as unknown as AgentAction[];
    expect(actions.filter((action: any) => action?.type === "report_batch" && action?.status === "running")).toEqual([]);
    expect(await batchStatus(config.root)).toMatchObject({ done: 1, running: 0, queued: 0 });
  });

  it("will not let a phrase every site prints close a target", async () => {
    const config = await build("Apply to every backend role listed on acme.test/jobs", [
      reply("Queued the one role.", [{ type: "read_page", text: `Role 1 <a href="${fiveRoles[0]!.url}">apply</a>` }, { type: "queue_batch", title: "Acme roles", targets: [fiveRoles[0]!] }], "continue"),
      claim("Claimed it."),
      // The page really did say this and the run read it. It is still not a receipt for this target.
      reply("Read the confirmation.", [{ type: "read_page", text: "Application submitted" }], "continue"),
      reply("Closed it.", [{ type: "report_batch", id: "acme.test/jobs/1", status: "done", reference: "Application submitted", note: "It said the application was submitted" }], "continue"),
      reply("Applied to the one role, with no reference the site ever gave me."),
    ]);
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("finished");
    const nudged = promptsOf(config).find((prompt) => prompt.includes("[BATCH RECEIPT UNREAD]"));
    expect(nudged).toContain("is the sentence every confirmation page prints");
    expect((await batchStatus(config.root))["done"]).toBe(1);
  });

  it("will not let one posting's receipt close a second posting", async () => {
    const config = await build("Apply to every backend role listed on acme.test/jobs", [
      queue("Queued the board."),
      claim("Claimed the first chunk."),
      applied(1),
      // The run copies role 1's code onto role 2 instead of reading role 2's own confirmation —
      // the exact shape the live board took when five postings closed with one reference.
      reply("Closed role 2 as well.", [{ type: "report_batch", id: "acme.test/jobs/2", status: "done", reference: "APP-1" }], "continue"),
      reply("Reading role 2's own page.", [{ type: "read_page", text: "Application received. Your reference is APP-2." }], "continue"),
      reply("Now with the code this page printed.", [{ type: "report_batch", id: "acme.test/jobs/2", status: "done", reference: "APP-2" }], "continue"),
      applied(3), applied(4), applied(5),
      reply("Applied to all five roles."),
    ]);
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("finished");
    const nudged = promptsOf(config).find((prompt) => prompt.includes("[BATCH RECEIPT UNREAD]"));
    expect(nudged).toContain("that code is acme.test/jobs/1's receipt");
    // Re-reading its own page clears the doubt, so the closing note must not accuse the run of it.
    const closed = promptsOf(config).find((prompt) => prompt.includes("[BATCH CLOSED]"));
    expect(closed || "").not.toContain("never backed by a receipt");
    expect(await batchStatus(config.root)).toMatchObject({ done: 5, queued: 0, running: 0 });
  });

  it("tells a run the moment it queues an address no page ever showed", async () => {
    const config = await build("Apply to every backend role listed on acme.test/jobs", [
      reply("Queued the role.", [{ type: "queue_batch", title: "Acme roles", targets: [{ url: "https://acme.test/roles/backend-engineer-northwind", label: "Backend Engineer" }] }], "continue"),
      reply("That link was mine, not the page's.", [{ type: "report_batch", id: "acme.test/roles/backend-engineer-northwind", status: "skipped", note: "not a link on the page" }], "continue"),
      reply("The list has no such posting: 1 skipped, 0 applied."),
    ]);
    const outcome = await runAgent(config);
    expect(outcome.message).toContain("skipped");
    const nudged = promptsOf(config).find((prompt) => prompt.includes("[BATCH TARGET UNSEEN]"));
    expect(nudged).toContain("https://acme.test/roles/backend-engineer-northwind");
    expect(nudged).toContain("read_page");
    expect(promptsOf(config).some((prompt) => prompt.includes("[BATCH NOT FINISHED]"))).toBe(false);
  });

  it("stays out of the way when the run never used the ledger", async () => {
    const config = await build("What does this README say?", [reply("Reading.", [{ type: "read_file", path: "README.md" }], "continue"), reply("It says Node 24.")]);
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("finished");
    expect(promptsOf(config).some((prompt) => prompt.includes("BATCH"))).toBe(false);
  });
});
