import type { AccessMode } from "./tool-catalog";
import { DEFAULT_POLICIES, sanitizePolicies, type Policies, type ToolEffect, type UrlRule } from "./policy-rules";

export type { Policies, ToolEffect, UrlRule };
export { DEFAULT_POLICIES, sanitizePolicies };

export type Preferences = { accessMode: AccessMode; effort: "Quick" | "Balanced" | "Thorough"; palette: "graphite" | "midnight"; reduceMotion: boolean; completionSound: boolean; model: string; workerRouting: Record<WorkerRole, RoleRouting> };
export type WorkerRole = "builder" | "verifier" | "researcher";
export type Effort = "Quick" | "Balanced" | "Thorough";
/** One subagent role's engine: an effort level and, optionally, the model pinned to it. */
export type RoleRouting = { effort: Effort; model: string };
export const WORKER_ROLES: WorkerRole[] = ["builder", "verifier", "researcher"];
export const DEFAULT_ROLE_ROUTING: Record<WorkerRole, RoleRouting> = { builder: { effort: "Balanced", model: "" }, verifier: { effort: "Balanced", model: "" }, researcher: { effort: "Quick", model: "" } };

/** A stored blob is user-editable, so every role is read field by field with the default under it. */
export function sanitizeWorkerRouting(raw: unknown): Record<WorkerRole, RoleRouting> {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return Object.fromEntries(WORKER_ROLES.map((role) => {
    const entry = source[role];
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const effort = ["Quick", "Balanced", "Thorough"].includes(String(record["effort"])) ? record["effort"] as Effort : DEFAULT_ROLE_ROUTING[role].effort;
    const model = typeof record["model"] === "string" ? record["model"].trim().slice(0, 120) : "";
    return [role, { effort, model }];
  })) as Record<WorkerRole, RoleRouting>;
}

export const DEFAULT_PREFERENCES: Preferences = { accessMode: "automatic", effort: "Balanced", palette: "graphite", reduceMotion: false, completionSound: true, model: "", workerRouting: DEFAULT_ROLE_ROUTING };

export function readPreferences(): Preferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    const stored = JSON.parse(window.localStorage.getItem("calvras_preferences") || "{}");
    const accessMode = window.localStorage.getItem("calvras_access_mode") || stored.accessMode;
    return { accessMode: ["ask", "automatic", "full"].includes(accessMode) ? accessMode : "automatic", effort: ["Quick", "Balanced", "Thorough"].includes(stored.effort) ? stored.effort : "Balanced", palette: stored.palette === "midnight" ? "midnight" : "graphite", reduceMotion: stored.reduceMotion === true, completionSound: stored.completionSound !== false, model: typeof stored.model === "string" ? stored.model.slice(0, 120) : "", workerRouting: sanitizeWorkerRouting(stored.workerRouting) };
  } catch { return DEFAULT_PREFERENCES; }
}
export function applyPreferences(preferences: Preferences) {
  document.documentElement.dataset["palette"] = preferences.palette;
  document.documentElement.dataset["reduceMotion"] = String(preferences.reduceMotion);
}
export function savePreferences(preferences: Preferences) {
  window.localStorage.setItem("calvras_preferences", JSON.stringify(preferences));
  window.localStorage.setItem("calvras_access_mode", preferences.accessMode);
  applyPreferences(preferences);
  window.dispatchEvent(new CustomEvent("calvras:preferences", { detail: preferences }));
}

/** The subset of policies a single project may override. */
export type ProjectOverrides = { securityPreset?: AccessMode | undefined; planReview?: "ask" | "proceed" | undefined; queuedDelivery?: "queue" | "immediate" | undefined };

export function readPolicies(): Policies {
  if (typeof window === "undefined") return DEFAULT_POLICIES;
  try {
    const stored = JSON.parse(window.localStorage.getItem("calvras_policies") || "{}");
    // The preset is mirrored into its own key so a stale preferences blob can never
    // outrank what the user last chose in Settings.
    const accessMode = window.localStorage.getItem("calvras_access_mode");
    const policies = sanitizePolicies(stored);
    return ["ask", "automatic", "full"].includes(String(accessMode)) ? { ...policies, securityPreset: accessMode as AccessMode } : policies;
  } catch { return DEFAULT_POLICIES; }
}

export function savePolicies(policies: Policies) {
  const clean = sanitizePolicies(policies);
  window.localStorage.setItem("calvras_policies", JSON.stringify(clean));
  window.localStorage.setItem("calvras_access_mode", clean.securityPreset);
  const preferences = readPreferences();
  if (preferences.accessMode !== clean.securityPreset) savePreferences({ ...preferences, accessMode: clean.securityPreset });
  window.dispatchEvent(new CustomEvent("calvras:policies", { detail: clean }));
}

export function readProjectPolicies(): Record<string, ProjectOverrides> {
  if (typeof window === "undefined") return {};
  try {
    const stored = JSON.parse(window.localStorage.getItem("calvras_project_policies") || "{}");
    return stored && typeof stored === "object" ? stored : {};
  } catch { return {}; }
}

export function saveProjectPolicy(projectPath: string, patch: ProjectOverrides) {
  const all = readProjectPolicies();
  const merged = { ...(all[projectPath] || {}), ...patch };
  for (const key of Object.keys(merged) as (keyof ProjectOverrides)[]) if (merged[key] === undefined) delete merged[key];
  if (Object.keys(merged).length) all[projectPath] = merged; else delete all[projectPath];
  window.localStorage.setItem("calvras_project_policies", JSON.stringify(all));
  window.dispatchEvent(new CustomEvent("calvras:policies", { detail: readPolicies() }));
  return all;
}

/** What the runtime should actually enforce for this conversation, after the folder's own overrides. */
export function effectivePolicies(projectPath?: string | null): Policies {
  const base = readPolicies();
  const override = projectPath ? readProjectPolicies()[projectPath] : undefined;
  if (!override) return base;
  return { ...base, ...(override.securityPreset ? { securityPreset: override.securityPreset } : {}), ...(override.planReview ? { planReview: override.planReview } : {}), ...(override.queuedDelivery ? { queuedDelivery: override.queuedDelivery } : {}) };
}
