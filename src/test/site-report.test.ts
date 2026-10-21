// @vitest-environment node
// The reason the owner's console showed zero accounts is here: the page asked calvras.com to record a
// sign-in and the window reloaded before the answer came back. So this is tested against a real
// temporary file and a real Response, with only Google and the network stood in for — and the token is
// checked never to reach disk in plain text.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createSignInReport } = createRequire(import.meta.url)("../../electron/site-report.cjs") as {
  createSignInReport: (options: {
    fs: typeof fs;
    file: string;
    storage: { isEncryptionAvailable: () => boolean; encryptString: (value: string) => Buffer; decryptString: (bytes: Buffer) => string };
    fetchImpl: typeof fetch;
    siteOrigin?: string;
    getInfo?: () => { platform: string; version: string };
    wait?: (ms: number) => Promise<void>;
    now?: () => number;
  }) => { report: (idToken: string) => Promise<Record<string, unknown>>; replay: () => Promise<Record<string, unknown> | null> };
};

// A stand-in for safeStorage with the same shape: whatever it writes is not readable as text.
const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value, "utf8").toString("base64") as unknown as Buffer,
  decryptString: (bytes: Buffer) => Buffer.from(String(bytes), "base64").toString("utf8"),
};

let dir = "";
let file = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "calvras-signin-report-"));
  file = path.join(dir, "pending-signin.bin");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const noWaiting = async () => { /* the backoff itself is not what is under test */ };

/** Answers the site with whatever the scenario needs, and records every body it was given. */
function site(...answers: ({ status?: number; body?: unknown; throws?: boolean } | (() => { status?: number; body?: unknown; throws?: boolean }))[]) {
  const sent: { body: string; signal?: AbortSignal | null }[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const answer = answers[Math.min(sent.length, answers.length - 1)]!;
    sent.push({ body: String(init?.body ?? ""), signal: init?.signal ?? null });
    const next = typeof answer === "function" ? answer() : answer;
    if (next.throws) throw new Error("Failed to fetch");
    return Response.json(next.body ?? {}, { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

describe("the desktop shell reporting a sign-in to calvras.com", () => {
  it("sends the token the site needs and hands back what it said", async () => {
    const { sent, fetchImpl } = site({ body: { ok: true, email: "dev@calvras.com", plan: "pro", session: "sig.dev" } });
    const report = createSignInReport({
      fs, file, storage, fetchImpl, getInfo: () => ({ platform: "win32", version: "10.0.9" }), wait: noWaiting,
    });
    await expect(report.report("idt-fixture")).resolves.toEqual({ ok: true, email: "dev@calvras.com", plan: "pro", session: "sig.dev" });
    expect(JSON.parse(sent[0]!.body)).toEqual({ idToken: "idt-fixture", platform: "win32", version: "10.0.9" });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("keeps trying when the site is having a bad day", async () => {
    const { sent, fetchImpl } = site({ status: 503, body: { error: "Database is warming up" } }, { body: { ok: true, email: "dev@calvras.com" } });
    const report = createSignInReport({ fs, file, storage, fetchImpl, wait: noWaiting });
    await expect(report.report("idt-fixture")).resolves.toMatchObject({ ok: true, email: "dev@calvras.com" });
    expect(sent).toHaveLength(2);
  });

  it("treats a rejected token as final and asks Google for nothing more", async () => {
    const { sent, fetchImpl } = site({ status: 401, body: { error: "That is not a Google ID token." } });
    const report = createSignInReport({ fs, file, storage, fetchImpl, wait: noWaiting });
    await expect(report.report("idt-fixture")).resolves.toMatchObject({ ok: false, error: "That is not a Google ID token." });
    expect(sent).toHaveLength(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("keeps an unconfirmed sign-in for the next launch, and replays it once the site answers", async () => {
    const offline = site({ throws: true });
    const first = createSignInReport({ fs, file, storage, fetchImpl: offline.fetchImpl, wait: noWaiting });
    await expect(first.report("idt-fixture")).resolves.toMatchObject({ ok: false, error: "Failed to fetch" });
    expect(offline.sent).toHaveLength(4);
    expect(fs.readFileSync(file, "utf8")).not.toContain("idt-fixture");

    // The shell starts again. The token it could not deliver is still good, so it goes up on its own.
    const back = site({ body: { ok: true, email: "dev@calvras.com", plan: "free" } });
    const second = createSignInReport({ fs, file, storage, fetchImpl: back.fetchImpl, wait: noWaiting });
    await expect(second.replay()).resolves.toMatchObject({ ok: true, email: "dev@calvras.com" });
    expect(JSON.parse(back.sent[0]!.body).idToken).toBe("idt-fixture");
    expect(fs.existsSync(file)).toBe(false);
    await expect(second.replay()).resolves.toBeNull();
  });

  it("drops a kept sign-in once Google stops trusting the token", async () => {
    let clock = 1_000;
    const unreachable = site({ throws: true });
    const first = createSignInReport({ fs, file, storage, fetchImpl: unreachable.fetchImpl, wait: noWaiting, now: () => clock });
    await first.report("idt-fixture");
    expect(fs.existsSync(file)).toBe(true);

    clock += 51 * 60 * 1000;
    const online = site({ body: { ok: true } });
    const next = createSignInReport({ fs, file, storage, fetchImpl: online.fetchImpl, wait: noWaiting, now: () => clock });
    await expect(next.replay()).resolves.toBeNull();
    expect(online.sent).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("writes nothing to disk on a machine that cannot keep secrets", async () => {
    const { fetchImpl } = site({ throws: true });
    const report = createSignInReport({
      fs, file, storage: { ...storage, isEncryptionAvailable: () => false }, fetchImpl, wait: noWaiting,
    });
    await expect(report.report("idt-fixture")).resolves.toMatchObject({ ok: false });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("says so when Google handed back no token at all", async () => {
    const { sent, fetchImpl } = site({ body: { ok: true } });
    const report = createSignInReport({ fs, file, storage, fetchImpl, wait: noWaiting });
    await expect(report.report("")).resolves.toEqual({ ok: false, error: "Google did not hand back an identity token." });
    expect(sent).toHaveLength(0);
  });
});
