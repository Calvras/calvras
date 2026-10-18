// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendJournal, readJournal } from '../lib/runtime/journal';

let root = '';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-journal-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('workspace journal', () => {
  it('returns an empty string for a fresh workspace', async () => {
    expect(await readJournal(root)).toBe('');
  });

  it('appends timestamped entries in order and reads them back', async () => {
    await appendJournal(root, '**Request:** add a save button\n**Outcome:** finished');
    await appendJournal(root, '**Request:** fix the failing test\n**Outcome:** blocked');

    const content = await readJournal(root);
    expect(content).toContain('add a save button');
    expect(content).toContain('fix the failing test');
    expect(content.indexOf('save button')).toBeLessThan(content.indexOf('failing test'));
    expect(content.match(/^## /gm)?.length).toBe(2);
    expect((await fs.readFile(path.join(root, '.calvras', 'journal.md'), 'utf8'))).toBe(content);
  });

  it('rejects empty entries', async () => {
    await expect(appendJournal(root, '   ')).rejects.toThrow('empty');
  });
});
