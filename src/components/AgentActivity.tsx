import { type ReactNode, useEffect, useState } from "react";
import { CheckCheck, ChevronRight, Copy, ThumbsDown, ThumbsUp } from "lucide-react";
import AgentAvatar from "@/components/ui/agent-avatar";
import { ThinkingState, formatElapsed, type AgentPhase, type TraceNode } from "@/components/ui/ai-agent-response";
import { MarkdownContent } from "@/components/ui/markdown-content";
import { cn } from "@/lib/utils";
export type ReplyRating = "up" | "down";
/** A subagent as the worker pool reports it. Every field here comes from the server's own
 *  job record, so a row can only exist for work that was really handed to a worker. */
export type SubagentJob = { id: string; role: string; task: string; status: string; startedAt?: number | undefined; endedAt?: number | undefined; updates?: string[] | undefined; result?: string | undefined; engine?: { profile?: string | undefined; model?: string | undefined } | undefined; worktree?: { branch?: string | undefined; path?: string | undefined; files?: number | undefined; error?: string | undefined } | undefined };
interface AgentActivityProps { phases: AgentPhase[]; done: boolean; startedAt?: number | undefined; endedAt?: number | undefined; status?: string | undefined; stopReason?: string | undefined; error?: string | undefined; rating?: ReplyRating | undefined; subagents?: SubagentJob[] | undefined; unfinished?: string[] | undefined; onUndo?: ((id: string) => Promise<void>) | undefined; onRate?: ((rating: ReplyRating | null) => void) | undefined; onResume?: (() => void) | undefined; onResolve?: ((id: string, choice: "apply" | "discard") => Promise<void>) | undefined }
function IconAction({ label, pressed, onClick, children }: { label: string; pressed?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed ?? false}
      title={label}
      onClick={onClick}
      className={cn(
        "flex size-6 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.92]",
        pressed ? "text-foreground" : "text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
/** Copy the reply, and mark it good or bad. Hidden until the turn is hovered, but a rating
 *  you already gave stays visible so the mark is not lost when the pointer leaves. */
function ReplyActions({ text, rating, onRate }: { text: string; rating?: ReplyRating | undefined; onRate?: ((rating: ReplyRating | null) => void) | undefined }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("flex items-center gap-0.5 pt-0.5 transition-opacity duration-150", rating ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100")}>
      <IconAction label={copied ? "Copied reply" : "Copy reply"} onClick={() => { void navigator.clipboard.writeText(text).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 2_000); }}>
        {copied ? <CheckCheck className="size-3.5 text-emerald-500" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      </IconAction>
      <IconAction label="Good reply" pressed={rating === "up"} onClick={() => onRate?.(rating === "up" ? null : "up")}>
        <ThumbsUp className={cn("size-3.5", rating === "up" && "text-emerald-500")} aria-hidden="true" />
      </IconAction>
      <IconAction label="Bad reply" pressed={rating === "down"} onClick={() => onRate?.(rating === "down" ? null : "down")}>
        <ThumbsDown className={cn("size-3.5", rating === "down" && "text-rose-500")} aria-hidden="true" />
      </IconAction>
    </div>
  );
}
function RestoreEdit({ id, undo }: { id: string; undo: (id: string) => Promise<void> }) {
  const [state, setState] = useState("idle"); const [error, setError] = useState("");
  return <div className="flex items-center gap-3 text-xs"><button disabled={state !== "idle"} className="text-muted-foreground underline underline-offset-4 disabled:opacity-40" onClick={async () => { setState("working"); try { await undo(id); setState("restored"); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setState("idle"); } }}>{state === "restored" ? "Changes undone" : state === "working" ? "Restoring…" : "Undo changes"}</button>{error && <span role="alert">{error}</span>}</div>;
}
function withAttachments(node: TraceNode, onUndo: AgentActivityProps["onUndo"]): TraceNode {
  if (!node.image && !(node.checkpointId && onUndo)) return node;
  const original = node.renderContent;
  return { ...node, renderContent: () => <>{original?.()}{node.image && <img src={node.image} alt="Browser screenshot" className="max-h-96 rounded-lg object-contain" />}{node.checkpointId && onUndo && <RestoreEdit id={node.checkpointId} undo={onUndo} />}</> };
}
function ContextDivider({ divider }: { divider: NonNullable<AgentPhase["divider"]> }) {
  const compressing = divider.state === "compressing";
  return (
    <div role="separator" aria-label={compressing ? "Compressing context" : "Context compressed"} className="flex items-center gap-3 py-1.5">
      <span aria-hidden="true" className="h-px flex-1 bg-border/60" />
      <span className={compressing ? "animate-pulse text-[11.5px] text-muted-foreground" : "text-[11.5px] text-muted-foreground/80"}>{compressing ? "Compressing…" : "Context compressed"}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border/60" />
    </div>
  );
}
/** An isolated worker's own checkout outlives its run, so the row that reported it is where the
 *  user decides what happens to that work. Nothing here is shown unless git reported the files. */
function WorkerIsolation({ job, resolve }: { job: SubagentJob; resolve?: ((id: string, choice: "apply" | "discard") => Promise<void>) | undefined }) {
  const [state, setState] = useState("idle"); const [error, setError] = useState("");
  const worktree = job.worktree;
  if (!worktree) return null;
  if (worktree.error) return <p className="text-[11.5px] leading-5 text-muted-foreground/80">{worktree.error}</p>;
  if (!worktree.branch) return null;
  const settled = job.status !== "running" && job.status !== "queued";
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
      <span>Own checkout on <span className="font-medium text-foreground/80">{worktree.branch}</span>{typeof worktree.files === "number" ? ` · ${worktree.files} ${worktree.files === 1 ? "file" : "files"} changed` : ""}</span>
      {resolve && settled && state === "idle" && (
        <>
          <button type="button" className="underline underline-offset-4 hover:text-foreground" onClick={async () => { setState("working"); try { await resolve(job.id, "apply"); setState("applied"); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setState("idle"); } }}>Bring it back</button>
          <button type="button" className="underline underline-offset-4 hover:text-foreground" onClick={async () => { setState("working"); try { await resolve(job.id, "discard"); setState("discarded"); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setState("idle"); } }}>Discard</button>
        </>
      )}
      {state === "working" && <span>Working…</span>}
      {state === "applied" && <span className="text-emerald-500">Changes brought back</span>}
      {state === "discarded" && <span>Checkout discarded</span>}
      {error && <span role="alert" className="text-rose-500">{error.slice(0, 200)}</span>}
    </div>
  );
}
/** The engine this worker was inferred on: the effort the user set for the role, plus whatever a
 * delegation pinned for that one job. Both come from the session's routing table, which is what
 * the inference call actually receives. */
function engineLabel(engine: SubagentJob["engine"]) {
  return [engine?.profile, engine?.model].filter(Boolean).join(" · ");
}
/** One row per subagent the pool actually ran for this turn. The elapsed figure is measured
 *  from the job's own start stamp, so a running row ticks up and a finished one stays honest. */
function SubagentRow({ job, now, live, resolve }: { job: SubagentJob; now: number; live: boolean; resolve?: ((id: string, choice: "apply" | "discard") => Promise<void>) | undefined }) {
  const [open, setOpen] = useState(false);
  const unfinished = job.status === "running" || job.status === "queued";
  const seconds = job.startedAt ? Math.max(1, Math.round(((job.endedAt ?? now) - job.startedAt) / 1000)) : 0;
  // The pool reports a worker that ran out of its step budget as "limit", which is a different
  // fact from "blocked", so the row says which of the two happened rather than blurring them.
  const outcomeWord = job.status === "limit" ? "stopped at its step limit" : job.status;
  const line = !job.startedAt
    ? "Queued"
    : unfinished
      ? `Subagent running for ${formatElapsed(seconds)}`
      : job.status === "finished"
        ? `Subagent finished in ${formatElapsed(seconds)}`
        : `Subagent ${outcomeWord} after ${formatElapsed(seconds)}`;
  const updates = (job.updates ?? []).slice(-6);
  const engine = engineLabel(job.engine);
  const expandable = updates.length > 0 || Boolean(job.result) || Boolean(job.worktree);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => expandable && setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`Subagent ${job.role}${engine ? ` on ${engine}` : ""}: ${job.task}`}
        className={cn("flex w-full items-center gap-2 text-left text-[12.5px] text-muted-foreground", expandable && "hover:text-foreground")}
      >
        <AgentAvatar seed={job.role} size={18} animated={unfinished && live} aria-hidden="true" />
        <span className="shrink-0 font-medium text-foreground/80">{job.role}</span>
        {engine ? <><span aria-hidden="true" className="shrink-0 opacity-40">·</span><span className="shrink-0 italic opacity-70">{engine}</span></> : null}
        <span aria-hidden="true" className="shrink-0 opacity-40">·</span>
        <span className="min-w-0 flex-1 truncate">{job.task}</span>
        <span aria-live={unfinished && live ? "polite" : undefined} className="shrink-0 tabular-nums opacity-70">{line}</span>
        {expandable && <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} aria-hidden="true" />}
      </button>
      {open && (
        <div className="ml-5 flex flex-col gap-1 border-l border-border/50 pl-3">
          {job.result && <p className="text-[12px] leading-5 text-foreground/85">{job.result.slice(0, 1500)}</p>}
          {updates.length > 0 && <ul className="flex flex-col gap-0.5">{updates.map((update, index) => (
            <li key={index} className="line-clamp-3 text-[11.5px] leading-5 text-muted-foreground/80">{update.slice(0, 400)}</li>
          ))}</ul>}
          <WorkerIsolation job={job} resolve={resolve} />
        </div>
      )}
    </div>
  );
}
/** One trace header per turn: Thinking → Thought for, Working → Worked for. */
export function AgentActivity({ phases, done, startedAt, endedAt, status, stopReason, error, rating, subagents, unfinished, onUndo, onRate, onResume, onResolve }: AgentActivityProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (done) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [done]);

  const groups: { phases: AgentPhase[]; divider?: NonNullable<AgentPhase["divider"]> }[] = [];
  for (const phase of phases) {
    if (phase.divider) { groups.push({ phases: [], divider: phase.divider }); continue; }
    const last = groups[groups.length - 1];
    if (last && !last.divider) last.phases.push(phase); else groups.push({ phases: [phase] });
  }

  const allMessages = groups.flatMap((group) => group.phases.map((phase) => phase.message?.trim() || "")).filter(Boolean);
  const replyText = allMessages.at(-1) ?? "";
  const failure = error && !allMessages.some((message) => message.includes(error)) ? error : undefined;
  // A run that never reached a tool and recorded no open steps has no task to pick back up: it
  // answered a question. Offering resume there made the app send its own "pick it up" brief at a
  // list of programming languages and print the whole thing a second time. Same test the header
  // uses to decide between Thinking and Working.
  const didWork = phases.some((phase) => (phase.trace || []).some((node) => node.type !== "reasoning"));
  const stoppedShort = done && (status === "stopped" || status === "limit" || (status === "blocked" && Boolean(unfinished?.length))) && (didWork || Boolean(unfinished?.length));
  if (done && !groups.length && !failure && !subagents?.length && !stoppedShort) return null;

  return <div className="group flex w-full flex-col gap-4">
    {!done && !groups.length && <ThinkingState nodes={[]} autoPlay={false} running kind="thinking" measuredSeconds={Math.max(1, Math.round((now - (startedAt ?? now)) / 1000))} />}
    {groups.map((group, groupIndex) => {
      if (group.divider) return <ContextDivider key={`divider-${groupIndex}`} divider={group.divider} />;
      const live = !done && groupIndex === groups.length - 1;
      // Reasoning rows are the Thought block; step rows are filtered because a step is
      // only credible when it comes from a real tool call, which always produces one.
      const trace = group.phases.flatMap((phase) => phase.trace.filter((node) => node.type !== "step")).map((node) => withAttachments(node, onUndo));
      const message = [...group.phases].reverse().find((phase) => phase.message?.trim())?.message?.trim() || "";
      const start = group.phases[0]?.startedAt ?? startedAt ?? now;
      const lastPhase = group.phases[group.phases.length - 1];
      const end = lastPhase?.endedAt ?? (live ? now : endedAt ?? start);
      const seconds = Math.max(1, Math.round((end - start) / 1000));
      // The header reports what this turn has actually done: Thinking only until the first
      // real tool call, Working from then on — composing the next step mid-task is work too.
      const isToolRow = (node: TraceNode) => node.type !== "reasoning";
      const kind: "thinking" | "working" = trace.some(isToolRow) ? "working" : "thinking";
      return (
        <div key={groupIndex} className="flex flex-col gap-1">
          <ThinkingState nodes={trace} autoPlay={false} running={live} measuredSeconds={seconds} kind={kind} workingLabel="Working…" />
          {message && <MarkdownContent content={message} className="text-[14.5px] leading-[1.7] text-foreground" />}
        </div>
      );
    })}
    {subagents?.length ? (
      <div className="flex flex-col gap-1.5">
        {subagents.map((job) => <SubagentRow key={job.id} job={job} now={now} live={!done} resolve={onResolve} />)}
      </div>
    ) : null}
    {done && replyText && <ReplyActions text={replyText} rating={rating} onRate={onRate} />}
    {failure && <p role="alert" className="text-[13px] leading-6 text-amber-200/80">{failure}</p>}
    {/* A run that stopped short names what it never reached and offers to carry on from there,
        so a long task resumes from its own plan instead of being started over. */}
    {done && !failure && stoppedShort && <div className="flex flex-col gap-2">
      <p className="text-[13px] leading-6 text-muted-foreground">{status === "limit" ? "The run hit its action ceiling with work still outstanding." : status === "blocked" ? "It stopped with these steps still open:" : stopReason === "replaced" ? "You sent another message, so this one stopped where it stood. Anything already written is still in the project." : stopReason === "user" ? "You stopped this one. Anything already written is still in the project." : "This turn ended on its own with the work unfinished — nothing after the last step above was written."}</p>
      {unfinished?.length ? <ul className="flex flex-col gap-1 border-l border-border/60 pl-3">{unfinished.map((step, stepIndex) => <li key={stepIndex} className="text-[12.5px] leading-5 text-foreground/80">{step}</li>)}</ul> : null}
      {onResume && <button onClick={onResume} style={{ background: "#f5f0e8", color: "#1a1512" }} className="w-fit rounded-lg px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-90">Pick it back up</button>}
    </div>}
  </div>;
}
