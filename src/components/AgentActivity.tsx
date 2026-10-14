import { useEffect, useState } from "react";
import { ChevronDown, LoaderCircle, Terminal, FileText, AlertCircle } from "lucide-react";
import { MarkdownContent } from "@/components/ui/markdown-content";
import type { AgentPhase, TraceNode } from "@/components/ui/ai-agent-response";

function ToolActivity({ node }: { node: TraceNode }) {
  const failed = node.status === "failed" || (node.exitCode !== undefined && node.exitCode !== 0);
  const running = node.status === "running";
  return <details className="my-2 text-sm text-muted-foreground">
    <summary className="flex cursor-pointer items-center gap-2 rounded py-1 hover:text-foreground">
      {running ? <LoaderCircle size={14} className="animate-spin" /> : failed ? <AlertCircle size={14} className="text-red-400" /> : node.type === "terminal" ? <Terminal size={14} /> : <FileText size={14} />}
      <span>{node.type === "terminal" ? running ? "Running command" : failed ? "Command failed" : "Ran command" : `${node.primary}${failed ? " failed" : ""}`}</span><span className="min-w-0 flex-1 truncate opacity-70">{node.secondary}</span>
      {node.durationMs !== undefined && <span className="shrink-0 text-xs">{(node.durationMs / 1000).toFixed(1)}s</span>}<ChevronDown size={12} />
    </summary>
    <div className="mt-2 max-h-72 overflow-auto rounded-lg border bg-card p-3">
      {node.command && <pre className="mb-3 whitespace-pre-wrap break-all text-xs">$ {node.command}</pre>}
      {node.output !== undefined && <pre className="whitespace-pre-wrap break-words text-xs">{node.output}</pre>}
      {node.details?.map((detail, index) => <pre key={index} className="whitespace-pre-wrap break-words text-xs">{detail.text}</pre>)}
      {node.exitCode !== undefined && <p className="mt-3 text-xs">Exit code {node.exitCode}</p>}
    </div>
  </details>;
}

export function AgentActivity({ phases, done, startedAt, endedAt, status, error }: { phases: AgentPhase[]; done: boolean; startedAt?: number | undefined; endedAt?: number | undefined; status?: string | undefined; error?: string | undefined }) {
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(true);
  useEffect(() => { if (done) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [done]);
  const seconds = startedAt ? Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1000)) : undefined;
  const duration = seconds === undefined ? "" : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return <div className="w-full">
    <button onClick={() => setExpanded(!expanded)} className="mb-4 flex w-full items-center gap-2 border-b pb-3 text-left text-xs text-muted-foreground" aria-expanded={expanded}>
      {!done && <LoaderCircle size={13} className="animate-spin" />}{done ? "Worked" : "Working"}{duration && ` for ${duration}`}<ChevronDown size={13} className={expanded ? "rotate-180" : ""} />
    </button>
    {phases.map((phase, index) => {
      const tools = phase.trace.filter((node) => node.type !== "reasoning" && node.type !== "step");
      const final = done && index === phases.length - 1;
      return <div key={index}>
        {expanded && tools.map((node, nodeIndex) => <ToolActivity key={node.id || nodeIndex} node={node} />)}
        {(expanded || final) && phase.message && <div className="my-4 text-sm leading-7"><MarkdownContent content={phase.message} /></div>}
      </div>;
    })}
    {status && status !== "finished" && <div role="status" className="mt-4 rounded-lg border px-3 py-2 text-xs text-muted-foreground">
      <span className="capitalize">{status === "limit" ? "Action limit reached" : status}</span>
      {error && <details className="mt-2"><summary className="cursor-pointer">Error details</summary><pre className="mt-2 whitespace-pre-wrap break-words">{error}</pre></details>}
    </div>}
  </div>;
}
