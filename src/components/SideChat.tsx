import { useCallback, useEffect, useRef, useState } from "react";
import { PencilRuler, MessageSquareText, Send, Sparkles, ThumbsUp, Timer, X } from "lucide-react";
import { callAI } from "@/lib/gemini";
import { MarkdownContent } from "@/components/ui/markdown-content";
import { cn } from "@/lib/utils";

type SideChatProps = {
  onClose: () => void;
  /** A live text snapshot of the main agent's progress, read fresh on every question. */
  getProgress: () => string;
  agentBusy: boolean;
};

type Turn = { role: "user" | "assistant"; text: string };

const SIDECHAT_SYSTEM = `You are Calvras Side Chat — a companion assistant that runs alongside the main coding agent and is available at any time, including while the agent is working.
You can answer ANY question the user asks: ideas, explanations, decisions, or anything else. Talk naturally and keep answers short unless depth is asked for.
When a question is about the running task, base your answer ONLY on the live progress report the app provides below. Be honest about what is done, what is in flight, and what is left — never invent steps or results.
For a time estimate, reason from the progress report (steps done, current action, elapsed time) and give a rough, clearly-qualified range rather than a false precision.
Always answer in plain conversational text. Never wrap your reply in JSON, an object, key/value pairs, or code fences — just write the message the user should see.`;

const SKETCH_SYSTEM = `You are Calvras Side Chat in sketch mode. Reply with ONLY a single inline <svg> element — nothing else, no prose, no markdown fences. Draw a rough, hand-sketched wireframe or diagram of what the user asked for: monochrome strokes, slightly imperfect rectangles and lines, arrows for flow, and short text labels. Use viewBox="0 0 320 200", stroke="#1a1512", fill="none" or soft fills, a clean light background rect. Make it look like a real pencil sketch on paper.`;

const QUICK_ACTIONS = [
  { label: "How's it going?", icon: MessageSquareText, prompt: "Give me a quick read on where the agent is right now and what it's doing." },
  { label: "How long?", icon: Timer, prompt: "Based on the live progress, roughly how much longer will this take?" },
  { label: "Feedback", icon: ThumbsUp, prompt: "Give me honest feedback on the work so far — what looks good and what worries you." },
  { label: "Sketch it", icon: PencilRuler, prompt: "Sketch the current build as a quick wireframe.", sketch: true },
];

function sanitizeSketchSvg(raw: string): string | null {
  const match = raw.match(/<svg[\s\S]*?<\/svg>/i);
  if (!match) return null;
  let svg = match[0];
  svg = svg.replace(/<script[\s\S]*?<\/script>/gi, "");
  svg = svg.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
  svg = svg.replace(/\son\w+\s*=\s*"[^"]*"/gi, "").replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  svg = svg.replace(/javascript:/gi, "");
  return svg;
}

function pickString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["response", "message", "text", "reply", "answer", "content"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
    const firstString = Object.values(obj).find((v) => typeof v === "string");
    if (typeof firstString === "string") return firstString;
  }
  return null;
}

// The model occasionally wraps its answer in JSON or a ```json fence; surface only the
// human text, and hold back an incomplete JSON payload so raw braces never flash.
function cleanReply(raw: string): { text: string; pending: boolean } {
  const t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && typeof fence[1] === "string") return cleanReply(fence[1]);
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t);
      return { text: pickString(parsed) ?? t, pending: false };
    } catch {
      return { text: "", pending: true };
    }
  }
  return { text: raw, pending: false };
}

export function SideChat({ onClose, getProgress, agentBusy }: SideChatProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns, thinking]);

  const ask = useCallback(async (question: string, sketch = false) => {
    const text = question.trim();
    if (!text || thinking) return;
    const nextTurns: Turn[] = [...turns, { role: "user", text }];
    setTurns(nextTurns);
    setInput("");
    setThinking(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const history = nextTurns.slice(-8).map((t) => `${t.role === "user" ? "User" : "Calvras"}: ${t.text}`).join("\n");
    const progress = getProgress();
    const system = sketch ? SKETCH_SYSTEM : SIDECHAT_SYSTEM;
    const context = `\n\n[LIVE PROGRESS REPORT]\n${progress || "No task is currently running."}`;
    const prompt = `${history}\n\nUser: ${text}${sketch ? "\n(Draw the requested sketch as SVG.)" : ""}`;

    let streamed = "";
    try {
      const answer = await callAI(prompt, system + context, undefined, undefined, controller.signal, (partial) => {
        streamed = partial;
        setTurns((prev) => {
          const copy = prev.slice();
          const last = copy[copy.length - 1];
          if (last && last.role === "assistant") copy[copy.length - 1] = { ...last, text: partial };
          else copy.push({ role: "assistant", text: partial });
          return copy;
        });
      }, "Quick");
      setTurns((prev) => {
        const copy = prev.slice();
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant") copy[copy.length - 1] = { ...last, text: answer || streamed };
        return copy;
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setTurns((prev) => [...prev, { role: "assistant", text: `I couldn't answer that: ${error instanceof Error ? error.message : "please try again."}` }]);
      }
    } finally {
      setThinking(false);
      abortRef.current = null;
    }
  }, [turns, thinking, getProgress]);

  return (
    <aside
      aria-label="Side chat"
      className="fixed z-40 flex flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#161617] text-white animate-in fade-in slide-in-from-bottom-4 duration-300"
      style={{ right: 12, bottom: 12, width: "min(360px, calc(100vw - 24px))", height: "min(520px, calc(100dvh - 120px))" }}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-full bg-white/[0.06] text-white/70"><Sparkles className="size-3.5" /></span>
          <div className="min-w-0">
            <h2 className="text-[13px] font-medium tracking-tight text-white/90">Side chat</h2>
            <p className="text-[10px] text-white/40">{agentBusy ? "Answers while the agent works" : "Ask anything"}</p>
          </div>
        </div>
        <button type="button" aria-label="Close side chat" onClick={onClose} className="rounded-lg p-1.5 text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/80"><X className="size-4" /></button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {turns.length === 0 && (
          <p className="px-1 py-6 text-center text-[12px] leading-5 text-white/35">
            A second assistant that runs alongside the build. Ask how it's going, how long is left, for feedback, or for a quick sketch.
          </p>
        )}
        {turns.map((turn, index) => {
          const sketch = turn.role === "assistant" ? sanitizeSketchSvg(turn.text) : null;
          const reply = turn.role === "assistant" && !sketch ? cleanReply(turn.text) : null;
          return (
            <div key={index} className={cn("flex", turn.role === "user" ? "justify-end" : "justify-start")}>
              {turn.role === "user" ? (
                <div className="max-w-[85%] break-words rounded-2xl rounded-br-sm bg-white/[0.12] px-3 py-2 text-[12.5px] leading-relaxed text-white/90">{turn.text}</div>
              ) : sketch ? (
                <div className="max-w-full overflow-hidden rounded-xl border border-white/[0.08] bg-[#f5f0e8]" dangerouslySetInnerHTML={{ __html: sketch }} />
              ) : reply?.pending ? (
                <div className="flex max-w-[90%] items-center gap-1.5 text-[12.5px] leading-relaxed text-white/40">
                  <span className="size-1.5 animate-pulse rounded-full bg-white/40" />
                  <span className="animate-pulse">Calvras is typing…</span>
                </div>
              ) : (
                <div className="max-w-[90%] text-[12.5px] leading-relaxed text-white/85"><MarkdownContent content={reply?.text ?? turn.text} /></div>
              )}
            </div>
          );
        })}
        {thinking && turns[turns.length - 1]?.role !== "assistant" && (
          <div className="flex items-center gap-1.5 px-1 text-[11px] text-white/40"><span className="size-1.5 animate-pulse rounded-full bg-white/40" />Thinking…</div>
        )}
      </div>

      <div className="shrink-0 space-y-2 border-t border-white/[0.06] px-3 py-3">
        <div className="flex flex-wrap gap-1.5">
          {QUICK_ACTIONS.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.label}
                type="button"
                disabled={thinking}
                onClick={() => void ask(action.prompt, Boolean(action.sketch))}
                className="flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[10.5px] font-medium text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white/90 disabled:opacity-40"
              >
                <Icon className="size-3" />{action.label}
              </button>
            );
          })}
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); void ask(input); }}
          className="flex items-end gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 focus-within:border-white/20"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }}
            rows={1}
            placeholder="Ask anything…"
            className="max-h-24 min-h-[20px] flex-1 resize-none bg-transparent text-[12.5px] leading-5 text-white/90 outline-none placeholder:text-white/30"
          />
          <button
            type="submit"
            disabled={thinking || !input.trim()}
            aria-label="Send"
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white text-[#1a1512] transition-opacity hover:opacity-90 disabled:opacity-30"
          >
            <Send className="size-3.5" />
          </button>
        </form>
      </div>
    </aside>
  );
}
