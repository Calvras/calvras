import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * The terminal the person in the app types into. Unlike the agent's run_command, which starts a
 * process per call and returns when it exits, this is one long-lived shell per folder: `cd` sticks,
 * the environment carries over, and output reaches the screen while the command is still running,
 * so a dev server shows its logs the moment they are written instead of never.
 */
type Session = {
  id: string;
  root: string;
  child: ChildProcessWithoutNullStreams;
  transcript: string;
  readers: Set<(chunk: string) => void>;
  closed: boolean;
};

const sessions = new Map<string, Session>();
const MAX_SESSIONS = 4;
const MAX_TRANSCRIPT = 200_000;
const SESSION_HEADER = "x-calvras-terminal";

const isWindows = process.platform === "win32";

function rejectForeignOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ ok: false, error: "Terminal commands must come from this app." }, { status: 403 });
  }
  return null;
}

function resolveRoot(value: unknown): string {
  const projectPath = typeof value === "string" ? value.trim() : "";
  if (!projectPath) throw new Error("Choose a project folder first.");
  const root = fs.realpathSync(path.resolve(projectPath));
  if (!fs.statSync(root).isDirectory()) throw new Error("Choose a project folder first.");
  if (root === path.parse(root).root) throw new Error("Choose a project folder, not an entire drive.");
  return root;
}

/** The banner a real console prints before the first prompt, read from this machine rather than
 * written out here, so the version it names is the one actually installed. */
function windowsBanner(): Promise<string> {
  return new Promise((resolve) => {
    execFile("cmd.exe", ["/D", "/C", "ver"], { encoding: "buffer", timeout: 4000 }, (error, stdout) => {
      const version = error ? "" : String(stdout).trim();
      resolve(version ? `${version}\r\n(c) Microsoft Corporation. All rights reserved.\r\n\r\n` : "");
    });
  });
}

async function startSession(root: string): Promise<Session> {
  for (const [, existing] of sessions) {
    if (existing.root !== root) continue;
    if (!existing.closed) return existing;
    sessions.delete(existing.id);
  }
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.values().next().value as Session | undefined;
    if (oldest) closeSession(oldest.id);
  }
  const child = (isWindows
    ? spawn("cmd.exe", ["/K"], { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PROMPT: "$P$G" } })
    : spawn(process.env["SHELL"] || "/bin/bash", ["-i"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })) as ChildProcessWithoutNullStreams;

  const session: Session = { id: randomUUID(), root, child, transcript: "", readers: new Set(), closed: false };
  sessions.set(session.id, session);
  child.stdin.setDefaultEncoding("utf8");

  const publish = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    session.transcript = (session.transcript + text).slice(-MAX_TRANSCRIPT);
    for (const reader of session.readers) reader(text);
  };
  child.stdout.on("data", publish);
  child.stderr.on("data", publish);
  child.on("error", (error) => publish(Buffer.from(`${error.message}\r\n`)));
  child.on("exit", () => {
    session.closed = true;
    publish(Buffer.from("\r\nThe shell exited. Open the terminal again for a fresh one.\r\n"));
    sessions.delete(session.id);
    for (const reader of session.readers) reader("");
  });

  if (isWindows) {
    const banner = await windowsBanner();
    publish(Buffer.from(banner));
  } else {
    child.stdin.write(`pwd\r\n`);
  }
  return session;
}

function closeSession(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  session.closed = true;
  session.child.kill();
}

/** Open (or rejoin) the folder's shell and stream everything it writes for as long as we are asked. */
export async function openTerminalSession(request: Request): Promise<Response> {
  const denied = rejectForeignOrigin(request);
  if (denied) return denied;
  let session: Session;
  try {
    session = await startSession(resolveRoot((await request.json().catch(() => ({}))).projectPath));
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "The terminal could not start." }, { status: 400 });
  }

  const cancelled = new AbortController();
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(session.transcript));
      const reader = (chunk: string) => { if (chunk) controller.enqueue(encoder.encode(chunk)); };
      session.readers.add(reader);
      cancelled.signal.addEventListener("abort", () => { session.readers.delete(reader); });
    },
    cancel() { cancelled.abort(); },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      [SESSION_HEADER]: session.id,
    },
  });
}

export async function writeTerminalSession(request: Request): Promise<Response> {
  const denied = rejectForeignOrigin(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  const session = sessions.get(String(body.sessionId || ""));
  if (!session || session.closed) return Response.json({ ok: false, error: "That terminal is no longer running." }, { status: 404 });
  const data = typeof body.data === "string" ? body.data : "";
  if (data) session.child.stdin.write(data);
  return Response.json({ ok: true });
}

export async function closeTerminalSession(request: Request): Promise<Response> {
  const denied = rejectForeignOrigin(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  closeSession(String(body.sessionId || ""));
  return Response.json({ ok: true });
}

process.on("exit", () => { for (const id of [...sessions.keys()]) closeSession(id); });
