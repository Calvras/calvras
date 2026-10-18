// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../lib/runtime/agent-runtime";
import { WorkerPool } from "../lib/runtime/worker-pool";
import { validateToolAction } from "../lib/tool-catalog";
import { CALVRAS_SYSTEM_PROMPT, workerSystemPrompt } from "../lib/system-prompt";

let root = "";
let session: AgentSession;

beforeEach(async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "calvras-scheduled-tools-")));
  root = path.join(base, "work");
  await fs.mkdir(root, { recursive: true });
});

afterEach(async () => {
  session?.stop();
  await fs.rm(path.dirname(root), { recursive: true, force: true }).catch(() => {});
});

const ledger = async () => JSON.parse(await fs.readFile(path.join(root, ".calvras", "schedule.json"), "utf8"));

describe("the agent's scheduling tools", () => {
  beforeEach(() => { session = new AgentSession(root, "full", async () => ""); });

  it("writes the appointment the model asked for into the project folder", async () => {
    const created = await session.execute({ type: "schedule_run", prompt: "Rebuild and report the bundle size", kind: "every", everyMinutes: 45 });
    expect(created.ok).toBe(true);
    expect(created.entry).toMatchObject({ prompt: "Rebuild and report the bundle size", kind: "every", everyMs: 45 * 60_000, mode: "full", enabled: true });
    // The ledger is the product: another window opening this folder reads the same appointment.
    expect((await ledger()).entries.map((entry: any) => entry.id)).toEqual([created.entry.id]);
    const listed = await session.execute({ type: "list_scheduled" });
    expect(listed.entries.map((entry: any) => entry.prompt)).toEqual(["Rebuild and report the bundle size"]);
  });

  it("carries the access mode it was made in, so a later run is not silently given more freedom", async () => {
    const ask = new AgentSession(root, "ask", async () => "");
    const created = await ask.execute({ type: "schedule_run", prompt: "Tidy the screenshots", kind: "daily", timeOfDay: "21:00" });
    expect(created.entry).toMatchObject({ mode: "ask", timeOfDay: "21:00" });
    ask.stop();
  });

  it("pauses and then removes an appointment through the same tool", async () => {
    const created = await session.execute({ type: "schedule_run", prompt: "Check the feed", kind: "every", everyMinutes: 10 });
    const paused = await session.execute({ type: "cancel_scheduled", id: created.entry.id, enabled: false });
    expect(paused.ok).toBe(true);
    expect((await ledger()).entries[0]).toMatchObject({ id: created.entry.id, enabled: false });
    const resumed = await session.execute({ type: "cancel_scheduled", id: created.entry.id, enabled: true });
    expect(resumed.entry.enabled).toBe(true);
    const removed = await session.execute({ type: "cancel_scheduled", id: created.entry.id });
    expect(removed.ok).toBe(true);
    expect((await ledger()).entries).toEqual([]);
    expect((await session.execute({ type: "cancel_scheduled", id: "never-scheduled" })).ok).toBe(false);
  });

  it("reports an empty schedule honestly instead of inventing an appointment", async () => {
    const listed = await session.execute({ type: "list_scheduled" });
    expect(listed).toMatchObject({ ok: true, entries: [] });
    await expect(fs.readFile(path.join(root, ".calvras", "schedule.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("scheduling arguments the model can get wrong", () => {
  it("refuses an action that could not name a run", () => {
    expect(() => validateToolAction({ type: "schedule_run" })).toThrow(/what the run should do/);
    expect(() => validateToolAction({ type: "schedule_run", prompt: "Do it", kind: "sometimes" })).toThrow(/once|every|daily/);
    expect(() => validateToolAction({ type: "schedule_run", prompt: "Do it", kind: "every" })).toThrow(/everyMinutes/);
    expect(() => validateToolAction({ type: "schedule_run", prompt: "Do it", kind: "daily" })).toThrow(/timeOfDay/);
    expect(() => validateToolAction({ type: "schedule_run", prompt: "Do it", kind: "at" })).toThrow(/one-off/);
    expect(() => validateToolAction({ type: "cancel_scheduled" })).toThrow(/id/);
    expect(() => validateToolAction({ type: "list_scheduled" })).not.toThrow();
  });
  it("keeps a valid one in one pass", () => {
    expect(validateToolAction({ type: "schedule_run", prompt: "Summarise the inbox", kind: "at", at: "2026-10-19T09:00" })).toMatchObject({ type: "schedule_run", kind: "at" });
  });
});

describe("who is allowed to make an appointment", () => {
  it("tells the main agent the tools exist and how they fire", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toContain("schedule_run {prompt,kind:");
    expect(CALVRAS_SYSTEM_PROMPT).toContain("list_scheduled {}");
    expect(CALVRAS_SYSTEM_PROMPT).toContain("cancel_scheduled {id}");
    expect(CALVRAS_SYSTEM_PROMPT).toContain(".calvras/schedule.json");
  });
  it("takes the scheduling paragraph out of a worker's prompt", () => {
    const prompt = workerSystemPrompt("builder");
    expect(prompt).not.toContain("schedule_run {prompt,kind:");
    expect(prompt).not.toContain(", schedule_run,");
    expect(prompt).toContain("appointing work to start later is not yours");
  });
  it("refuses a worker that schedules for itself and hands the reason back to it", async () => {
    const askedFor: string[] = [];
    const prompts: string[] = [];
    const pool = new WorkerPool({
      infer: async (prompt: string) => {
        prompts.push(prompt);
        return prompt.includes("Continuation 1.")
          ? JSON.stringify({ message: "Reading first.", actions: [{ type: "read_file", path: "notes.md" }], status: "continue" })
          : !prompt.includes("Only the main agent")
            ? JSON.stringify({ message: "Scheduling it.", actions: [{ type: "schedule_run", prompt: "Recur forever", kind: "every", everyMinutes: 60 }], status: "continue" })
            : JSON.stringify({ message: "Reported the suggestion instead.", actions: [], status: "complete" });
      },
      execute: async (action: any) => { askedFor.push(action.type); return action.type === "read_file" ? { ok: true, content: "one" } : { ok: true }; },
    });
    const job = pool.delegate("builder", "Read notes.md and report what it says");
    await pool.wait(job.id, 8_000);
    // The tool never reaches the runtime, and the worker is told why in its own next prompt.
    expect(askedFor).not.toContain("schedule_run");
    expect(askedFor).toContain("read_file");
    expect(prompts.join("\n")).toMatch(/Only the main agent schedules work to start later/);
  });
});
