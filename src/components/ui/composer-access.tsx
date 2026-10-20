import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Shield, ShieldCheck, Hand, X } from "lucide-react";
import { ACCESS_MODES, type AccessMode } from "@/lib/tool-catalog";

export type ComposerRequest = { id: string; question: string; choices?: string[]; kind?: "approval" | "question"; busy?: boolean; action?: { type: string } };
export function AccessSelector({ value, onChange }: { value: AccessMode; onChange: (value: AccessMode) => void }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close); return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const Icon = value === "full" ? ShieldCheck : value === "ask" ? Hand : Shield;
  return <div ref={container} className="relative">
    <button type="button" aria-label="Workspace permissions" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)} className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Icon className="size-3.5" /><span>{ACCESS_MODES.find((mode) => mode.value === value)?.label}</span><ChevronDown className="size-3" /></button>
    {open && <div role="menu" aria-label="Workspace permissions" onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} className="absolute bottom-full left-0 z-50 mb-2 w-[min(320px,85vw)] rounded-2xl border border-border bg-card p-1.5 text-foreground shadow-xl">
      <p className="px-3 py-2 text-xs text-muted-foreground">How should Calvras work?</p>
      {ACCESS_MODES.map((mode) => <button role="menuitemradio" aria-checked={value === mode.value} key={mode.value} onClick={() => { onChange(mode.value); setOpen(false); }} className="flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex-1"><span className="block text-xs font-medium">{mode.label}</span><span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{mode.description}</span></span>{value === mode.value && <Check className="mt-0.5 size-3.5" />}
      </button>)}
    </div>}
  </div>;
}
export function ComposerApproval({ request, onDecision, onStop }: { request: ComposerRequest; onDecision: (choice: string, answer?: string) => void; onStop?: (() => void) | undefined }) {
  const [choice, setChoice] = useState("once");
  const [answer, setAnswer] = useState("");
  useEffect(() => { setChoice(request.kind === "question" ? request.choices?.[0] || "" : "once"); setAnswer(""); }, [request.id]);
  const isQuestion = request.kind === "question";
  const choices = isQuestion ? request.choices || [] : ["once", "always", "deny"];
  const labels: Record<string, string> = { once: "Allow once", always: "Always allow", deny: "Don't allow" };
  const typed = answer.trim();
  // A typed answer is the fourth option, not a footnote to the other three: once it holds text
  // it is the decision, because "allow once" plus "use pnpm instead" is one answer, not two.
  const submit = () => {
    if (isQuestion) return onDecision(typed || choice);
    if (typed) return onDecision("answer", typed);
    onDecision(choice);
  };
  return <section aria-label="Calvras needs your decision" className="w-full max-w-[480px] rounded-[24px] border border-[#dfd6c8] bg-[#f5f0e8] p-4 text-[#1a1512] shadow-xl">
    <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-[#6b5a46]" /><p className="min-w-0 flex-1 break-words text-[13px] font-medium leading-5">{request.question}</p><button type="button" aria-label="Stop task" onClick={onStop} className="rounded-full p-1 hover:bg-black/5"><X className="size-3.5" /></button></div>
    <fieldset disabled={request.busy} className={`mt-3 space-y-1${typed ? " opacity-50" : ""}`}><legend className="sr-only">Choose a response</legend>{choices.map((option) => <label key={option} className="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-xs hover:bg-black/5"><input type="radio" name={`approval-${request.id}`} value={option} checked={typed ? false : choice === option} disabled={Boolean(typed)} onChange={() => setChoice(option)} className="accent-[#6b5a46]" /><span>{isQuestion ? option : labels[option]}</span></label>)}</fieldset>
    <input aria-label="Your answer" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={isQuestion ? "Or type an answer…" : "Or type your own answer — Calvras will follow it…"} className="mt-2 w-full rounded-xl border border-[#dfd6c8] bg-transparent px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-[#6b5a46]" />
    <div className="mt-3 flex justify-end"><button type="button" disabled={request.busy || !(typed || choice)} onClick={submit} className="rounded-full bg-[#1a1512] px-4 py-2 text-xs font-medium text-[#f5f0e8] disabled:opacity-40">{request.busy ? "Applying…" : typed ? "Send your answer" : isQuestion ? "Send answer" : "Confirm choice"}</button></div>
  </section>;
}
