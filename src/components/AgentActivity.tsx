import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { MarkdownContent } from "@/components/ui/markdown-content";
import type { AgentPhase } from "@/components/ui/ai-agent-response";
import { ResponseActionsToolbar, TracePillRow, PixelDotsLoader } from "@/components/ui/ai-agent-response";

export function AgentActivity({ phases, done, startedAt, endedAt, status, error }: { phases: AgentPhase[]; done: boolean; startedAt?: number | undefined; endedAt?: number | undefined; status?: string | undefined; error?: string | undefined }) {
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(!done);
  useEffect(() => { if (done) setExpanded(false); }, [done]);
  useEffect(() => { if (done) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [done]);
  const seconds = startedAt ? Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1000)) : undefined;
  const duration = seconds === undefined ? "" : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const toolNodes = phases.flatMap((phase) => phase.trace).filter((node) => node.type === "tool" || node.type === "terminal");
  const hasWork = toolNodes.length > 0;
  const hasSuccessfulWork = toolNodes.some((node) => node.status === "completed" || (node.status !== "failed" && node.status !== "running" && node.exitCode === 0));
  return <div className="w-full">
    {hasWork && <button onClick={() => setExpanded(!expanded)} className="mb-3 flex w-fit items-center gap-1.5 rounded-sm bg-transparent p-0 text-left text-[13.5px] font-normal text-muted-foreground/75 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={expanded}>
      {!done && <PixelDotsLoader />}{done ? hasSuccessfulWork ? "Worked" : "Activity" : "Working"}{duration && (!done || hasSuccessfulWork) && ` for ${duration}`}<ChevronDown size={13} className={expanded ? "rotate-180" : ""} />
    </button>}
    {!done && !hasWork && <span role="status" aria-label="Waiting for response" className="mb-3 inline-flex"><PixelDotsLoader /></span>}
    {phases.map((phase, index) => {
      const tools = phase.trace.filter((node) => node.type !== "reasoning" && node.type !== "step");
      return <div key={index}>
        {expanded && tools.length > 0 && <div className="mb-3 ml-2 flex flex-col gap-0.5 border-l border-border/60 py-0.5 pl-2"><div className="min-w-0">{tools.map((node, nodeIndex) => <TracePillRow key={node.id || nodeIndex} node={node} isActive={node.status === "running"} isFinished={node.status === "completed" || node.status === "failed"} />)}</div></div>}
        {phase.message && <div className="group/reply my-3 font-sans text-[14.5px] leading-relaxed text-foreground/90 select-text text-pretty"><MarkdownContent content={phase.message} />
          {done && <ResponseActionsToolbar text={phase.message} className="mt-2 opacity-0 transition-opacity group-hover/reply:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100" />}
        </div>}
      </div>;
    })}
    {status && status !== "finished" && <div role="status" className="mt-4 rounded-lg border px-3 py-2 text-xs text-muted-foreground">
      <span className="capitalize">{status === "limit" ? "Action limit reached" : status}</span>
      {error && <details className="mt-2"><summary className="cursor-pointer">Error details</summary><pre className="mt-2 whitespace-pre-wrap break-words">{error}</pre></details>}
    </div>}
  </div>;
}
