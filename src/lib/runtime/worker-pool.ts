import { randomUUID } from "node:crypto";
import { runAgent, type AgentAction, type ToolFeedback } from "../agent-run";
import { profileFrom, type InferenceRoute } from "../inference";

export const WORKER_ROLES = ["builder", "verifier", "researcher"] as const;
export type WorkerRole = typeof WORKER_ROLES[number];
/** Which engine and how much thinking one worker is inferred on. */
export type WorkerRoute = InferenceRoute;
export type WorkerRouting = Record<WorkerRole, WorkerRoute>;
/** Research reads and reports, so it runs on the fast chain; the roles that change files and
 * judge whether they work keep the balanced chain unless the user says otherwise. */
export const DEFAULT_WORKER_ROUTING: WorkerRouting = { builder: { profile: "balanced" }, verifier: { profile: "balanced" }, researcher: { profile: "quick" } };
/** Anything the browser sends is re-read here: an unknown role or effort cannot reach inference. */
export function sanitizeRouting(raw: unknown): WorkerRouting {
  const routing: WorkerRouting = { builder: { ...DEFAULT_WORKER_ROUTING.builder }, verifier: { ...DEFAULT_WORKER_ROUTING.verifier }, researcher: { ...DEFAULT_WORKER_ROUTING.researcher } };
  if (!raw || typeof raw !== "object") return routing;
  for (const role of WORKER_ROLES) {
    const entry = (raw as Record<string, unknown>)[role];
    if (!entry || typeof entry !== "object") continue;
    const profile = profileFrom((entry as Record<string, unknown>)["profile"] ?? (entry as Record<string, unknown>)["effort"]);
    const model = (entry as Record<string, unknown>)["model"];
    if (profile) routing[role].profile = profile;
    if (typeof model === "string" && model.trim()) routing[role].model = model.trim().slice(0, 120);
  }
  return routing;
}
export function mergeRoute(...routes: (WorkerRoute | undefined)[]): WorkerRoute {
  const merged: WorkerRoute = {};
  for (const route of routes) {
    if (route?.profile) merged.profile = route.profile;
    if (route?.model) merged.model = route.model;
  }
  return merged;
}
export type WorkerJob = { id: string; role: WorkerRole; task: string; status: "queued" | "running" | "finished" | "blocked" | "stopped" | "limit"; updates: string[]; outcome?: unknown; startedAt?: number; endedAt?: number; isolate?: boolean; route?: WorkerRoute | undefined; worktree?: { branch: string; path: string; files?: number | undefined; error?: string | undefined } };
type DelegateOptions = { isolate?: boolean; route?: WorkerRoute };
/**
 * Tools a worker may not run, each with the sentence it gets back as that tool's own result.
 * Hiring is a worker's no because it was already hired; appointments are a no because a worker
 * that scheduled itself would start work nobody asked for once the user had moved on; rebuilding
 * the module cards is a no because they describe the folder every worker shares, so one writer
 * keeps the ledger consistent while the rest read it.
 */
const WORKER_REFUSALS: Record<string, string> = {
  delegate_task: "Subagents cannot create more subagents. Do this part yourself.",
  ask_subagent: "Subagents cannot create more subagents. Do this part yourself.",
  schedule_run: "Only the main agent schedules work to start later. Report what should be scheduled and let it decide.",
  cancel_scheduled: "Only the main agent schedules work to start later. Report what should be scheduled and let it decide.",
  build_knowledge: "Only the main agent rebuilds the module cards. Read them with search_knowledge or read_module, and say in your report if they look stale.",
};
export class WorkerPool {
  private jobs = new Map<string, WorkerJob>();
  private controllers = new Map<string, AbortController>();
  private queues = new Map<WorkerRole, string[]>(WORKER_ROLES.map((role) => [role, []]));
  private active = new Set<WorkerRole>();
  constructor(private callbacks: {
    infer: (prompt: string, onDelta?: (text: string) => void, role?: WorkerRole, route?: WorkerRoute) => Promise<string>;
    execute: (action: AgentAction, signal: AbortSignal, workerId: string) => Promise<any>;
    onChange?: () => void;
    /** Give this job its own checkout of the project. Fills in job.worktree or throws. */
    isolate?: (job: WorkerJob) => Promise<void>;
    /** Count what the isolated job changed, once its run is over. */
    settle?: (job: WorkerJob) => Promise<void>;
  }) {}
  delegate(role: WorkerRole, task: string, options: DelegateOptions = {}) {
    if (!WORKER_ROLES.includes(role)) throw new Error("Choose builder, verifier, or researcher.");
    if (!task?.trim()) throw new Error("A concrete subagent task is required.");
    const job: WorkerJob = { id: randomUUID(), role, task, status: "queued", updates: [], ...(options.isolate ? { isolate: true } : {}), ...(options.route?.profile || options.route?.model ? { route: { ...options.route } } : {}) };
    this.jobs.set(job.id, job); this.queues.get(role)!.push(job.id); void this.drain(role); this.callbacks.onChange?.();
    return job;
  }
  private async drain(role: WorkerRole) {
    if (this.active.has(role)) return;
    this.active.add(role);
    try {
      let id: string | undefined;
      while ((id = this.queues.get(role)!.shift())) {
        const job = this.jobs.get(id)!;
        if (job.status === "stopped") continue;
        const controller = new AbortController(); this.controllers.set(id, controller);
        job.status = "running"; job.startedAt = Date.now();
        const update = (message: string) => { if (message.trim()) job.updates = [...job.updates.slice(-19), message.slice(0, 2000)]; this.callbacks.onChange?.(); };
        if (job.isolate) {
          // A folder with no git cannot be branched. Say so in the job's own log and carry on in
          // the shared workspace rather than failing a task the worker can still do.
          try { await this.callbacks.isolate?.(job); }
          catch (error) { const reason = error instanceof Error ? error.message : String(error); job.worktree = { branch: "", path: "", error: reason }; update(`Isolation unavailable: ${reason} Working in the shared folder instead.`); }
          this.callbacks.onChange?.();
        }
        let outcomeStatus: WorkerJob["status"] | undefined;
        try {
          // The role travels with every call so the worker is inferred on its own prompt: the
          // shared one advertises the delegation tools, and a worker that believes it gets stuck.
          const inferForRole = (prompt: string, onDelta?: (text: string) => void) => this.callbacks.infer(prompt, onDelta, role, job.route);
          const isolation = job.worktree?.branch ? ` You are working in your own checkout of the project at ${job.worktree.path} on branch ${job.worktree.branch}; nothing you write reaches the main folder until the user brings it back.` : "";
          const outcome = await runAgent({
            prompt: `[SUBAGENT ROLE] ${role}. Work only on this assigned task: ${job.task}. Do not delegate further.${isolation} ${role === "researcher" ? "Use read-only tools; return findings and references." : role === "verifier" ? "Inspect and run relevant checks; do not edit source without explicit instruction in the assigned task." : "Implement only the assigned changes and verify them."}`,
            signal: controller.signal, infer: inferForRole,
            requiresTools: /\b(?:implement|build|write|fix|edit|test|tests|check|inspect|read|search|review|verify)\b/i.test(job.task),
            execute: async (actions) => {
              const feedback: ToolFeedback[] = [];
              for (const action of actions) {
                const refusal = WORKER_REFUSALS[action.type];
                if (refusal) {
                  // A worker that tries one of these gets the refusal back as that tool's own
                  // result, so it can carry on with the task it was given instead of the job ending.
                  feedback.push({ action, ok: false, result: { ok: false, error: refusal } });
                  continue;
                }
                const result = await this.callbacks.execute(action, controller.signal, job.id);
                feedback.push({ action, ok: result.ok === true, result });
              }
              return feedback;
            }, onFeedback: update, onPhaseComplete: update, maxSteps: 12,
          });
          // Keep the loop's own reason. A worker that ran out of steps is not one that was blocked,
          // and the row the user reads is generated from this field.
          job.outcome = outcome; outcomeStatus = outcome.status === "finished" || outcome.status === "limit" ? outcome.status : outcome.status === "stopped" ? "stopped" : "blocked";
        } catch (error) { outcomeStatus = controller.signal.aborted ? "stopped" : "blocked"; job.outcome = { error: error instanceof Error ? error.message : String(error) }; }
        // The row the user reads must say how much the isolated worker really wrote, and that
        // figure comes from git in the checkout, not from anything the worker claimed. The status
        // is published only after it, so a finished row is never missing its file count.
        if (job.worktree?.branch) {
          try { await this.callbacks.settle?.(job); }
          catch (error) { job.worktree.error = error instanceof Error ? error.message : String(error); }
        }
        job.status = outcomeStatus!;
        job.endedAt = Date.now(); this.controllers.delete(id); this.callbacks.onChange?.();
      }
    } finally { this.active.delete(role); }
  }
  list() { return WORKER_ROLES.map((role) => ({ role, active: [...this.jobs.values()].find((job) => job.role === role && job.status === "running") ?? null, queued: this.queues.get(role)!.length, jobs: [...this.jobs.values()].filter((job) => job.role === role).slice(-10) })); }
  get(id: string) { const job = this.jobs.get(id); if (!job) throw new Error("Unknown subagent task."); return job; }
  async wait(id: string, ms = 10000) {
    const deadline = Date.now() + Math.min(Math.max(ms, 0), 20000);
    while (["queued", "running"].includes(this.get(id).status) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    return this.get(id);
  }
  cancel(id?: string) {
    for (const job of this.jobs.values()) if (!id || job.id === id) { this.controllers.get(job.id)?.abort(); if (job.status === "queued") job.status = "stopped"; }
    this.callbacks.onChange?.();
  }
}
