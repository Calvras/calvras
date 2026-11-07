import fs from 'node:fs/promises';
import path from 'node:path';
import { guardedRoot } from './permissions';

const MAX_JOURNAL_BYTES = 160_000;
const MAX_ENTRY_BYTES = 12_000;

function journalPath(root: string) {
  return path.join(root, '.calvras', 'journal.md');
}

export async function readJournal(projectPath: string): Promise<string> {
  const root = guardedRoot(projectPath);
  try {
    const content = await fs.readFile(journalPath(root), 'utf8');
    return content.slice(-MAX_JOURNAL_BYTES);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

export async function appendJournal(projectPath: string, entry: string): Promise<{ ok: boolean; relativePath: string; bytes: number }> {
  const root = guardedRoot(projectPath);
  const body = String(entry ?? '').trim().slice(0, MAX_ENTRY_BYTES);
  if (!body) throw new Error('The journal entry is empty.');
  const target = journalPath(root);
  await fs.mkdir(path.dirname(target), { recursive: true });
  let existing = '';
  try { existing = await fs.readFile(target, 'utf8'); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  const stamp = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  let next = `${existing}${existing ? '\n' : ''}## ${stamp}\n${body}\n`;
  if (next.length > MAX_JOURNAL_BYTES) next = `# Calvras workspace journal\n${next.slice(next.length - MAX_JOURNAL_BYTES + 40)}`;
  await fs.writeFile(target, next, 'utf8');
  return { ok: true, relativePath: path.relative(root, target), bytes: Buffer.byteLength(next) };
}
