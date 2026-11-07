import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { guardedRoot } from "./permissions";
import type { AccessMode } from "../tool-catalog";

/**
 * Work that starts on its own after the conversation has ended. A turn stops when the tab
 * closes; a scheduled entry lives in the project folder, so Calvras picks it up the next time
 * it runs and reports the catch-up instead of quietly losing the appointment.
 */

export type ScheduleKind = "at" | "every" | "daily";
export const SCHEDULE_KINDS: ScheduleKind[] = ["at", "every", "daily"];

export type ScheduledRun = {
  id: string;
  prompt: string;
  kind: ScheduleKind;
  /** Absolute ms for a one-off run. */
  at?: number;
  /** Interval ms for a repeating run. */
  everyMs?: number;
  /** Local "HH:MM" for a daily run. */
  timeOfDay?: string;
  mode: AccessMode;
  enabled: boolean;
  createdAt: string;
  nextRunAt: number;
  lastRunAt?: number;
  lastStatus?: string;
  lastNote?: string;
  runs: { at: number; status: string; note: string }[];
};

const MAX_RUNS = 20;
const MIN_INTERVAL_MS = 60_000;
const MAX_PROMPT = 8_000;

const schedulePath = (root: string) => path.join(root, ".calvras", "schedule.json");
const chains = new Map<string, Promise<any>>();
function serialize<T>(root: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(root) ?? Promise.resolve();
  const next = previous.then(work, work);
  chains.set(root, next.catch(() => {}));
  return next;
}

/** The next moment strictly after `from`, or undefined when the entry has no future. */
export function computeNext(entry: Pick<ScheduledRun, "kind" | "at" | "everyMs" | "timeOfDay" | "nextRunAt">, from: number): number | undefined {
  if (entry.kind === "at") return typeof entry.at === "number" && entry.at > from ? entry.at : undefined;
  if (entry.kind === "every") {
    const everyMs = Number(entry.everyMs);
    if (!Number.isFinite(everyMs) || everyMs < MIN_INTERVAL_MS) return undefined;
    // Anchor on the schedule rather than on when the run happened, or an hourly job that starts
    // four minutes late drifts later every day.
    let next = entry.nextRunAt + everyMs;
    while (next <= from) next += everyMs;
    return next;
  }
  if (entry.kind === "daily") {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(entry.timeOfDay || ""));
    if (!match) return undefined;
    const hour = Number(match[1]); const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return undefined;
    const day = new Date(from);
    day.setHours(hour, minute, 0, 0);
    if (day.getTime() <= from) day.setDate(day.getDate() + 1);
    return day.getTime();
  }
  return undefined;
}

function sanitize(raw: any): ScheduledRun | null {
  if (!raw || typeof raw !== "object" || typeof raw.prompt !== "string" || !raw.prompt.trim()) return null;
  if (!SCHEDULE_KINDS.includes(raw.kind)) return null;
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString();
  const everyMs = Number(raw.everyMs); const at = Number(raw.at);
  const entry: ScheduledRun = {
    id: String(raw.id || randomUUID()).slice(0, 64),
    prompt: raw.prompt.trim().slice(0, MAX_PROMPT),
    kind: raw.kind,
    ...(raw.kind === "at" && Number.isFinite(at) ? { at } : {}),
    ...(raw.kind === "every" && Number.isFinite(everyMs) && everyMs >= MIN_INTERVAL_MS ? { everyMs } : {}),
    ...(raw.kind === "daily" && /^\d{1,2}:\d{2}$/.test(String(raw.timeOfDay || "")) ? { timeOfDay: String(raw.timeOfDay) } : {}),
    mode: ["ask", "automatic", "full"].includes(raw.mode) ? raw.mode : "automatic",
    enabled: raw.enabled !== false,
    createdAt,
    nextRunAt: Number.isFinite(Number(raw.nextRunAt)) ? Number(raw.nextRunAt) : Date.now(),
    ...(Number.isFinite(Number(raw.lastRunAt)) ? { lastRunAt: Number(raw.lastRunAt) } : {}),
    ...(typeof raw.lastStatus === "string" ? { lastStatus: raw.lastStatus.slice(0, 60) } : {}),
    ...(typeof raw.lastNote === "string" ? { lastNote: raw.lastNote.slice(0, 500) } : {}),
    runs: Array.isArray(raw.runs) ? raw.runs.filter((run: any) => run && Number.isFinite(Number(run.at))).slice(-MAX_RUNS).map((run: any) => ({ at: Number(run.at), status: String(run.status || "").slice(0, 60), note: String(run.note || "").slice(0, 500) })) : [],
  };
  // A stored entry whose schedule no longer resolves is not a run waiting to happen, so it is
  // reported as finished rather than being claimed forever.
  if (entry.kind === "every" && !entry.everyMs) entry.enabled = false;
  if (entry.kind === "daily" && !entry.timeOfDay) entry.enabled = false;
  return entry;
}

async function readAll(root: string): Promise<ScheduledRun[]> {
  try {
    const stored = JSON.parse(await fs.readFile(schedulePath(root), "utf8"));
    return Array.isArray(stored?.entries) ? stored.entries.map(sanitize).filter(Boolean) : [];
  } catch (error: any) { if (error?.code !== "ENOENT") throw error; return []; }
}

async function writeAll(root: string, entries: ScheduledRun[]) {
  const file = schedulePath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + ".tmp", JSON.stringify({ entries }, null, 2), "utf8");
  await fs.rename(file + ".tmp", file);
}

export async function listSchedule(projectPath: string) {
  const root = guardedRoot(projectPath);
  return serialize(root, async () => ({ ok: true, entries: await readAll(root) }));
}

export type ScheduleInput = { prompt: string; kind: string; at?: unknown; everyMinutes?: unknown; timeOfDay?: unknown; mode?: string };

export async function addSchedule(projectPath: string, input: ScheduleInput) {
  const root = guardedRoot(projectPath);
  const kind = String(input.kind || "") as ScheduleKind;
  const prompt = String(input.prompt || "").trim().slice(0, MAX_PROMPT);
  if (!prompt) throw new Error("Say what the scheduled run should do.");
  if (!SCHEDULE_KINDS.includes(kind)) throw new Error("Schedule a run for one time, every N minutes, or daily at a time.");
  const draft: any = { id: randomUUID(), prompt, kind, mode: input.mode, createdAt: new Date().toISOString(), enabled: true, nextRunAt: Date.now(), runs: [] };
  if (kind === "at") {
    // Models state a time as "2026-10-19T09:00", so accept either form and store one number.
    const at = typeof input.at === "string" ? Date.parse(input.at) : Number(input.at);
    if (!Number.isFinite(at) || at <= 0) throw new Error("Give the run a date and time, like 2026-10-19T09:00.");
    draft.at = at;
  }
  if (kind === "every") {
    const minutes = Number(input.everyMinutes);
    if (!Number.isFinite(minutes) || minutes < 1) throw new Error("A repeating run needs an interval of at least a minute.");
    draft.everyMs = Math.min(30 * 24 * 60, minutes) * 60_000;
    // The first firing is one interval out; claiming it the moment it is saved would run it twice
    // as fast as the user asked for.
    draft.nextRunAt = Date.now() + draft.everyMs;
  }
  if (kind === "daily") {
    if (!/^(\d{1,2}):(\d{2})$/.test(String(input.timeOfDay || ""))) throw new Error("Give the daily run a time like 09:30.");
    draft.timeOfDay = String(input.timeOfDay);
  }
  const entry = sanitize(draft)!;
  const next = computeNext(entry, kind === "at" ? Date.now() - 1 : Date.now());
  if (next === undefined) throw new Error("That schedule has no next run. Check the time or interval.");
  entry.nextRunAt = kind === "every" ? draft.nextRunAt : next;
  return serialize(root, async () => {
    const entries = await readAll(root);
    entries.push(entry);
    await writeAll(root, entries);
    return { ok: true, entry, entries };
  });
}

/** What is due right now. Claiming advances the schedule, so two windows cannot both fire it. */
export async function claimDue(projectPath: string, now = Date.now()) {
  const root = guardedRoot(projectPath);
  return serialize(root, async () => {
    const entries = await readAll(root);
    const due = entries.filter((entry) => entry.enabled && entry.nextRunAt <= now);
    for (const entry of due) {
      entry.lastRunAt = now; entry.lastStatus = "started";
      const next = computeNext(entry, now);
      if (next === undefined) { entry.enabled = false; entry.nextRunAt = now; } else entry.nextRunAt = next;
      entry.runs = [...entry.runs, { at: now, status: "started", note: "" }].slice(-MAX_RUNS);
    }
    if (due.length) await writeAll(root, entries);
    return { ok: true, due, entries };
  });
}

export async function reportRun(projectPath: string, id: string, status: string, note = "") {
  const root = guardedRoot(projectPath);
  return serialize(root, async () => {
    const entries = await readAll(root);
    const entry = entries.find((item) => item.id === id);
    if (!entry) return { ok: false as const, error: "No scheduled run has that id." };
    entry.lastStatus = status.slice(0, 60); entry.lastNote = note.slice(0, 500);
    entry.runs = [...entry.runs.slice(-MAX_RUNS + 1), { at: entry.lastRunAt ?? Date.now(), status: status.slice(0, 60), note: note.slice(0, 500) }];
    await writeAll(root, entries);
    return { ok: true as const, entry, entries };
  });
}

/** Cancel drops the appointment entirely; pausing keeps its history and its next time. */
export async function setScheduleEnabled(projectPath: string, id: string, enabled: boolean) {
  const root = guardedRoot(projectPath);
  return serialize(root, async () => {
    const entries = await readAll(root);
    const entry = entries.find((item) => item.id === id);
    if (!entry) return { ok: false as const, error: "No scheduled run has that id." };
    entry.enabled = enabled;
    if (enabled) {
      // A run paused across a restart is not a debt: it fires on its next real slot, unless it is
      // a one-off whose moment has passed, which is reported as overdue rather than faked.
      const next = computeNext(entry, Date.now() - 1);
      if (next === undefined) return { ok: false as const, error: "That one-off time has already passed. Schedule it again." };
      entry.nextRunAt = next;
    }
    await writeAll(root, entries);
    return { ok: true as const, entry, entries };
  });
}

export async function removeSchedule(projectPath: string, id: string) {
  const root = guardedRoot(projectPath);
  return serialize(root, async () => {
    const entries = await readAll(root);
    const kept = entries.filter((item) => item.id !== id);
    if (kept.length === entries.length) return { ok: false as const, error: "No scheduled run has that id." };
    await writeAll(root, kept);
    return { ok: true as const, entries: kept };
  });
}
