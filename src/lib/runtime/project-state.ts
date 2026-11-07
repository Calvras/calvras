import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

export type TaskItem = { id: string; title: string; status: "pending" | "running" | "done" | "blocked"; details?: string };
export type ProjectState = { memory: Record<string, string>; tasks: TaskItem[]; logs: { time: string; tool: string; ok: boolean; detail: string }[]; activeTask?: string; unfinished?: string };
const cache = new Map<string, ProjectState>();
const location = (root: string) => path.join(process.env["LOCALAPPDATA"] || path.join(os.homedir(), ".local", "share"), "Calvras", "projects", createHash("sha256").update(root).digest("hex"), "state.json");
export function projectState(root: string): ProjectState {
  let state = cache.get(root);
  if (!state) {
    try { state = JSON.parse(fs.readFileSync(location(root), "utf8")); } catch { /* First use. */ }
    if (!state || !Array.isArray(state.tasks) || typeof state.memory !== "object") state = { memory: {}, tasks: [], logs: [] };
    cache.set(root, state);
  }
  return state;
}
export function saveState(root: string) {
  const file = location(root); fs.mkdirSync(path.dirname(file), { recursive: true });
  const state = projectState(root); state.logs = state.logs.slice(-300);
  fs.writeFileSync(file + ".tmp", JSON.stringify(state, null, 2)); fs.renameSync(file + ".tmp", file);
}
export function recordOperation(root: string, tool: string, ok: boolean, detail: string) {
  projectState(root).logs.push({ time: new Date().toISOString(), tool, ok, detail: detail.replace(/(?:sk-[\w-]{15,}|AIza[\w-]+|Bearer\s+\S+)/g, "[redacted]").slice(0, 500) });
  saveState(root);
}
export function projectRules(root: string) {
  const file = path.join(root, "AGENTS.md");
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return "";
    return fs.readFileSync(file, "utf8").slice(0, 16000);
  } catch { return ""; }
}
