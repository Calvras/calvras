import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
/** Every git call is an argv array with no shell, so a branch or path can never be re-read as a command. */
async function git(args: string[], cwd: string) {
  try {
    const { stdout } = await run("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
    return { ok: true as const, stdout: stdout.trim() };
  } catch (error) {
    const detail = error instanceof Error ? `${error.message}${(error as any).stderr ? `: ${String((error as any).stderr).trim()}` : ""}` : String(error);
    return { ok: false as const, stdout: "", error: detail.slice(0, 600) };
  }
}

export type Worktree = { id: string; path: string; branch: string; createdAt: number };

const worktreeDir = (root: string, id: string) => path.join(root, ".calvras", "worktrees", id);

/** Patch text must keep its exact bytes: trimming the trailing newline off a diff makes
 *  `git apply` report a corrupt patch, which looks like a conflict but is not one. */
async function gitRaw(args: string[], cwd: string) {
  try {
    const { stdout } = await run("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
    return { ok: true as const, stdout };
  } catch (error) {
    return { ok: false as const, stdout: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Scratch checkouts are Calvras' own, so keep them out of the user's `git status` by writing
 *  to the local, uncommitted exclude file rather than editing their .gitignore. */
async function hideFromStatus(root: string) {
  const gitDir = await git(["rev-parse", "--git-dir"], root);
  if (!gitDir.ok) return;
  const file = path.join(path.resolve(root, gitDir.stdout), "info", "exclude");
  const current = await fs.readFile(file, "utf8").catch(() => "");
  if (current.split("\n").some((line) => line.trim() === "/.calvras/worktrees/")) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${current && !current.endsWith("\n") ? "\n" : ""}# Calvras isolated subagent checkouts\n/.calvras/worktrees/\n/.calvras/worker-*.patch\n`, "utf8");
}

/** A worker's own checkout of the same commit, on its own branch. Two builders can then edit
 *  the same file at the same time without overwriting each other. */
export async function createWorktree(root: string, jobId: string): Promise<Worktree> {
  const inside = await git(["rev-parse", "--is-inside-work-tree"], root);
  if (!inside.ok || inside.stdout !== "true") throw new Error("This folder is not a git repository, so a worker cannot be isolated in a branch of it.");
  const id = jobId.slice(0, 8);
  const branch = `calvras/${id}`;
  const target = worktreeDir(root, id);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // A leftover from a run that never resolved would make `worktree add` fail for the right reason.
  if (await fs.access(target).then(() => true).catch(() => false)) await git(["worktree", "remove", "--force", target], root);
  const added = await git(["worktree", "add", "-B", branch, target, "HEAD"], root);
  if (!added.ok) throw new Error(`Could not create the isolated checkout: ${added.error}`);
  await hideFromStatus(root);
  return { id, path: target, branch, createdAt: Date.now() };
}

/** What the worker changed, in its own words: the files git reports plus the diff stat. */
export async function worktreeChanges(worktree: Worktree) {
  // Staging in the worktree is what makes brand-new files show up in the diff at all.
  await git(["add", "-A", "."], worktree.path);
  const staged = await git(["diff", "--cached", "--name-status", "HEAD"], worktree.path);
  const stat = await git(["diff", "--cached", "--stat", "HEAD"], worktree.path);
  const files = staged.ok ? staged.stdout.split("\n").filter(Boolean).map((line) => {
    const [status, ...rest] = line.split("\t");
    return { status: status || "?", path: rest.join("\t") };
  }) : [];
  return { ok: true, branch: worktree.branch, path: worktree.path, files, summary: stat.ok ? stat.stdout : "", error: staged.ok ? undefined : staged.error };
}

/** Bring the worker's work back as one patch. Conflicts are reported, never forced. */
export async function applyWorktree(root: string, worktree: Worktree) {
  await git(["add", "-A", "."], worktree.path);
  const patch = await gitRaw(["diff", "--cached", "HEAD"], worktree.path);
  if (!patch.ok) return { ok: false, error: patch.error };
  if (!patch.stdout.trim()) return { ok: true, message: "The worker changed nothing, so there was nothing to bring back.", files: [] };
  // The patch goes through a file, not a pipe: a hanging stdin would block the whole turn.
  const file = path.join(root, ".calvras", `worker-${worktree.id}.patch`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, patch.stdout, "utf8");
  // git reads forward slashes on every platform; a Windows-native relative path it treats as escapes.
  const relative = path.relative(root, file).split(path.sep).join("/");
  const files = (await git(["diff", "--cached", "--name-only", "HEAD"], worktree.path)).stdout.split("\n").filter(Boolean);
  if ((await git(["apply", "--check", relative], root)).ok) {
    const applied = await git(["apply", relative], root);
    if (!applied.ok) return { ok: false, error: applied.error, patchFile: relative };
    return { ok: true, message: "Applied the worker's changes to the folder.", files };
  }
  // The user may have edited the same lines meanwhile. A three-way merge says so with markers
  // the user can resolve; forcing the worker's version over theirs would silently lose work.
  const merged = await git(["apply", "--3way", relative], root);
  if (!merged.ok) return { ok: false, error: `The change conflicts with the folder, so nothing was overwritten. The patch is saved at ${relative}.`, patchFile: relative };
  return { ok: true, message: "Merged the worker's changes into the folder. Any overlap is marked for you to settle.", files };
}

export async function removeWorktree(root: string, worktree: Worktree) {
  const removed = await git(["worktree", "remove", "--force", worktree.path], root);
  if (!removed.ok) return { ok: false, error: removed.error };
  await git(["branch", "-D", worktree.branch], root);
  return { ok: true, message: `Discarded the isolated checkout and its branch ${worktree.branch}.` };
}

/** Where the worktrees live, so the guard can treat them as part of the project. */
export const worktreeRoot = (root: string) => path.join(root, ".calvras", "worktrees");
