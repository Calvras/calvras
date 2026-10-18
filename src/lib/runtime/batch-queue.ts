import fs from 'node:fs/promises';
import path from 'node:path';
import { guardedRoot } from './permissions';

/**
 * A durable to-do list for repeated web work — "apply to every posting on this site",
 * "book these ten dates". It lives in the project so a run that is interrupted, restarted,
 * or continued in a later conversation picks up exactly where it stopped and never performs
 * the same target twice.
 */

export type BatchStatus = "queued" | "running" | "done" | "blocked" | "skipped";
export const BATCH_STATUSES: BatchStatus[] = ["queued", "running", "done", "blocked", "skipped"];

export type BatchItem = {
  id: string;
  url: string;
  label: string;
  status: BatchStatus;
  note: string;
  reference: string;
  attempts: number;
  updatedAt: string;
};

export type Batch = { title: string; createdAt: string; items: BatchItem[] };

const MAX_ITEMS = 5_000;
const TRACKING = /^(utm_|gclid|fbclid|ref$|ref_src|src|source|mc_|msclkid|dclid|twclid|ttclid)/i;

function batchPath(root: string) { return path.join(root, '.calvras', 'batch.json'); }

/** Two links to the same posting differ mostly by tracking noise, so dedupe on the quiet form. */
export function targetKey(value: string): string {
  let url: URL;
  try { url = new URL(String(value).trim()); } catch { return String(value).trim().toLowerCase(); }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  url.hostname = url.hostname.replace(/^www\./, "");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return `${url.hostname}${url.pathname}${url.search}`.toLowerCase();
}

/** Serialized per project: delegated workers report on the same ledger concurrently. */
const chains = new Map<string, Promise<any>>();
function serialize<T>(root: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(root) ?? Promise.resolve();
  const next = previous.then(work, work);
  chains.set(root, next.catch(() => {}));
  return next;
}

function empty(title: string): Batch { return { title, createdAt: new Date().toISOString(), items: [] }; }

function parseBatch(raw: string, title: string): Batch {
  const stored = JSON.parse(raw);
  if (!stored || !Array.isArray(stored.items)) return empty(String(title));
  const items = stored.items.filter((item: any) => item && typeof item.url === 'string').slice(0, MAX_ITEMS).map((item: any): BatchItem => ({
    id: String(item.id || targetKey(String(item.url))).slice(0, 200),
    url: String(item.url).slice(0, 2_000),
    label: String(item.label || item.url).slice(0, 300),
    status: BATCH_STATUSES.includes(item.status) ? item.status : "queued",
    note: String(item.note || "").slice(0, 600),
    reference: String(item.reference || "").slice(0, 120),
    attempts: Number.isFinite(item.attempts) ? Math.max(0, Math.trunc(item.attempts)) : 0,
    updatedAt: String(item.updatedAt || new Date().toISOString()).slice(0, 40),
  }));
  return { title: String(stored.title || title).slice(0, 200), createdAt: String(stored.createdAt || new Date().toISOString()), items };
}

export async function readBatch(projectPath: string, title = "Batch"): Promise<Batch> {
  const root = guardedRoot(projectPath);
  try { return parseBatch(await fs.readFile(batchPath(root), 'utf8'), title); }
  catch (error: any) { if (error?.code === 'ENOENT') return empty(title); throw error; }
}

async function writeBatch(root: string, batch: Batch): Promise<void> {
  const target = batchPath(root);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(`${target}.tmp`, JSON.stringify(batch, null, 2), 'utf8');
  await fs.rename(`${target}.tmp`, target).catch(async () => { await fs.writeFile(target, JSON.stringify(batch, null, 2), 'utf8'); });
}

export function batchCounts(items: BatchItem[]) {
  const counts = { queued: 0, running: 0, done: 0, blocked: 0, skipped: 0 } as Record<BatchStatus, number>;
  for (const item of items) counts[item.status] += 1;
  return counts;
}

export type BatchAdd = { url: string; label?: string; id?: string };

export async function enqueueBatch(projectPath: string, title: string, adds: BatchAdd[]) {
  const root = guardedRoot(projectPath);
  return serialize(root, async () => {
    const batch = await readBatch(root, title);
    if (title && !batch.title) batch.title = String(title).slice(0, 200);
    const seen = new Set(batch.items.map((item) => targetKey(item.url)));
    const ids = new Set(batch.items.map((item) => item.id));
    let added = 0; let duplicate = 0;
    for (const add of adds) {
      const url = String(add?.url || '').trim();
      if (!url) continue;
      const key = targetKey(url);
      if (seen.has(key)) { duplicate += 1; continue; }
      if (batch.items.length >= MAX_ITEMS) break;
      let id = String(add.id || key).slice(0, 200);
      while (ids.has(id)) id = `${id}~`;
      ids.add(id); seen.add(key); added += 1;
      batch.items.push({ id, url: url.slice(0, 2_000), label: String(add.label || url).slice(0, 300), status: "queued", note: "", reference: "", attempts: 0, updatedAt: new Date().toISOString() });
    }
    await writeBatch(root, batch);
    const counts = batchCounts(batch.items);
    return { ok: true as const, title: batch.title, added, duplicate, ...counts, total: batch.items.length };
  });
}

/** Hands out the next chunk of untouched targets and marks them claimed. */
export async function claimBatch(projectPath: string, count = 3) {
  const root = guardedRoot(projectPath);
  return serialize(root, async () => {
    const batch = await readBatch(root);
    const wanted = Math.min(10, Math.max(1, Math.trunc(Number(count)) || 3));
    const claimed = batch.items.filter((item) => item.status === "queued").slice(0, wanted);
    for (const item of claimed) { item.status = "running"; item.attempts += 1; item.updatedAt = new Date().toISOString(); }
    if (claimed.length) await writeBatch(root, batch);
    const counts = batchCounts(batch.items);
    return { ok: true as const, title: batch.title, claimed: claimed.map(({ id, url, label, attempts }) => ({ id, url, label, attempts })), ...counts, remaining: claimed.length ? counts.queued : 0 };
  });
}

export async function reportBatch(projectPath: string, id: string, status: BatchStatus, note = "", reference = "") {
  const root = guardedRoot(projectPath);
  return serialize(root, async () => {
    const batch = await readBatch(root);
    const item = batch.items.find((entry) => entry.id === id || targetKey(entry.url) === targetKey(id));
    if (!item) throw new Error(`No batch target with id ${id}. Read the ledger with batch_status first.`);
    if (!BATCH_STATUSES.includes(status)) throw new Error("A batch target ends as done, blocked, or skipped.");
    item.status = status;
    if (note) item.note = String(note).slice(0, 600);
    if (reference) item.reference = String(reference).slice(0, 120);
    item.updatedAt = new Date().toISOString();
    await writeBatch(root, batch);
    const counts = batchCounts(batch.items);
    const next = batch.items.filter((entry) => entry.status === "queued").slice(0, 3).map(({ id: nextId, url, label }) => ({ id: nextId, url, label }));
    return { ok: true as const, id: item.id, label: item.label, status: item.status, reference: item.reference, ...counts, next };
  });
}

/** Compact on purpose: a thousand-entry ledger must not be dumped into the model's context. */
export async function batchStatus(projectPath: string) {
  const root = guardedRoot(projectPath);
  const batch = await readBatch(root);
  const counts = batchCounts(batch.items);
  const preview = (status: BatchStatus, limit: number) => batch.items.filter((item) => item.status === status).slice(0, limit)
    .map(({ id, label, url, note, reference }) => ({ id, label, url, ...(note ? { note } : {}), ...(reference ? { reference } : {}) }));
  return {
    ok: true as const,
    title: batch.title,
    total: batch.items.length,
    ...counts,
    pending: preview("queued", 10),
    inProgress: preview("running", 10),
    problems: [...preview("blocked", 10), ...preview("skipped", 5)],
    completed: preview("done", 5),
  };
}
