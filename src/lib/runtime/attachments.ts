import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { guardedRoot } from './permissions';

const MAX_ATTACHMENT = 25 * 1024 * 1024;
const MAX_FILES = 20;

export type StoredAttachment = {
  name: string; path: string; relativePath: string; type: string; size: number; scope: 'workspace' | 'vault';
  textPath?: string; textRelativePath?: string;
};

/** Global vault for attachments sent while no project folder is selected. */
function vaultRoot() {
  return process.env['CALVRAS_ATTACHMENTS_DIR'] || path.join(process.env['LOCALAPPDATA'] || process.env['APPDATA'] || os.homedir(), 'Calvras', 'attachments');
}

/** Persist uploaded/pasted files in <workspace>/.calvras/attachments, or in the global Calvras vault with no workspace. */
export async function storeAttachments(projectPath: string | undefined, files: unknown[]): Promise<StoredAttachment[]> {
  const workspace = projectPath?.trim() || '';
  const root = workspace ? guardedRoot(workspace) : vaultRoot();
  const dir = workspace ? path.join(root, '.calvras', 'attachments') : root;
  await fs.mkdir(dir, { recursive: true });
  const stored: StoredAttachment[] = [];
  for (const raw of files.slice(0, MAX_FILES)) {
    const file = (raw && typeof raw === 'object' ? raw : {}) as { name?: unknown; type?: unknown; dataUrl?: unknown; text?: unknown };
    const dataUrl = typeof file.dataUrl === 'string' ? file.dataUrl : '';
    const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
    if (!match) throw new Error('Attachment must be a data URL.');
    const name = path.basename(String(file.name || 'attachment')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().slice(0, 120) || 'attachment';
    const buffer = match[2] ? Buffer.from(match[3]!, 'base64') : Buffer.from(decodeURIComponent(match[3]!), 'utf8');
    if (buffer.length > MAX_ATTACHMENT) throw new Error(`${name} is larger than 25 MB.`);
    const target = path.join(dir, name);
    await fs.writeFile(target, buffer);
    const entry: StoredAttachment = {
      name, path: target, relativePath: workspace ? path.relative(root, target).split(path.sep).join('/') : target,
      type: String(file.type || match[1] || 'application/octet-stream'), size: buffer.length, scope: workspace ? 'workspace' : 'vault',
    };
    if (typeof file.text === 'string' && file.text.trim()) {
      const textPath = `${target}.txt`;
      await fs.writeFile(textPath, file.text.slice(0, 2_000_000), 'utf8');
      entry.textPath = textPath;
      entry.textRelativePath = workspace ? path.relative(root, textPath).split(path.sep).join('/') : textPath;
    }
    stored.push(entry);
  }
  return stored;
}
