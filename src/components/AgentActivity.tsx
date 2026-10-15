import { AgentWorkflow } from "@/components/ui/ai-agent-response";
import type { AgentPhase } from "@/components/ui/ai-agent-response";

interface AgentActivityProps {
  phases: AgentPhase[];
  done: boolean;
  startedAt?: number;
  endedAt?: number;
  status?: string;
  error?: string;
}

/** Node types produced by internal planning that should not surface in the UI */
const FILTERED_NODE_TYPES = new Set(["reasoning", "step"]);

/**
 * AgentActivity — renders the live agent trace + streamed reply.
 *
 * Delegates entirely to AgentWorkflow from ai-agent-response.tsx:
 *  - While done=false:  autoPlay=true, elapsed timer ticks, spinner shows
 *  - When done=true:    isComplete=true → ThinkingState settles immediately,
 *                       elapsed time freezes, StreamingText plays word-by-word
 *  - No fake timers, no scripted phases, no demo data
 */
export function AgentActivity({ phases, done, startedAt, endedAt, status, error }: AgentActivityProps) {
  // Surface terminal error states as a final phase so they're always visible
  const finalPhases: AgentPhase[] = phases.map((p) => ({
    ...p,
    // Strip internal planning node types (reasoning, step) — they are never shown
    trace: p.trace.filter((n) => !FILTERED_NODE_TYPES.has(n.type)),
  }));

  if (done && error && !phases.some((p) => p.message?.includes(error))) {
    finalPhases.push({ trace: [], message: `⚠️ ${error}` });
  } else if (done && status && status !== "finished" && status !== "stopped" && !phases.some((p) => p.message)) {
    const label =
      status === "limit" ? "Action limit reached — the task may be incomplete."
      : status === "blocked" ? "Blocked — Calvras could not complete this task."
      : status;
    finalPhases.push({ trace: [], message: `⚠️ ${label}` });
  }

  if (finalPhases.length === 0) {
    // Nothing to render yet (very first frame before any phases are pushed)
    return null;
  }

  // Compute a fixed elapsed time from timestamps when the response is done.
  // This lets tests (and history renders) show accurate durations rather than
  // the component's own wall-clock timer which starts at mount time.
  const fixedElapsedSeconds =
    done && startedAt && endedAt
      ? Math.max(1, Math.round((endedAt - startedAt) / 1000))
      : undefined;

  return (
    <AgentWorkflow
      phases={finalPhases}
      isComplete={done}
      workingLabel="Working..."
      fixedElapsedSeconds={fixedElapsedSeconds}
    />
  );
}
