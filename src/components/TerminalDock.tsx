import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, TerminalSquare, Trash2, X } from "lucide-react";

type Props = {
  projectPath: string | null;
  projectName: string | null;
  onClose: () => void;
};

/**
 * A real shell on this computer, streamed live. The transcript is whatever the shell itself wrote,
 * including its own prompt and its own echo of the command that was typed, so nothing here has to
 * pretend to be a terminal: closing this panel leaves the process running and a dev server keeps
 * pouring its log into the same buffer until the folder's session is actually closed.
 */
export function TerminalDock({ projectPath, projectName, onClose }: Props) {
  const [transcript, setTranscript] = useState("");
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "connecting" | "live" | "closed">("idle");
  const [history, setHistory] = useState<string[]>([]);
  const historyIndex = useRef(-1);
  const sessionId = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!projectPath) { setStatus("idle"); return; }
    const controller = new AbortController();
    let stream: ReadableStreamDefaultReader<Uint8Array> | null = null;
    setStatus("connecting");
    setTranscript("");
    (async () => {
      try {
        const response = await fetch("/api/terminal/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectPath }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({})))?.error || "The terminal could not start.");
        sessionId.current = response.headers.get("x-calvras-terminal");
        setStatus("live");
        const reader = response.body.getReader();
        stream = reader;
        const decoder = new TextDecoder("utf-8", { fatal: false });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          if (text) setTranscript((previous) => (previous + text).slice(-200_000));
        }
        setStatus("closed");
      } catch (error) {
        if (!controller.signal.aborted) {
          setTranscript((previous) => `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${error instanceof Error ? error.message : "The terminal could not start."}\n`);
          setStatus("closed");
        }
      }
    })();
    return () => { stream?.cancel().catch(() => {}); controller.abort(); };
  }, [projectPath]);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [transcript]);

  const send = useCallback(async (data: string) => {
    if (!sessionId.current) return;
    await fetch("/api/terminal/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId.current, data }),
    }).catch(() => {});
  }, []);

  const submit = () => {
    const submitted = input.trim();
    if (!submitted || status !== "live") return;
    setHistory((previous) => [submitted, ...previous.filter((item) => item !== submitted)].slice(0, 80));
    historyIndex.current = -1;
    setInput("");
    void send(`${submitted}\r\n`);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); submit(); return; }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!history.length) return;
      historyIndex.current = Math.min(historyIndex.current + 1, history.length - 1);
      setInput(history[historyIndex.current] || "");
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      historyIndex.current = Math.max(historyIndex.current - 1, -1);
      setInput(historyIndex.current < 0 ? "" : history[historyIndex.current] || "");
    }
    // Ctrl+C belongs to the shell: it stops whatever the command running right now is doing.
    if (event.key === "c" && event.ctrlKey) { event.preventDefault(); void send("\x03"); }
    if (event.key.toLowerCase() === "l" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); setTranscript(""); }
  };

  return (
    <section aria-label="Terminal" className="terminal-panel">
      <div className="terminal-panel-bar">
        <span className="terminal-panel-folder"><Folder className="size-3 shrink-0" /><span className="truncate">{projectName || "No folder"}</span></span>
        <span className="terminal-panel-state">{status === "live" ? "live" : status === "connecting" ? "connecting…" : status === "closed" ? "stopped" : "choose a folder"}</span>
        <span className="ml-auto flex items-center gap-1">
          <button type="button" aria-label="Clear terminal" title="Clear the screen (Ctrl+L)" onClick={() => setTranscript("")} className="terminal-panel-button"><Trash2 className="size-3.5" /></button>
          <button type="button" aria-label="Close terminal" title="Close the terminal (Esc)" onClick={onClose} className="terminal-panel-button"><X className="size-4" /></button>
        </span>
      </div>

      <div ref={outputRef} role="log" aria-live="polite" className="terminal-panel-output">
        <pre>{transcript || (projectPath ? "Starting the shell…" : "Open a folder to use the terminal.")}</pre>
      </div>

      <form onSubmit={(event) => { event.preventDefault(); submit(); }} className="terminal-panel-input">
        <TerminalSquare className="size-3.5 shrink-0 text-white/30" />
        <input
          ref={inputRef}
          aria-label="Terminal command"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={status !== "live"}
          placeholder={status === "live" ? "Type a command and press Enter" : status === "connecting" ? "Starting the shell…" : "The shell is not running"}
          autoComplete="off"
          spellCheck={false}
        />
      </form>
    </section>
  );
}
