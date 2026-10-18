import { useEffect, useState } from "react";
import { AlertCircle, CalendarClock, CheckCircle2, Circle, FileDiff, FolderGit2, GitBranch, ListTodo, Loader2, Pause, Play, RefreshCw, ShieldCheck, Trash2, Users, X } from "lucide-react";
import AgentAvatar from "@/components/ui/agent-avatar";
import type { AccessMode, ToolAction } from "@/lib/tool-catalog";
import { ACCESS_MODES } from "@/lib/tool-catalog";
import { safePreviewUrl } from "@/lib/preview-url";

export type TaskStep = { id: string; label: string; detail?: string; status: "running" | "completed" | "failed" | string };

/** What .calvras/schedule.json looks like from the browser: the run itself plus the outcome of
 * the last time it fired. */
export type ScheduledRunView = {
  id: string;
  prompt: string;
  kind: "at" | "every" | "daily" | string;
  at?: number | undefined;
  everyMs?: number | undefined;
  timeOfDay?: string | undefined;
  mode: string;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt?: number | undefined;
  lastStatus?: string | undefined;
  lastNote?: string | undefined;
};

type Props = {
  projectPath: string | null;
  projectName: string | null;
  accessMode: AccessMode;
  tasks: any[];
  agents: any[];
  steps: TaskStep[];
  previewUrl?: string;
  scheduled?: ScheduledRunView[];
  routing?: Record<string, { profile?: string | undefined; model?: string | undefined } | undefined>;
  onScheduleChange?: (id: string, action: "pause" | "resume" | "cancel") => Promise<void>;
  execute: (action: ToolAction) => Promise<any>;
  onClose: () => void;
};

const statusIcon = (status: string) => {
  if (status === "running") return <Loader2 className="size-3.5 animate-spin text-amber-300" />;
  if (status === "failed") return <AlertCircle className="size-3.5 text-red-300" />;
  if (status === "completed") return <CheckCircle2 className="size-3.5 text-emerald-300" />;
  return <Circle className="size-3.5 text-white/25" />;
};

const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dayAndTime = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The entry's own numbers, said back: a schedule is only trustworthy if the panel shows what
 * was really stored rather than a restatement of the request. */
function describeSchedule(run: ScheduledRunView): string {
  if (run.kind === "every") {
    const minutes = Math.round(Number(run.everyMs || 0) / 60_000);
    if (minutes >= 1440 && minutes % 1440 === 0) return `Every ${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`;
    if (minutes >= 60 && minutes % 60 === 0) return `Every ${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
    return `Every ${minutes || "?"} minutes`;
  }
  if (run.kind === "daily") return `Every day at ${run.timeOfDay || "?"}`;
  return `Once, at ${typeof run.at === "number" ? dayAndTime(run.at) : "an unknown time"}`;
}

function nextRunLabel(run: ScheduledRunView, now: number): string {
  if (!run.enabled) return "Paused";
  if (run.kind === "at" && run.nextRunAt <= now) return "Overdue";
  const hours = (run.nextRunAt - now) / 3_600_000;
  if (hours < 1) return `In ${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 24) return `In ${Math.round(hours)} hours`;
  return dayAndTime(run.nextRunAt);
}

/** The engine the live session runs this role on, straight from its routing table. An empty
 * string means the session has not reported one, so the row shows nothing rather than a guess. */
function engineNote(routing: Props["routing"], role: string) {
  const entry = routing ? routing[role] : undefined;
  return [entry?.profile, entry?.model].filter(Boolean).join(" · ");
}

export function TasksPanel({ projectPath, projectName, accessMode, tasks, agents, steps, previewUrl, scheduled, routing, onScheduleChange, execute, onClose }: Props) {
  const [branch, setBranch] = useState("");
  const [changes, setChanges] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busySchedule, setBusySchedule] = useState("");
  const [scheduleError, setScheduleError] = useState("");
  const now = Date.now();

  const change = async (run: ScheduledRunView, action: "pause" | "resume" | "cancel") => {
    if (!onScheduleChange) return;
    setBusySchedule(run.id); setScheduleError("");
    try { await onScheduleChange(run.id, action); }
    catch (error) { setScheduleError(error instanceof Error ? error.message : "That scheduled run is still stored as it was."); }
    finally { setBusySchedule(""); }
  };

  const refresh = async () => {
    if (!projectPath) return;
    setLoading(true);
    try {
      const [branchResult, statusResult] = await Promise.all([
        execute({ type: "git_branch" }),
        execute({ type: "git_status" }),
      ]);
      setBranch(branchResult?.ok === false ? "" : String(branchResult?.output || "").split("\n").find((line) => line.startsWith("*"))?.replace(/^\*\s*/, "") || "");
      const statusOutput = statusResult?.ok === false ? "" : String(statusResult?.output || "");
      setChanges(statusOutput.split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(0, 40));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setBranch("");
    setChanges([]);
    if (projectPath) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);

  const access = ACCESS_MODES.find((mode) => mode.value === accessMode);
  const workers = [
    { role: "builder", label: "Implementation" },
    { role: "verifier", label: "Verification" },
    { role: "researcher", label: "Research & review" },
  ];
  const preview = safePreviewUrl(previewUrl);

  return (
    <aside aria-label="Tasks" className="fixed right-3 top-[calc(var(--app-title-height,0px)+70px)] bottom-3 z-40 flex w-[min(390px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#161617] text-white animate-in slide-in-from-right-4 fade-in duration-300">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[14px] font-medium tracking-tight text-white/90"><ListTodo className="size-4 text-white/45" />Tasks</h2>
          <p className="mt-0.5 truncate text-[11px] text-white/40">{projectName || "No folder selected"}</p>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Refresh workspace details" title="Refresh" disabled={!projectPath || loading} onClick={() => void refresh()} className="rounded-lg p-1.5 text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/80 disabled:opacity-30">
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button type="button" aria-label="Close tasks" title="Close (Esc)" onClick={onClose} className="rounded-lg p-1.5 text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/80"><X className="size-4" /></button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" style={{ scrollbarWidth: "none" }}>
        <section aria-label="Environment" className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">Environment</h3>
          <div className="mt-3 space-y-2.5 text-[12px]">
            <div className="flex items-start gap-2.5"><FolderGit2 className="mt-0.5 size-3.5 shrink-0 text-white/35" /><div className="min-w-0"><p className="text-white/80">{projectName || "No folder yet"}</p><p className="mt-0.5 break-all text-[10px] leading-4 text-white/35">{projectPath || "Use the folder chip below the composer to add one."}</p></div></div>
            <div className="flex items-center gap-2.5"><GitBranch className="size-3.5 shrink-0 text-white/35" /><span className="text-white/65">{branch || (projectPath ? "No git branch" : "—")}</span></div>
            <div className="flex items-center gap-2.5"><FileDiff className="size-3.5 shrink-0 text-white/35" /><span className="text-white/65">{changes.length ? `${changes.length} changed ${changes.length === 1 ? "file" : "files"}` : "No local changes"}</span></div>
            <div className="flex items-center gap-2.5"><ShieldCheck className="size-3.5 shrink-0 text-white/35" /><span className="text-white/65">{access?.label || "Automatic"}</span></div>
            {preview && <div className="flex items-center gap-2.5"><span className="size-2 shrink-0 rounded-full bg-emerald-400" /><span className="truncate text-white/65">{preview}</span></div>}
          </div>
          {changes.length > 0 && (
            <div className="mt-3 space-y-1 border-t border-white/[0.06] pt-3 font-mono text-[10px] leading-5 text-white/45">
              {changes.slice(0, 8).map((line, index) => <p key={`${line}-${index}`} className="truncate">{line}</p>)}
              {changes.length > 8 && <p className="text-white/25">+{changes.length - 8} more</p>}
            </div>
          )}
        </section>

        <section aria-label="Current work" className="mt-6">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">Current work</h3>
          {tasks.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {tasks.map((task, index) => (
                <li key={task.id || index} className="flex items-start gap-2.5 rounded-lg px-2 py-2 text-[12px]">
                  {statusIcon(String(task.status || "pending"))}
                  <div className="min-w-0"><p className="text-white/80">{task.title || task.description || task.task || String(task)}</p><p className="mt-0.5 text-[10px] text-white/35">{task.status || "pending"}</p></div>
                </li>
              ))}
            </ul>
          ) : steps.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {steps.map((step) => (
                <li key={step.id} className="flex items-start gap-2.5 rounded-lg px-2 py-2 text-[12px]">
                  {statusIcon(step.status)}
                  <div className="min-w-0"><p className="text-white/80">{step.label}</p>{step.detail && <p className="mt-0.5 break-all text-[10px] leading-4 text-white/35">{step.detail}</p>}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 px-2 text-[12px] leading-5 text-white/35">Nothing is running right now. Ask Calvras for something and its steps show up here.</p>
          )}
        </section>

        <section aria-label="Scheduled work" className="mt-6">
          <h3 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35"><CalendarClock className="size-3" />Scheduled work</h3>
          {scheduled && scheduled.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {scheduled.map((run) => (
                <li key={run.id} className="rounded-lg px-2 py-2 text-[12px]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-white/80">{describeSchedule(run)} · {nextRunLabel(run, now)}</p>
                      <p className="mt-0.5 break-words text-[10px] leading-4 text-white/40">{run.prompt.slice(0, 160)}</p>
                      {run.lastStatus && run.lastRunAt && (
                        <p className="mt-1 break-words text-[10px] leading-4 text-white/35">
                          Last fired at {clockTime(run.lastRunAt)} · {run.lastStatus}
                          {run.lastNote ? ` — ${run.lastNote.slice(0, 160)}` : ""}
                        </p>
                      )}
                    </div>
                    {onScheduleChange && (
                      <div className="flex shrink-0 items-center gap-1">
                        <button type="button" aria-label={run.enabled ? `Pause ${describeSchedule(run)}` : `Resume ${describeSchedule(run)}`} title={run.enabled ? "Pause" : "Resume"} disabled={busySchedule === run.id} onClick={() => void change(run, run.enabled ? "pause" : "resume")} className="rounded-lg p-1.5 text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/80 disabled:opacity-30">
                          {run.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                        </button>
                        <button type="button" aria-label={`Cancel ${describeSchedule(run)}`} title="Cancel" disabled={busySchedule === run.id} onClick={() => void change(run, "cancel")} className="rounded-lg p-1.5 text-white/40 transition-colors hover:bg-white/[0.06] hover:text-red-300 disabled:opacity-30">
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 px-2 text-[12px] leading-5 text-white/35">Nothing is set to start on its own. Ask Calvras to run something later and it appears here, and it still fires after the app closes and reopens.</p>
          )}
          {scheduleError && <p className="mt-2 px-2 text-[11px] leading-4 text-red-300">{scheduleError}</p>}
        </section>

        <section aria-label="Working together" className="mt-6">
          <h3 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35"><Users className="size-3" />Working together</h3>
          <div className="mt-2 space-y-1">
            {workers.map(({ role, label }) => {
              const agent = agents.find((worker) => worker.role === role);
              const active = agent?.active;
              // A pool group has no status of its own; the newest job in it does. The pool's own
              // words are shown as they are and only mapped to an icon.
              const jobs = agent?.jobs || [];
              const raw = String(active ? "running" : jobs.at(-1)?.status || "available");
              const icon = raw === "finished" ? "completed" : raw === "blocked" || raw === "stopped" || raw === "limit" ? "failed" : raw === "queued" ? "available" : raw;
              // "limit" is the pool's own word for a worker that used up its step budget; spell out
              // which limit, since the bare token would read as an unexplained status.
              const shown = raw === "limit" ? "step limit" : raw;
              const engine = engineNote(routing, role);
              return (
                <div key={role} className="flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-[12px]">
                  <span className="flex min-w-0 items-center gap-2 text-white/70"><AgentAvatar seed={role} size={18} animated={Boolean(active)} aria-hidden="true" /><span className="truncate">{label}</span>{engine ? <span className="shrink-0 italic text-[10px] text-white/30">{engine}</span> : null}</span>
                  <span className="flex items-center gap-1.5 text-[10px] text-white/35">{statusIcon(icon)}{shown}{agent?.queued ? ` · ${agent.queued} queued` : ""}</span>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </aside>
  );
}
