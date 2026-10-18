import { readPolicies } from "./preferences";

const KEY = "calvras_usage_log";
export type UsageEvent = { at: number; kind: string; detail?: string };

/** A local-only activity log. Nothing leaves this computer; the Account page can show
 * exactly what was recorded and clear it. */
export function recordUsage(kind: string, detail?: string): boolean {
  if (typeof window === "undefined" || !readPolicies().telemetry) return false;
  try {
    const log = readUsage();
    log.push({ at: Date.now(), kind, ...(detail ? { detail: detail.slice(0, 160) } : {}) });
    window.localStorage.setItem(KEY, JSON.stringify(log.slice(-500)));
    return true;
  } catch { return false; }
}

export function readUsage(): UsageEvent[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = JSON.parse(window.localStorage.getItem(KEY) || "[]");
    return Array.isArray(stored) ? stored.filter((item): item is UsageEvent => Boolean(item) && typeof item.kind === "string" && typeof item.at === "number") : [];
  } catch { return []; }
}

export function clearUsage() {
  try { window.localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}
