import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** The agent keeps a rolling operation log per project folder. Usage is read from those real
 * records rather than from a counter that would reset every time the window closes. */
export type UsageStats = {
  available: boolean;
  projects: number;
  toolCalls: number;
  failures: number;
  byTool: { tool: string; calls: number; failures: number }[];
  tasksDone: number;
  tasksOpen: number;
  firstAt: number;
  lastAt: number;
  capped: boolean;
};

const root = () => path.join(process.env["LOCALAPPDATA"] || path.join(os.homedir(), ".local", "share"), "Calvras", "projects");
const LOG_KEEP = 300;

export function usageStats(): UsageStats {
  const empty: UsageStats = { available: false, projects: 0, toolCalls: 0, failures: 0, byTool: [], tasksDone: 0, tasksOpen: 0, firstAt: 0, lastAt: 0, capped: false };
  let entries: string[];
  try { entries = fs.readdirSync(root(), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(root(), entry.name, "state.json")); }
  catch { return empty; }
  const totals = new Map<string, { calls: number; failures: number }>();
  const stats: UsageStats = { ...empty, available: true, byTool: [] };
  for (const file of entries) {
    let state: { logs?: unknown; tasks?: unknown };
    try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    stats.projects += 1;
    const logs = Array.isArray(state.logs) ? state.logs as { time?: string; tool?: string; ok?: boolean }[] : [];
    if (logs.length >= LOG_KEEP) stats.capped = true;
    for (const log of logs) {
      const tool = typeof log.tool === "string" && log.tool ? log.tool : "unknown";
      const row = totals.get(tool) || { calls: 0, failures: 0 };
      row.calls += 1;
      if (log.ok === false) row.failures += 1;
      totals.set(tool, row);
      stats.toolCalls += 1;
      if (log.ok === false) stats.failures += 1;
      const at = Date.parse(String(log.time || ""));
      if (Number.isFinite(at) && at > 0) {
        if (!stats.firstAt || at < stats.firstAt) stats.firstAt = at;
        if (at > stats.lastAt) stats.lastAt = at;
      }
    }
    const tasks = Array.isArray(state.tasks) ? state.tasks as { status?: string }[] : [];
    stats.tasksDone += tasks.filter((task) => task.status === "done").length;
    stats.tasksOpen += tasks.filter((task) => task.status === "pending" || task.status === "running" || task.status === "blocked").length;
  }
  stats.byTool = [...totals.entries()].map(([tool, row]) => ({ tool, calls: row.calls, failures: row.failures })).sort((a, b) => b.calls - a.calls).slice(0, 12);
  return stats;
}
