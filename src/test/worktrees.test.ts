// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { applyWorktree, createWorktree, removeWorktree, worktreeChanges } from '../lib/runtime/worktrees';

const run = promisify(execFile);
const roots: string[] = [];
/** git checks files out with the platform's line endings, so tests compare logical content. */
const read = async (file: string) => (await fs.readFile(file, "utf8")).split("\r\n").join("\n");

/** A real repo in a temp folder: every assertion below reads what git itself reports. */
async function gitRepo() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-worktree-test-'));
  const cwd = await fs.realpath(await fs.mkdir(path.join(base, 'work'), { recursive: true }).then(() => path.join(base, 'work')));
  roots.push(cwd);
  const git = (...args: string[]) => run('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Calvras Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Calvras Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
  await git('init', '-b', 'main');
  await fs.writeFile(path.join(cwd, 'notes.md'), 'one\n');
  await git('add', 'notes.md');
  await git('commit', '-m', 'seed');
  return { root: cwd, git };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe('isolated subagent checkouts', () => {
  it('gives a worker its own checkout without touching the shared folder', async () => {
    const { root, git } = await gitRepo();
    const worktree = await createWorktree(root, 'abcdef1234-abcd');
    expect(worktree.branch).toBe('calvras/abcdef12');
    expect(await read(path.join(worktree.path, 'notes.md'))).toBe('one\n');
    // The scratch checkout is kept out of the user's own git status.
    expect((await git('status', '--porcelain')).stdout.trim()).toBe('');

    await fs.writeFile(path.join(worktree.path, 'notes.md'), 'one\ntwo\n');
    await fs.writeFile(path.join(worktree.path, 'new.md'), 'worker wrote this\n');
    const changes = await worktreeChanges(worktree);
    expect(changes.files.map((file) => file.path).sort()).toEqual(['new.md', 'notes.md']);
    // Two workers on one folder is the thing this avoids: the main checkout never saw either write.
    expect(await read(path.join(root, 'notes.md'))).toBe('one\n');
    expect(await read(path.join(worktree.path, 'notes.md'))).toBe('one\ntwo\n');
  });

  it('brings the worker work back as one patch and clears its checkout', async () => {
    const { root, git } = await gitRepo();
    const worktree = await createWorktree(root, 'feedface0000');
    await fs.writeFile(path.join(worktree.path, 'notes.md'), 'one\ntwo\n');
    const applied = await applyWorktree(root, worktree);
    expect(applied.ok ? true : `${applied.error} :: ${applied.patchFile}`).toBe(true);
    expect(await read(path.join(root, 'notes.md'))).toBe('one\ntwo\n');
    expect((await git('status', '--porcelain')).stdout).toContain('notes.md');
    const discarded = await removeWorktree(root, worktree);
    expect(discarded.ok).toBe(true);
    expect(await fs.access(worktree.path).then(() => true).catch(() => false)).toBe(false);
    expect((await git('branch', '--list', worktree.branch)).stdout.trim()).toBe('');
  });

  it('reports a conflict instead of overwriting what the user changed meanwhile', async () => {
    const { root } = await gitRepo();
    const worktree = await createWorktree(root, 'deadbeef9999');
    await fs.writeFile(path.join(worktree.path, 'notes.md'), 'one\nworker line\n');
    // The user edits the same line in the shared folder while the worker is running.
    await fs.writeFile(path.join(root, 'notes.md'), 'one\nuser line\n');
    const applied = await applyWorktree(root, worktree);
    expect(await read(path.join(root, 'notes.md'))).not.toBe('one\nworker line\n');
    if (!applied.ok) expect(await fs.access(worktree.path).then(() => true).catch(() => false)).toBe(true);
  });

  it('refuses to isolate a worker in a folder that is not a repository', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-not-a-repo-'));
    roots.push(root);
    await expect(createWorktree(root, 'cafe1234')).rejects.toThrow(/not a git repository/);
  });

  it('discards a checkout and leaves the shared folder exactly as it was', async () => {
    const { root, git } = await gitRepo();
    const worktree = await createWorktree(root, 'b1b1b1b1');
    await fs.writeFile(path.join(worktree.path, 'scratch.txt'), 'thrown away\n');
    await worktreeChanges(worktree);
    expect((await removeWorktree(root, worktree)).ok).toBe(true);
    expect(await read(path.join(root, 'notes.md'))).toBe('one\n');
    expect((await git('status', '--porcelain')).stdout.trim()).toBe('');
    expect(await fs.access(path.join(root, 'scratch.txt')).then(() => true).catch(() => false)).toBe(false);
  });
});
