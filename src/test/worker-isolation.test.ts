// @vitest-environment node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../lib/runtime/agent-runtime";

const run = promisify(execFile);
const git = (args: string[], cwd: string) => run("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "Calvras Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Calvras Test", GIT_COMMITTER_EMAIL: "test@example.com" } });
const read = async (file: string) => (await fs.readFile(file, "utf8")).split("\r\n").join("\n");
const exists = (file: string) => fs.access(file).then(() => true, () => false);

let root = "";
let session: AgentSession;

beforeEach(async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "calvras-worker-isolation-")));
  root = path.join(base, "work");
  await fs.mkdir(root, { recursive: true });
  await git(["init", "-b", "main"], root);
  await fs.writeFile(path.join(root, "notes.md"), "one\n");
  await git(["add", "notes.md"], root);
  await git(["commit", "-m", "seed"], root);
});

afterEach(async () => {
  session?.stop();
  await fs.rm(path.dirname(root), { recursive: true, force: true }).catch(() => {});
});

/** The worker's own turns: one write, then its report. Only the routing under test is mocked. */
function workerWrites(file: string, content: string) {
  const infer = vi.fn(async () => "") as any;
  infer.mockResolvedValueOnce(JSON.stringify({ message: "Writing the file.", actions: [{ type: "write_file", path: file, content }], status: "continue" }));
  infer.mockResolvedValue(JSON.stringify({ message: `Wrote ${file}.`, actions: [], status: "complete" }));
  return infer;
}

/**
 * A worker without its own checkout edits the shared folder, so Full access interrupts with the
 * same write approval the main agent gets. This plays the user's part: grant it and let the job run.
 */
async function acceptWrites(id: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const job = session.pool.get(id);
    if (["finished", "blocked", "stopped", "limit"].includes(job.status)) return job;
    for (const approval of session.status().approvals) session.decide(approval.id, "task");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The worker never finished after its writes were approved.");
}

describe("isolated subagents", () => {
  it("writes into its own checkout and leaves the shared folder untouched", async () => {
    const infer = workerWrites("notes.md", "one\nworker line\n");
    session = new AgentSession(root, "full", infer);
    const delegated = await session.execute({ type: "delegate_task", role: "builder", task: "Write a line into notes.md", isolate: true });
    const job = await session.pool.wait(delegated.job.id, 20_000);
    expect(job.status).toBe("finished");
    expect(job.worktree?.branch).toMatch(/^calvras\//);
    expect(job.worktree?.files).toBe(1);
    expect(await read(path.join(root, "notes.md"))).toBe("one\n");
    expect(await read(path.join(job.worktree!.path!, "notes.md"))).toBe("one\nworker line\n");
    // The worker was told where it is, so it cannot report a path the user cannot find.
    expect(String(infer.mock.calls[0]?.[0])).toContain(job.worktree!.path);
  });

  it("brings an isolated worker's change back into the folder when it is resolved", async () => {
    session = new AgentSession(root, "full", workerWrites("notes.md", "one\nworker line\n"));
    const delegated = await session.execute({ type: "delegate_task", role: "builder", task: "Write a line into notes.md", isolate: true });
    const job = await session.pool.wait(delegated.job.id, 20_000);
    const changes = await session.execute({ type: "worker_changes", id: job.id });
    expect(changes.ok).toBe(true);
    expect(changes.files).toEqual([{ status: "M", path: "notes.md" }]);
    // The Apply button in the subagent card is the user's own click, so it carries its approval.
    const resolved = await session.execute({ type: "resolve_worker", id: job.id, action: "apply" }, { userInitiated: true });
    expect(resolved.ok ? true : resolved.error).toBe(true);
    expect(await read(path.join(root, "notes.md"))).toBe("one\nworker line\n");
  });

  it("drops an isolated worker's work when the user discards it", async () => {
    session = new AgentSession(root, "full", workerWrites("scratch.txt", "thrown away\n"));
    const delegated = await session.execute({ type: "delegate_task", role: "builder", task: "Create scratch.txt", isolate: true });
    const job = await session.pool.wait(delegated.job.id, 20_000);
    expect((await session.execute({ type: "worker_changes", id: job.id })).files).toEqual([{ status: "A", path: "scratch.txt" }]);
    expect((await session.execute({ type: "resolve_worker", id: job.id, action: "discard" }, { userInitiated: true })).ok).toBe(true);
    expect(await exists(path.join(root, "scratch.txt"))).toBe(false);
    expect(await exists(job.worktree!.path!)).toBe(false);
    expect((await git(["status", "--porcelain"], root)).stdout.trim()).toBe("");
  });

  it("keeps two isolated builders from overwriting each other", async () => {
    session = new AgentSession(root, "full", async () => JSON.stringify({ message: "done", actions: [], status: "complete" }));
    const first = await session.execute({ type: "delegate_task", role: "builder", task: "Rewrite notes.md for the first job", isolate: true });
    const second = await session.execute({ type: "delegate_task", role: "verifier", task: "Rewrite notes.md for the second job", isolate: true });
    const [one, two] = await Promise.all([session.pool.wait(first.job.id, 20_000), session.pool.wait(second.job.id, 20_000)]);
    expect(one.worktree?.path).not.toBe(two.worktree?.path);
    expect((await git(["worktree", "list"], root)).stdout.split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("says so and works in the shared folder when the workspace is not a repository", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-not-git-"));
    session = new AgentSession(plain, "full", workerWrites("notes.md", "made anyway\n"));
    const delegated = await session.execute({ type: "delegate_task", role: "builder", task: "Create notes.md", isolate: true });
    const job = await acceptWrites(delegated.job.id);
    expect(job.status).toBe("finished");
    expect(job.worktree?.error).toMatch(/not a git repository/);
    expect(job.updates.join(" ")).toMatch(/Isolation unavailable.*shared folder/);
    expect(await read(path.join(plain, "notes.md"))).toBe("made anyway\n");
    await fs.rm(plain, { recursive: true, force: true });
  });

  it("refuses to resolve a checkout that does not exist", async () => {
    session = new AgentSession(root, "full", async () => JSON.stringify({ message: "done", actions: [], status: "complete" }));
    const delegated = await session.execute({ type: "delegate_task", role: "researcher", task: "Read notes.md and report it" });
    const job = await session.pool.wait(delegated.job.id, 20_000);
    expect(job.isolate).toBeUndefined();
    expect(await session.execute({ type: "resolve_worker", id: job.id, action: "apply" }, { userInitiated: true })).toMatchObject({ ok: false, error: expect.stringMatching(/no isolated checkout/) });
    expect((await session.execute({ type: "worker_changes", id: job.id })).error).toMatch(/did not run in its own checkout/);
  });
});
