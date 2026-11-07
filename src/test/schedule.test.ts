import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addSchedule, claimDue, computeNext, listSchedule, removeSchedule, reportRun, setScheduleEnabled } from "@/lib/runtime/schedule";

let root = "";
const roots: string[] = [];

const MINUTE = 60_000;
const HOUR = 3_600_000;

async function entries() { return (await listSchedule(root)).entries; }
async function seed(entries: any[]) {
  await fs.mkdir(path.join(root, ".calvras"), { recursive: true });
  await fs.writeFile(path.join(root, ".calvras", "schedule.json"), JSON.stringify({ entries }), "utf8");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-schedule-"));
  roots.push(root);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("the next moment of a schedule", () => {
  it("has no future once a one-off time has passed", () => {
    const at = Date.parse("2026-10-19T09:00:00");
    expect(computeNext({ kind: "at", at, nextRunAt: at }, at - 1)).toBe(at);
    expect(computeNext({ kind: "at", at, nextRunAt: at }, at)).toBeUndefined();
  });
  it("keeps a repeating run on its own grid instead of drifting later each time", () => {
    const started = 1_000;
    // A run claimed four minutes late must still land on the original hour boundaries.
    expect(computeNext({ kind: "every", everyMs: HOUR, nextRunAt: started }, started + HOUR + 4 * MINUTE)).toBe(started + 2 * HOUR);
    expect(computeNext({ kind: "every", everyMs: HOUR, nextRunAt: started }, started + 10 * HOUR)).toBe(started + 11 * HOUR);
  });
  it("refuses an interval below a minute, which would fire on every poll", () => {
    expect(computeNext({ kind: "every", everyMs: 30_000, nextRunAt: 0 }, 1_000)).toBeUndefined();
  });
  it("rolls a daily time over to tomorrow once today's slot has gone", () => {
    const morning = new Date(2026, 9, 19, 9, 30, 0, 0).getTime();
    expect(computeNext({ kind: "daily", timeOfDay: "09:30", nextRunAt: morning }, morning - 1)).toBe(morning);
    expect(computeNext({ kind: "daily", timeOfDay: "09:30", nextRunAt: morning }, morning + 1)).toBe(morning + 24 * HOUR);
    expect(computeNext({ kind: "daily", timeOfDay: "25:00", nextRunAt: 0 }, 1)).toBeUndefined();
  });
});

describe("appointments stored in the project folder", () => {
  it("rejects a schedule that could never run", async () => {
    await expect(addSchedule(root, { prompt: "", kind: "every", everyMinutes: 5 })).rejects.toThrow(/Say what the scheduled run should do/);
    await expect(addSchedule(root, { prompt: "Ping", kind: "weekly" })).rejects.toThrow(/one time, every N minutes, or daily/);
    await expect(addSchedule(root, { prompt: "Ping", kind: "every", everyMinutes: 0 })).rejects.toThrow(/at least a minute/);
    await expect(addSchedule(root, { prompt: "Ping", kind: "daily", timeOfDay: "9am" })).rejects.toThrow(/a time like 09:30/);
    await expect(addSchedule(root, { prompt: "Ping", kind: "at", at: "not a time" })).rejects.toThrow(/date and time/);
    await expect(addSchedule(root, { prompt: "Ping", kind: "at", at: "2000-01-01T09:00" })).rejects.toThrow(/no next run/);
    expect(await entries()).toEqual([]);
  });

  it("takes a model's own ISO time and stores one number", async () => {
    const created = await addSchedule(root, { prompt: "Summarise the day", kind: "at", at: "2030-01-02T09:00" });
    const stored = (await entries())[0];
    expect(stored?.at).toBe(Date.parse("2030-01-02T09:00"));
    expect(stored?.nextRunAt).toBe(created.entry.at);
    expect(stored?.enabled).toBe(true);
  });

  it("does not run a repeating job the instant it is appointed", async () => {
    const before = Date.now();
    const created = await addSchedule(root, { prompt: "Check the build", kind: "every", everyMinutes: 30 });
    expect(created.entry.nextRunAt).toBeGreaterThanOrEqual(before + 30 * MINUTE - 1_000);
    expect((await claimDue(root, Date.now())).due).toEqual([]);
    expect((await claimDue(root, Number(created.entry.nextRunAt))).due.map((entry) => entry.id)).toEqual([created.entry.id]);
  });

  it("keeps the appointment after the app closes and reopens", async () => {
    const created = await addSchedule(root, { prompt: "Nightly tidy", kind: "daily", timeOfDay: "23:30" });
    // Nothing is cached in a process here: reading the file back is what a fresh window does.
    const raw = JSON.parse(await fs.readFile(path.join(root, ".calvras", "schedule.json"), "utf8"));
    expect(raw.entries.map((entry: any) => entry.id)).toEqual([created.entry.id]);
    expect((await entries())[0]).toMatchObject({ prompt: "Nightly tidy", kind: "daily", timeOfDay: "23:30" });
  });

  it("runs an appointment that came due while the app was shut", async () => {
    const created = await addSchedule(root, { prompt: "Refresh the report", kind: "every", everyMinutes: 1 });
    // Two minutes of the hour go by with the window closed; the ledger still says it is due.
    const caught = await claimDue(root, Number(created.entry.nextRunAt) + 2 * MINUTE);
    expect(caught.due.map((entry) => entry.prompt)).toEqual(["Refresh the report"]);
    // Claiming moves it on, so a second window polling at the same moment cannot fire it twice.
    expect((await claimDue(root, Number(created.entry.nextRunAt) + 2 * MINUTE)).due).toEqual([]);
    expect((await entries())[0]?.nextRunAt).toBe(Number(created.entry.nextRunAt) + 3 * MINUTE);
  });

  it("retires a one-off once it has fired", async () => {
    const at = Date.parse("2030-01-02T09:00");
    const created = await addSchedule(root, { prompt: "Open the conference", kind: "at", at });
    expect((await claimDue(root, at + 1)).due).toHaveLength(1);
    const after = (await entries())[0];
    expect(after?.enabled).toBe(false);
    expect(after?.lastStatus).toBe("started");
  });

  it("records the outcome the turn itself reached", async () => {
    const created = await addSchedule(root, { prompt: "Run the tests", kind: "every", everyMinutes: 5 });
    await claimDue(root, Number(created.entry.nextRunAt));
    const reported = await reportRun(root, created.entry.id, "blocked", "The test command exits 1 on src/foo.test.ts.");
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;
    expect(reported.entry).toMatchObject({ lastStatus: "blocked", lastNote: "The test command exits 1 on src/foo.test.ts." });
    expect(reported.entry.runs.at(-1)?.status).toBe("blocked");
    expect((await reportRun(root, "no-such-id", "finished")).ok).toBe(false);
  });

  it("pauses and resumes without losing what already ran", async () => {
    const created = await addSchedule(root, { prompt: "Every morning", kind: "daily", timeOfDay: "07:00" });
    await claimDue(root, Number(created.entry.nextRunAt) + 1);
    await reportRun(root, created.entry.id, "finished", "Wrote the brief.");
    const paused = await setScheduleEnabled(root, created.entry.id, false);
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    expect(paused.entry.enabled).toBe(false);
    expect(paused.entry.runs.length).toBeGreaterThan(0);
    expect((await claimDue(root, Date.now() + 100 * HOUR)).due).toEqual([]);
    const resumed = await setScheduleEnabled(root, created.entry.id, true);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.entry.enabled).toBe(true);
    expect(resumed.entry.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("reports a one-off whose moment went by while it was paused instead of firing late", async () => {
    const created = await addSchedule(root, { prompt: "Stand-up", kind: "at", at: Date.now() + 10 * MINUTE });
    await setScheduleEnabled(root, created.entry.id, false);
    // The clock moves past the appointment while it sits paused in the ledger.
    const stored = JSON.parse(await fs.readFile(path.join(root, ".calvras", "schedule.json"), "utf8"));
    stored.entries[0].at = Date.now() - 1_000;
    await seed(stored.entries);
    const late = await setScheduleEnabled(root, created.entry.id, true);
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.error).toMatch(/already passed/);
    expect((await entries())[0]?.enabled).toBe(false);
  });

  it("drops an appointment for good and keeps the others", async () => {
    const first = await addSchedule(root, { prompt: "First", kind: "every", everyMinutes: 10 });
    await addSchedule(root, { prompt: "Second", kind: "every", everyMinutes: 20 });
    expect((await entries()).length).toBe(2);
    expect((await removeSchedule(root, first.entry.id)).ok).toBe(true);
    expect((await entries()).map((entry) => entry.prompt)).toEqual(["Second"]);
    expect((await removeSchedule(root, first.entry.id)).ok).toBe(false);
  });

  it("ignores a ledger entry that cannot be a run", async () => {
    await seed([
      { id: "ok", prompt: "Real one", kind: "every", everyMs: 600_000, enabled: true, nextRunAt: Date.now() - 1, runs: [] },
      { prompt: "", kind: "every", everyMs: 600_000, nextRunAt: 1, runs: [] },
      { id: "bogus", prompt: "Kind that does not exist", kind: "hourly", nextRunAt: 1, runs: [] },
      { id: "broken", prompt: "Interval gone bad", kind: "every", everyMs: 5, nextRunAt: 1, runs: [] },
    ]);
    const stored = await entries();
    expect(stored.map((entry) => entry.id)).toEqual(["ok", "broken"]);
    expect(stored.find((entry) => entry.id === "broken")?.enabled).toBe(false);
    expect((await claimDue(root, Date.now())).due.map((entry) => entry.id)).toEqual(["ok"]);
  });
});
