import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

type CommandResult = { ok: boolean; output: string; exitCode: number; pid?: number; url?: string; ready?: boolean; running?: boolean };
const servers = new Map<string, { child: ChildProcess; command: string; output: string; url?: string; exited: boolean }>();
/** App hosting configuration must not configure a user's child project. */
export function projectProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["PORT", "HOST", "NITRO_PRESET", "NODE_ENV", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "HUGGINGFACE_API_KEY", "HF_TOKEN"]) delete env[key];
  return env;
}
const spawnShell = (command: string, cwd: string) => process.platform === "win32"
  ? spawn(process.env["ComSpec"] || "cmd.exe", ["/d", "/s", "/c", `"${command}"`], { cwd, env: projectProcessEnv(), windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"] })
  : spawn("/bin/sh", ["-c", command], { cwd, env: projectProcessEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
function kill(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); } }
}

export function runCommand(command: string, cwd: string, options: { signal?: AbortSignal; onOutput?: (text: string) => void; timeoutMs?: number } = {}): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve) => {
    const child = spawnShell(command, cwd);
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer | string) => { const text = String(chunk); output = (output + text).slice(-64_000); options.onOutput?.(text); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const abort = () => kill(child);
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; append("\nCommand timed out.\n"); kill(child); }, options.timeoutMs ?? 60_000);
    const finish = (exitCode: number) => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      resolve({ ok: exitCode === 0 && !timedOut && !options.signal?.aborted, output, exitCode });
    };
    child.on("error", (error) => { append(error.message); finish(1); });
    child.on("close", (code) => finish(code ?? 1));
  });
}

export async function checkServer(cwd: string): Promise<CommandResult> {
  const server = servers.get(path.resolve(cwd));
  if (!server || server.exited) return { ok: false, ready: false, running: false, output: server?.output || "No managed server is running.", exitCode: 1 };
  let ready = false;
  if (server.url) {
    try {
      const response = await fetch(server.url, { signal: AbortSignal.timeout(1500), redirect: "manual" });
      ready = response.status < 400;
      await response.body?.cancel();
    } catch { /* Not listening yet. */ }
  }
  return { ok: true, ready, running: true, pid: server.child.pid!, ...(server.url ? { url: server.url } : {}), output: server.output, exitCode: 0 };
}

export async function startServer(command: string, cwd: string, options: { signal?: AbortSignal; onOutput?: (text: string) => void; waitMs?: number } = {}): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  const key = path.resolve(cwd);
  const existing = servers.get(key);
  if (existing && !existing.exited) return checkServer(cwd);
  const child = spawnShell(command, cwd);
  const server = { child, command, output: "", exited: false } as NonNullable<ReturnType<typeof servers.get>>;
  servers.set(key, server);
  const append = (chunk: Buffer | string) => {
    const text = String(chunk);
    server.output = (server.output + text).slice(-32_000);
    const clean = server.output.replace(/\x1b\[[0-9;]*m/g, "");
    const match = clean.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)(?:\/[^\s]*)?/);
    if (match) server.url = match[0].replace("0.0.0.0", "127.0.0.1");
    options.onOutput?.(text);
  };
  child.stdout?.on("data", append); child.stderr?.on("data", append);
  child.on("error", (error) => { server.exited = true; append(error.message); });
  child.on("exit", () => { server.exited = true; });
  const abort = () => kill(child);
  options.signal?.addEventListener("abort", abort, { once: true });
  const deadline = Date.now() + (options.waitMs ?? 8000);
  try {
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      if (server.exited) break;
      if (server.url) { const status = await checkServer(cwd); if (status.ready) return status; }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return checkServer(cwd);
  } finally { options.signal?.removeEventListener("abort", abort); }
}

export async function stopServers() {
  await Promise.all([...servers.values()].map((server) => new Promise<void>((resolve) => {
    if (server.exited) { resolve(); return; }
    const timer = setTimeout(resolve, 3000);
    server.child.once("close", () => { clearTimeout(timer); resolve(); });
    kill(server.child);
  })));
  servers.clear();
}

/** Stop only the server owned by this project, leaving other workspaces running. */
export async function stopServer(cwd: string): Promise<CommandResult> {
  const key = path.resolve(cwd);
  const server = servers.get(key);
  if (!server || server.exited) return { ok: true, running: false, output: 'No managed server is running.', exitCode: 0 };
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    server.child.once('close', () => { clearTimeout(timer); resolve(); });
    kill(server.child);
  });
  servers.delete(key);
  return { ok: true, running: false, output: server.output, exitCode: 0 };
}
