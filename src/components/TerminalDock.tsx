import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Folder, SquareTerminal, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  projectPath: string | null;
  projectName: string | null;
  onClose: () => void;
  /** Inside the right dock the panel owns the frame and the close control, so the terminal
   * drops its own floating window chrome. */
  docked?: boolean;
};

type Line = { id: number; kind: "command" | "output" | "error" | "info"; text: string };

let lineId = 0;
const nextId = () => ++lineId;

function cleanOutput(value: unknown): string {
  return String(value ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .slice(-80_000);
}

function normalizePath(value: string): string | null {
  const stack: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!stack.length) return null;
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

export function TerminalDock({ projectPath, projectName, onClose, docked = false }: Props) {
  const [lines, setLines] = useState<Line[]>([]);
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState(".");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const historyIndex = useRef(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const add = useCallback((kind: Line["kind"], text: string) => {
    setLines((previous) => [...previous.slice(-400), { id: nextId(), kind, text }]);
  }, []);

  useEffect(() => {
    setCwd(".");
    setHistory([]);
    setCommand("");
    setLines([{ id: nextId(), kind: "info", text: projectPath ? `Terminal ready in ${projectName || projectPath}. Commands run on this computer.` : "Choose a folder below the composer to use the terminal." }]);
  }, [projectPath, projectName]);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [lines, running]);

  useEffect(() => {
    if (docked) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [docked, onClose]);

  const prompt = `${projectName || "folder"}${cwd && cwd !== "." ? `/${cwd}` : ""}>`;

  const changeDirectory = async (argument: string) => {
    if (!projectPath) throw new Error("Choose a folder first.");
    const raw = argument.replace(/^["']|["']$/g, "").trim();
    const root = projectPath.replaceAll("\\", "/").replace(/\/+$/, "");
    let target: string;
    if (!raw || raw === "~" || raw === ".") target = "";
    else if (raw === "..") {
      const parent = cwd === "." ? "" : normalizePath(`${cwd}/..`);
      if (parent === null) throw new Error("That path leaves the project folder.");
      target = parent;
    } else {
      const unquoted = raw.replaceAll("\\", "/");
      if (unquoted === root) target = "";
      else if (unquoted.toLowerCase().startsWith(`${root.toLowerCase()}/`)) target = unquoted.slice(root.length + 1);
      else if (/^([a-zA-Z]:|\/)/.test(unquoted)) throw new Error("This terminal stays inside the project folder.");
      else {
        const joined = normalizePath(cwd === "." ? unquoted : `${cwd}/${unquoted}`);
        if (joined === null) throw new Error("That path leaves the project folder.");
        target = joined;
      }
    }
    if (target) {
      const check = await fetch("/api/terminal/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath, cwd: target, command: "cd" }),
      });
      const result = await check.json().catch(() => ({}));
      if (!check.ok || result.ok === false) throw new Error(result.error || "That folder does not exist.");
    }
    setCwd(target || ".");
    add("info", `Now in ${target ? `${projectName || "folder"}/${target}` : projectName || "the project folder"}.`);
  };

  const run = async () => {
    const submitted = command.trim();
    if (!submitted || running || !projectPath) return;
    setCommand("");
    setHistory((previous) => [submitted, ...previous.filter((item) => item !== submitted)].slice(0, 80));
    historyIndex.current = -1;
    add("command", `${prompt} ${submitted}`);

    if (submitted === "clear" || submitted === "cls") {
      setLines([]);
      return;
    }
    const cdMatch = /^cd(?:\s+(.+))?$/i.exec(submitted);
    if (cdMatch) {
      try {
        await changeDirectory(cdMatch[1] || "");
      } catch (error) {
        add("error", error instanceof Error ? error.message : "Could not change folders.");
      }
      return;
    }

    setRunning(true);
    try {
      const response = await fetch("/api/terminal/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath, cwd, command: submitted, timeoutMs: 120_000 }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.error || `The command failed (HTTP ${response.status}).`);
      const output = cleanOutput(result.output);
      if (result.cwd && typeof result.cwd === "string") setCwd(result.cwd === "." ? "." : result.cwd.replaceAll("\\", "/"));
      if (output.trim()) add(result.exitCode === 0 ? "output" : "output", output.replace(/\s+$/, ""));
      if (result.exitCode !== 0) add("error", `Exit code ${result.exitCode}`);
    } catch (error) {
      add("error", error instanceof Error ? error.message : "The command could not run.");
    } finally {
      setRunning(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); void run(); return; }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!history.length) return;
      historyIndex.current = Math.min(historyIndex.current + 1, history.length - 1);
      setCommand(history[historyIndex.current] || "");
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      historyIndex.current = Math.max(historyIndex.current - 1, -1);
      setCommand(historyIndex.current < 0 ? "" : history[historyIndex.current] || "");
    }
    if (event.key.toLowerCase() === "l" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      setLines([]);
    }
  };

  return (
    <section
      aria-label="Terminal"
      className={docked
        ? "flex h-full min-h-0 flex-col bg-[#0f1011] text-white"
        : "fixed bottom-3 right-3 z-50 flex h-[min(360px,calc(100dvh-140px))] w-[min(620px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-white/[0.09] bg-[#0f1011] text-white animate-in slide-in-from-bottom-4 fade-in duration-300"}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] bg-[#151617] px-3.5 py-2.5">
        {!docked && (
          <>
            <span className="flex items-center gap-1.5"><i className="size-2.5 rounded-full bg-[#ff5f57]" /><i className="size-2.5 rounded-full bg-[#febc2e]" /><i className="size-2.5 rounded-full bg-[#28c840]" /></span>
            <span className="ml-2 flex items-center gap-1.5 text-[12px] text-white/65"><SquareTerminal className="size-3.5" />Terminal</span>
          </>
        )}
        <span className={cn("flex min-w-0 items-center gap-1 rounded-md bg-white/[0.05] px-2 py-0.5 text-[10px] text-white/35", docked && "mr-auto")}><Folder className="size-3 shrink-0" /><span className="truncate">{projectName || "No folder"}</span></span>
        <span className="ml-auto flex items-center gap-1">
          <button type="button" aria-label="Clear terminal" title="Clear (Ctrl+L)" onClick={() => setLines([])} className="rounded-md p-1.5 text-white/35 hover:bg-white/[0.06] hover:text-white/80"><Trash2 className="size-3.5" /></button>
          {!docked && <button type="button" aria-label="Close terminal" title="Close (Esc)" onClick={onClose} className="rounded-md p-1.5 text-white/35 hover:bg-white/[0.06] hover:text-white/80"><X className="size-4" /></button>}
        </span>
      </div>

      <div ref={outputRef} role="log" aria-live="polite" className="min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-[12px] leading-[1.65]">
        {lines.map((line) => (
          <pre key={line.id} className={`whitespace-pre-wrap break-words ${line.kind === "command" ? "text-emerald-300/90" : line.kind === "error" ? "text-red-300" : line.kind === "info" ? "text-white/40" : "text-white/75"}`}>{line.text}</pre>
        ))}
        {running && <p className="flex items-center gap-2 text-amber-300/80"><span className="size-3 animate-spin rounded-full border border-current border-t-transparent" />Running…</p>}
      </div>

      <form onSubmit={(event) => { event.preventDefault(); void run(); }} className="flex shrink-0 items-center gap-2 border-t border-white/[0.07] bg-[#131415] px-3 py-2.5">
        <ChevronRight className="size-3.5 shrink-0 text-emerald-400/80" />
        <span className="shrink-0 font-mono text-[11px] text-white/35">{prompt}</span>
        <input
          ref={inputRef}
          aria-label="Terminal command"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={!projectPath || running}
          placeholder={!projectPath ? "Choose a folder first" : running ? "Waiting for the command to finish…" : "Type a command and press Enter"}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-white/85 outline-none placeholder:text-white/20 disabled:cursor-not-allowed"
        />
      </form>
    </section>
  );
}
