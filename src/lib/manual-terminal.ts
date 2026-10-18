import * as fs from "node:fs";
import * as path from "node:path";
import { runCommand } from "./command-runner";

const MAX_COMMAND_LENGTH = 20_000;

/**
 * A terminal the user drives directly. Unlike agent tools, the command is typed
 * by the person using the app, so it runs without agent approval prompts.
 */
export async function runManualTerminal(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ ok: false, error: "Terminal commands must come from this app." }, { status: 403 });
  }
  try {
    const body = await request.json();
    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!command) throw new Error("Enter a command.");
    if (command.length > MAX_COMMAND_LENGTH) throw new Error("Commands are limited to 20,000 characters.");
    const projectPath = typeof body.projectPath === "string" ? body.projectPath.trim() : "";
    if (!projectPath) throw new Error("Choose a project folder first.");
    const root = fs.realpathSync(path.resolve(projectPath));
    if (!fs.statSync(root).isDirectory()) throw new Error("Choose a project folder first.");
    if (root === path.parse(root).root) throw new Error("Choose a project folder, not an entire drive.");
    const relative = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : ".";
    const cwd = path.resolve(root, relative);
    if (cwd !== root && !cwd.startsWith(root + path.sep)) throw new Error("The working directory must stay inside this folder.");
    if (!fs.statSync(cwd).isDirectory()) throw new Error("That folder no longer exists.");
    const timeoutMs = Math.max(1000, Math.min(Number(body.timeoutMs) || 120_000, 300_000));
    const result = await runCommand(command, cwd, { timeoutMs });
    return Response.json({ ...result, cwd: path.relative(root, cwd) || "." });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "The command could not run." }, { status: 400 });
  }
}
