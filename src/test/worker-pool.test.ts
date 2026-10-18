// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { WorkerPool } from "../lib/runtime/worker-pool";

describe("three working subagents", () => {
  it("runs all three roles concurrently and returns their actual outputs", async () => {
    const releases: (() => void)[] = [];
    const seen = new Set<string>();
    const infer = vi.fn(async (prompt) => {
      const role = prompt.includes("researcher") ? "researcher" : prompt.includes("verifier") ? "verifier" : "builder";
      if (!seen.has(role)) { seen.add(role); await new Promise<void>((resolve) => releases.push(resolve)); return JSON.stringify({ message: "Inspecting the assigned workspace.", actions: [{ type: "list_dir", path: "." }], status: "continue" }); }
      return JSON.stringify({ message: role === "researcher" ? "Research complete." : "Checks complete.", actions: [], status: "complete" });
    });
    const pool = new WorkerPool({ infer, execute: vi.fn(async (action: any) => (action.type === "write_file" ? { ok: true, path: "a.txt" } : { ok: true, output: "No type errors found." })) });
    const jobs = [pool.delegate("builder", "Implement a component"), pool.delegate("verifier", "Verify tests"), pool.delegate("researcher", "Inspect the framework")];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pool.list().filter((role) => role.active)).toHaveLength(3);
    releases.forEach((resolve) => resolve());
    await Promise.all(jobs.map((job) => pool.wait(job.id, 1000)));
    expect(jobs.every((job) => job.status === "finished")).toBe(true);
    expect(pool.get(jobs[2]!.id).outcome).toMatchObject({ message: "Research complete." });
  });
  it("queues work within each role and stops queued jobs", async () => {
    let release!: () => void;
    const pool = new WorkerPool({ infer: async () => { await new Promise<void>((resolve) => { release = resolve; }); return JSON.stringify({ message: "Done", actions: [], status: "complete" }); }, execute: vi.fn() });
    const first = pool.delegate("builder", "First"); const second = pool.delegate("builder", "Second");
    expect(second.status).toBe("queued"); pool.cancel(second.id); release();
    await pool.wait(first.id, 1000); expect(second.status).toBe("stopped");
  });
  it("refuses a worker that tries to hire staff without ending its job", async () => {
    let turn = 0;
    const execute = vi.fn(async (action: { type: string }) => ({ ok: true, entries: [] }));
    const pool = new WorkerPool({
      infer: async () => {
        turn++;
        if (turn === 1) return JSON.stringify({ message: "Delegating", actions: [{ type: "delegate_task", role: "builder", task: "Again" }], status: "continue" });
        if (turn === 2) return JSON.stringify({ message: "Doing it myself.", actions: [{ type: "list_dir", path: "." }], status: "continue" });
        return JSON.stringify({ message: "Read it myself and counted the entries.", actions: [], status: "complete" });
      },
      execute,
    });
    const job = pool.delegate("builder", "Implement once"); await pool.wait(job.id, 2_000);
    // The refusal is the tool's result, so the worker keeps going and still finishes the job.
    expect(job.status).toBe("finished");
    expect(job.outcome).toMatchObject({ message: "Read it myself and counted the entries." });
    expect(execute.mock.calls.map(([action]) => action.type)).toEqual(["list_dir"]);
  });
  it("keeps a worker that ran out of steps distinct from one that was blocked", async () => {
    // Each step asks for different work, so the loop ends on its own step budget rather than on
    // the repeated-inspection guard. "limit" must survive into the job status the row reads.
    let step = 0;
    const pool = new WorkerPool({ infer: async () => JSON.stringify({ message: "Still looking.", actions: [{ type: "list_dir", path: `dir-${step++}` }], status: "continue" }), execute: vi.fn(async (action: any) => (action.type === "write_file" ? { ok: true, path: "a.txt" } : { ok: true, output: "No type errors found." })) });
    const job = pool.delegate("researcher", "Inspect everything");
    await pool.wait(job.id, 4_000);
    expect(job.status).toBe("limit");
  });
  it("holds a finished isolated job until git has counted its changes", async () => {
    let settleDone = false;
    // The loop's own continuation prompt is what tells the worker its write really happened.
    const infer = vi.fn(async (prompt: string) => !prompt.includes("[OBSERVED TOOL RESULTS]")
      ? JSON.stringify({ message: "Writing it.", actions: [{ type: "write_file", path: "a.txt", content: "x" }], status: "continue" })
      : !prompt.includes("run_typecheck")
        ? JSON.stringify({ message: "Checking it.", actions: [{ type: "run_typecheck" }], status: "continue" })
        : JSON.stringify({ message: "Made and checked the change.", actions: [], status: "complete" }));
    const pool = new WorkerPool({
      infer,
      execute: vi.fn(async (action: any) => (action.type === "write_file" ? { ok: true, path: "a.txt" } : { ok: true, output: "No type errors found." })),
      isolate: async (job) => { job.worktree = { branch: `calvras/${job.id.slice(0, 8)}`, path: "/tmp/isolated" }; },
      settle: async (job) => { await new Promise((resolve) => setTimeout(resolve, 60)); settleDone = true; job.worktree = { ...job.worktree!, files: 2 }; },
    });
    const job = pool.delegate("builder", "Implement the change", { isolate: true });
    await pool.wait(job.id, 4_000);
    // The row a user reads goes terminal and carries its file count in the same tick.
    expect(settleDone).toBe(true);
    expect(job.status).toBe("finished");
    expect(job.worktree).toMatchObject({ branch: expect.stringMatching(/^calvras\//), files: 2 });
  });
  it("logs why isolation was unavailable and still does the work in the shared folder", async () => {
    let askedForRoot = "";
    const pool = new WorkerPool({
      infer: async (prompt: string) => {
        askedForRoot = prompt;
        return !prompt.includes("[OBSERVED TOOL RESULTS]")
          ? JSON.stringify({ message: "Writing it.", actions: [{ type: "write_file", path: "a.txt", content: "x" }], status: "continue" })
          : !prompt.includes("run_typecheck")
            ? JSON.stringify({ message: "Checking it.", actions: [{ type: "run_typecheck" }], status: "continue" })
            : JSON.stringify({ message: "Wrote and checked it.", actions: [], status: "complete" });
      },
      execute: vi.fn(async (action: any) => (action.type === "write_file" ? { ok: true, path: "a.txt" } : { ok: true, output: "No type errors found." })),
      isolate: async () => { throw new Error("This folder is not a git repository, so a worker cannot be isolated in a branch of it."); },
    });
    const job = pool.delegate("builder", "Implement the change", { isolate: true });
    await pool.wait(job.id, 4_000);
    expect(job.status).toBe("finished");
    expect(job.worktree?.error).toMatch(/not a git repository/);
    expect(job.updates.join(" ")).toMatch(/Isolation unavailable.*shared folder/);
    // A worker that was not branched is not told about a branch it does not have.
    expect(askedForRoot).not.toMatch(/own checkout/);
  });
});
