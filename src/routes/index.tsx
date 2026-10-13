import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { PromptInput } from "@/components/ui/ai-chat-input";
import {
  AgentWorkflow,
  CUSTOM_TOOLS,
  type AgentPhase,
  type TraceNode,
  type DiffRow,
} from "@/components/ui/ai-agent-response";
import { useProjects } from "@/lib/project-context";
import { callAI, type MediaAttachment } from "@/lib/gemini";
import { cn } from "@/lib/utils";
import { ChapterScrubber, type Chapter } from "@/components/ui/chapter-scrubber";
import { Copy, CheckCheck, X } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Calvras — Autonomous Coding Agent" },
      { name: "description", content: "Calvras builds and edits code in your projects." },
      { property: "og:title", content: "Calvras" },
      { property: "og:description", content: "Your autonomous coding agent." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

/* ─────────────────────────────────────────────────────────────────────────────
 * TYPES
 * ─────────────────────────────────────────────────────────────────────────────
 */

interface AttachedFile {
  name: string;
  type: string;
  url: string; // object URL or data URL
}

interface Message {
  id: number;
  text: string;
  attachments?: AttachedFile[];
  phases: AgentPhase[];
  done: boolean;
  role: "user" | "assistant";
}

interface FsAction {
  type?: "create_file" | "edit_file" | "run_command";
  action?: "create_file" | "edit_file" | "run_command";
  path?: string;
  content?: string;
  lineStart?: number;
  lineEnd?: number;
  newContent?: string;
  command?: string;
}

interface CalvrasResponsePayload {
  thought?: string;
  reasoning?: string[];
  actions?: FsAction[];
  message?: string;
  plan?: string; // Implementation plan markdown content
}

interface ImplementationPlan {
  title: string;
  content: string;
  messageId: number;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * HELPERS
 * ─────────────────────────────────────────────────────────────────────────────
 */

function parseCalvrasPayload(text: string): CalvrasResponsePayload {
  const trimmed = text.trim();

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      const actions = parsed.actions || (parsed.action ? [parsed] : []);
      return {
        thought: parsed.thought,
        reasoning: Array.isArray(parsed.reasoning) ? parsed.reasoning : undefined,
        actions,
        message: parsed.message || "",
        plan: typeof parsed.plan === "string" ? parsed.plan : undefined,
      };
    }
  } catch {
    // not raw json
  }

  const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlock) {
    try {
      const parsed = JSON.parse(jsonBlock[1].trim());
      if (typeof parsed === "object" && parsed !== null) {
        const actions = parsed.actions || (parsed.action ? [parsed] : []);
        return {
          thought: parsed.thought,
          reasoning: Array.isArray(parsed.reasoning) ? parsed.reasoning : undefined,
          actions,
          message: parsed.message || text.replace(/```(?:json)?[\s\S]*?```/g, "").trim(),
          plan: typeof parsed.plan === "string" ? parsed.plan : undefined,
        };
      }
    } catch {
      // not block json
    }
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const substr = text.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(substr);
      if (typeof parsed === "object" && parsed !== null) {
        return {
          thought: parsed.thought,
          reasoning: Array.isArray(parsed.reasoning) ? parsed.reasoning : undefined,
          actions: parsed.actions || (parsed.action ? [parsed] : []),
          message: parsed.message || text.slice(0, firstBrace).trim() + " " + text.slice(lastBrace + 1).trim(),
          plan: typeof parsed.plan === "string" ? parsed.plan : undefined,
        };
      }
    } catch {
      // ignore
    }
  }

  return {
    message: text.trim(),
    actions: [],
  };
}

function projectNameFrom(text: string): string {
  const cleaned = text
    .replace(/^(build|create|make|code|write|setup|develop)\s+(me\s+)?(a\s+|an\s+)?/i, "")
    .replace(/^(simple|new|basic)\s+/i, "")
    .trim();

  const slug = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);

  return `calvras-${slug || "workspace"}`;
}

function isCodeProjectIntent(text: string): boolean {
  return /\b(build|create|make|write|code|implement|edit|change|fix|update|add|component|app|website|page|script|file|function|repo|project)\b/i.test(text);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * ATTACHMENT PREVIEW in bubble
 * ─────────────────────────────────────────────────────────────────────────────
 */
function AttachmentPreview({ att }: { att: AttachedFile }) {
  const isImage = att.type.startsWith("image/");
  const isPdf = att.type === "application/pdf" || att.name.toLowerCase().endsWith(".pdf");
  const ext = att.name.split(".").pop()?.toUpperCase() ?? "FILE";
  const docColors: Record<string, string> = {
    PDF: "#e74c3c", DOCX: "#2b7cd3", DOC: "#2b7cd3", TXT: "#6b7280", CSV: "#16a34a", MD: "#6b7280",
  };
  const bg = docColors[ext] ?? "#6b7280";

  if (isImage) {
    return (
      <img
        src={att.url}
        alt={att.name}
        className="max-h-56 max-w-[280px] rounded-xl object-cover border border-border shadow-sm"
        onError={(e) => {
          // Fallback if somehow URL is broken
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }

  // PDF: show a small embedded preview if we have a data URL
  if (isPdf && att.url.startsWith("data:")) {
    return (
      <div className="flex flex-col gap-1.5 rounded-xl border border-border overflow-hidden shadow-sm" style={{ maxWidth: 220 }}>
        <iframe
          src={att.url}
          title={att.name}
          className="w-full rounded-t-xl border-0"
          style={{ height: 140 }}
        />
        <div className="flex items-center gap-2 px-3 py-1.5 bg-muted text-xs font-medium text-foreground truncate">
          <span className="inline-flex h-5 w-7 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white" style={{ background: "#e74c3c" }}>PDF</span>
          <span className="truncate">{att.name}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-2.5 rounded-xl border border-border bg-muted px-3 py-2 text-sm"
      style={{ maxWidth: 220 }}
    >
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[9px] font-bold text-white"
        style={{ background: bg }}
      >
        {ext}
      </div>
      <span className="truncate text-foreground font-medium text-xs">{att.name}</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * COLLAPSIBLE USER MESSAGE BUBBLE
 * Shortened/collapsed by default when long, expands on click, folds on outside click
 * ─────────────────────────────────────────────────────────────────────────────
 */
function UserMessageBubble({ text }: { text: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);

  const isLong = text.includes("\n") || text.length > 60;

  useEffect(() => {
    if (!isExpanded) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (bubbleRef.current && !bubbleRef.current.contains(e.target as Node)) {
        setIsExpanded(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [isExpanded]);

  const copyButton = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      aria-label={copied ? 'Copied' : 'Copy message'}
      className="flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 active:scale-[0.92] transition-colors mt-1 self-end"
    >
      {copied ? (
        <CheckCheck className="size-3.5 text-emerald-500" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );

  if (!isLong) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <div className="break-words rounded-2xl bg-muted px-4 py-2.5 text-sm leading-relaxed text-foreground shadow-xs select-text">
          {text}
        </div>
        {copyButton}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <div
        ref={bubbleRef}
        onClick={() => setIsExpanded((prev) => !prev)}
        title={isExpanded ? "Click to fold message" : "Click to expand message"}
        className={cn(
          "group relative break-words rounded-2xl bg-muted text-foreground shadow-xs transition-all duration-200 cursor-pointer select-text",
          isExpanded
            ? "px-4 py-2.5 text-sm leading-relaxed max-w-full"
            : "px-4 py-2.5 max-h-[100px] overflow-hidden hover:bg-muted/90 text-sm leading-relaxed"
        )}
      >
        {isExpanded ? (
          <div className="whitespace-pre-wrap">{text}</div>
        ) : (
          <div className="relative">
            <div className="whitespace-pre-wrap">{text}</div>
            <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-muted via-muted/60 to-transparent" />
          </div>
        )}
      </div>
      {copyButton}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * COMPONENT
 * ─────────────────────────────────────────────────────────────────────────────
 */
function Index() {
  const { activeProject, setActiveProject, addProject, addRecent, newChatSignal } = useProjects();
  const [messages, setMessages] = useState<Message[]>([]);
  const [projectPath, setProjectPath] = useState<string | null>(activeProject?.path || null);
  const [projectName, setProjectName] = useState<string | null>(activeProject?.name || null);
  const [isLoading, setIsLoading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const latestMessageRef = useRef<HTMLDivElement>(null);

  // Effort level: "Low" | "Medium" | "Max Effort"
  const [effortLevel, setEffortLevel] = useState<string>("Medium");

  // Implementation plan slide-out panel
  const [activePlan, setActivePlan] = useState<ImplementationPlan | null>(null);
  const [planPanelOpen, setPlanPanelOpen] = useState(false);

  // Running dev server URL (if any)
  const [devServerUrl, setDevServerUrl] = useState<string | null>(null);

  // Live clock
  const [clockTime, setClockTime] = useState('');
  useEffect(() => {
    const update = () => {
      const now = new Date();
      setClockTime(now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  // Project dropdown
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const projectBadgeRef = useRef<HTMLButtonElement>(null);

  // Close project dropdown on outside click
  useEffect(() => {
    if (!projectDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (projectBadgeRef.current && !projectBadgeRef.current.closest('[data-project-badge-wrapper]')?.contains(e.target as Node)) {
        setProjectDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [projectDropdownOpen]);

  // Sync when activeProject changes from context
  useEffect(() => {
    if (activeProject) {
      setProjectPath(activeProject.path);
      setProjectName(activeProject.name);
    }
  }, [activeProject]);

  // Handle New Chat signal
  const prevSignalRef = useRef(newChatSignal);
  useEffect(() => {
    if (newChatSignal !== prevSignalRef.current) {
      prevSignalRef.current = newChatSignal;
      setMessages([]);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      setIsLoading(false);
    }
  }, [newChatSignal]);

  // Auto-scroll on new message
  useEffect(() => {
    if (messages.length === 0) return;
    latestMessageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [messages.length]);

  // Stop handler
  const handleStop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsLoading(false);
    setMessages((prev) =>
      prev.map((m) =>
        !m.done
          ? {
              ...m,
              done: true,
              phases: m.phases.map((p) => ({
                ...p,
                message: p.message || "Operation paused by user.",
              })),
            }
          : m
      )
    );
  }, []);

  // Get project context snapshot
  const getProjectContextString = useCallback(async (activePath: string): Promise<string> => {
    try {
      const res = await fetch(`/api/fs/tree?projectPath=${encodeURIComponent(activePath)}`);
      if (!res.ok) return "";
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.files) || data.files.length === 0) {
        return "Project is empty. No files exist yet.";
      }
      return data.files
        .map(
          (f: { path: string; lines: number; contentSample: string }) =>
            `File: ${f.path} (${f.lines} lines):\n${f.contentSample}`
        )
        .join("\n\n---\n\n");
    } catch {
      return "";
    }
  }, []);

  // Execute filesystem actions
  const executeActions = useCallback(
    async (actions: FsAction[], activePath: string): Promise<{ nodes: TraceNode[]; summaryNotes: string[] }> => {
      const nodes: TraceNode[] = [];
      const summaryNotes: string[] = [];

      for (const act of actions) {
        const actionType = act.type || act.action;

        if (actionType === "create_file" && act.path) {
          try {
            const res = await fetch("/api/fs/create", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ projectPath: activePath, path: act.path, content: act.content ?? "" }),
            });
            const data = await res.json();
            if (data.ok) {
              nodes.push({
                type: "tool",
                primary: "Create file",
                secondary: act.path,
                mono: true,
                details: [{ text: `✓ Created ${act.path} (${(act.content ?? "").split("\n").length} lines)`, tone: "add" }],
              });
              summaryNotes.push(`Created \`${act.path}\``);
            } else {
              throw new Error(data.error || "Failed to create file");
            }
          } catch (err: any) {
            nodes.push({ type: "tool", primary: "Create file failed", secondary: act.path, status: "failed", details: [{ text: `✗ ${err.message}`, tone: "error" }] });
          }
        }

        if (actionType === "edit_file" && act.path) {
          try {
            const res = await fetch("/api/fs/edit", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ projectPath: activePath, path: act.path, lineStart: act.lineStart ?? 1, lineEnd: act.lineEnd ?? act.lineStart ?? 1, newContent: act.newContent ?? "" }),
            });
            const data = await res.json();
            if (data.ok) {
              const diffRows: DiffRow[] = [];
              const oldLines: string[] = data.oldLines || [];
              const newLines: string[] = data.newLines || [];
              oldLines.forEach((line, i) => { diffRows.push({ old: (data.lineStart || 1) + i, cur: null, type: "del", text: line }); });
              newLines.forEach((line, i) => { diffRows.push({ old: null, cur: (data.lineStart || 1) + i, type: "add", text: line }); });
              nodes.push({ type: "tool", primary: "Edit file", secondary: `${act.path} (L${data.lineStart}-${data.lineEnd})`, mono: true, diffFile: act.path, diffRows, details: [{ text: `✓ Surgically updated lines ${data.lineStart}–${data.lineEnd} in ${act.path}`, tone: "add" }] });
              summaryNotes.push(`Surgically updated lines ${data.lineStart}–${data.lineEnd} in \`${act.path}\``);
            } else {
              throw new Error(data.error || "Failed to edit file");
            }
          } catch (err: any) {
            nodes.push({ type: "tool", primary: "Edit file failed", secondary: act.path, status: "failed", details: [{ text: `✗ ${err.message}`, tone: "error" }] });
          }
        }

        if (actionType === "run_command" && act.command) {
          try {
            const startT = Date.now();
            const res = await fetch("/api/fs/command", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ projectPath: activePath, command: act.command }),
            });
            const data = await res.json();
            const dur = Date.now() - startT;
            nodes.push({
              type: "terminal",
              primary: "Run command",
              secondary: act.command,
              command: act.command,
              exitCode: data.exitCode ?? (data.ok ? 0 : 1),
              durationMs: dur,
              output: data.output || (data.ok ? "Done" : "Error executing command"),
            });
            summaryNotes.push(`Ran \`${act.command}\``);
          } catch (err: any) {
            nodes.push({
              type: "terminal",
              primary: "Run command",
              secondary: act.command,
              command: act.command,
              exitCode: 1,
              durationMs: 120,
              output: `Error executing command: ${err.message}`,
            });
          }
        }
      }

      return { nodes, summaryNotes };
    },
    []
  );

  // ── Main submit handler ────────────────────────────────────────────────────
  const handleSubmit = useCallback(
    async (
      value: string,
      attachmentFiles?: { type: string; url: string; name?: string }[]
    ) => {
      const text = value.trim();
      if ((!text && (!attachmentFiles || attachmentFiles.length === 0)) || isLoading) return;

      setIsLoading(true);
      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Build attached file previews for the bubble
      const attachedForBubble: AttachedFile[] = (attachmentFiles || []).map((a) => ({
        name: a.name || "file",
        type: a.type || "application/octet-stream",
        url: a.url,
      }));

      // Add to recents
      addRecent({
        id: `chat-${Date.now()}`,
        label: (text || attachedForBubble[0]?.name || "Attachment").slice(0, 32) + ((text.length > 32) ? "…" : ""),
        projectPath: projectPath || undefined,
        projectName: projectName || undefined,
      });

      // Auto-create project folder if needed
      let activePath = projectPath;
      let activeName = projectName;

      if (!activePath && isCodeProjectIntent(text)) {
        const autoName = projectNameFrom(text);
        try {
          const res = await fetch("/api/fs/create-project", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: autoName }),
            signal: controller.signal,
          });
          const data = await res.json();
          if (data.ok && data.projectPath) {
            activePath = data.projectPath;
            activeName = data.name || autoName;
            setProjectPath(activePath);
            setProjectName(activeName);
            addProject({ name: activeName, path: activePath });
          }
        } catch (e) {
          console.warn("Could not auto-create project:", e);
        }
      }

      // Build conversation history for full memory
      const conversationHistory = messages
        .filter((m) => m.done)
        .flatMap((m) => [
          { role: "user" as const, content: m.text || "(attachment)" },
          {
            role: "assistant" as const,
            content: m.phases?.[0]?.message || "",
          },
        ]);

      // Add the initial thinking phase — starts with progressive live sentences
      const msgId = Date.now();

      // Build a rich set of thinking sentences based on context
      const hasAttachments = (attachmentFiles || []).length > 0;
      const initialThinkingPhase: AgentPhase = {
        trace: [
          {
            type: "reasoning",
            sentences: [
              hasAttachments
                ? `Analyzing attachment${(attachmentFiles?.length ?? 0) > 1 ? "s" : ""} and task...`
                : `Analyzing task: "${text.slice(0, 90)}${text.length > 90 ? "…" : ""}"`,
              activeName ? `Target workspace: "${activeName}"` : "Synthesizing requirements and architecture...",
            ],
            durationSeconds: 1.2,
          },
        ],
      };

      setMessages((prev) => [
        ...prev,
        {
          id: msgId,
          text,
          attachments: attachedForBubble.length > 0 ? attachedForBubble : undefined,
          phases: [initialThinkingPhase],
          done: false,
          role: "user",
        },
      ]);

      // Project snapshot
      let projectSnapshot = "";
      if (activePath) {
        projectSnapshot = await getProjectContextString(activePath);
      }

      // Build media list for AI
      const mediaList: MediaAttachment[] = [];
      if (attachmentFiles && attachmentFiles.length > 0) {
        for (const att of attachmentFiles) {
          mediaList.push({
            mimeType: att.type || "image/jpeg",
            data: att.url,
          });
        }
      }

      // Build the full prompt with conversation history context
      let fullPrompt = text || "(The user sent an attachment, please analyze it)";
      if (conversationHistory.length > 0) {
        const historyStr = conversationHistory
          .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
          .join("\n");
        fullPrompt = `[CONVERSATION HISTORY]\n${historyStr}\n\n[CURRENT USER MESSAGE]\n${text || "(attachment)"}`;
      }

      // Inject system prompt and time context on every message
      const now = new Date();
      const timeStr = now.toLocaleString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      });
      const systemPrefix = `You are Calvras, an autonomous coding agent. You are helpful, direct, and conversational.
IMPORTANT RULES:
- Do NOT introduce yourself.
- Do NOT assume the user wants to start coding immediately.
- If the user sends a casual greeting or vague message (like hey, hello, hi, what can you do), respond conversationally and ask what they would like to work on. Keep it short, one or two sentences max.
- Only provide code, setup instructions, or technical steps when the user has clearly described a specific task.
- Do not suggest Vite, Tailwind, shadcn, or any stack unprompted.
- When helping with code, be concise and focused on exactly what was asked.

[CURRENT TIME]: ${timeStr}`;
      fullPrompt = `${systemPrefix}\n\n${fullPrompt}`;

      // Invoke AI
      let aiRaw = "";
      try {
        aiRaw = await callAI(fullPrompt, undefined, mediaList, projectSnapshot);
      } catch (err: any) {
        aiRaw = `Connection error: ${err.message}`;
      }

      const parsed = parseCalvrasPayload(aiRaw);

      let actionNodes: TraceNode[] = [];
      let summaryNotes: string[] = [];

      if (parsed.actions && parsed.actions.length > 0 && !activePath) {
        const autoName = projectNameFrom(text);
        try {
          const res = await fetch("/api/fs/create-project", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: autoName }),
          });
          const data = await res.json();
          if (data.ok && data.projectPath) {
            activePath = data.projectPath;
            activeName = data.name || autoName;
            setProjectPath(activePath);
            setProjectName(activeName);
            addProject({ name: activeName, path: activePath });
          }
        } catch {}
      }

      if (parsed.actions && parsed.actions.length > 0 && activePath) {
        const execResult = await executeActions(parsed.actions, activePath);
        actionNodes = execResult.nodes;
        summaryNotes = execResult.summaryNotes;

        // Detect if any run_command started a dev server and extract the port/URL
        for (const act of parsed.actions) {
          const actionType = act.type || act.action;
          if (actionType === "run_command" && act.command) {
            const cmd = act.command.toLowerCase();
            const isDevServer = /\b(vite|npm run dev|next dev|yarn dev|pnpm dev|serve|http-server|python -m http|uvicorn|flask run|node server|ts-node|tsx)\b/.test(cmd);
            if (isDevServer) {
              // Try to find the port from the command or default to 5173/3000
              const portMatch = cmd.match(/--port[= ](\d+)|-p\s*(\d+)/);
              const port = portMatch ? (portMatch[1] || portMatch[2]) : (cmd.includes("vite") ? "5173" : cmd.includes("next") ? "3000" : "8080");
              setDevServerUrl(`http://localhost:${port}`);
            }
          }
        }
      }

      const finalPhases: AgentPhase[] = [];

      // Adjust reasoning duration based on effort level
      const reasoningDuration = effortLevel === "Low" ? 1.0 : effortLevel === "Max Effort" ? 3.5 : 2.0;

      const reasoningSentences =
        parsed.reasoning && parsed.reasoning.length > 0
          ? parsed.reasoning
          : parsed.thought
          ? [parsed.thought]
          : [`Analyzed "${text.slice(0, 80)}"`, actionNodes.length > 0 ? "Applying filesystem changes" : "Preparing response"];

      // Build the final message — if there's a localhost URL, append it
      let finalMessage =
        parsed.message ||
        (summaryNotes.length > 0
          ? `Finished: ${summaryNotes.join(", ")} in project \`${activeName}\`.`
          : "Task completed.");

      // If we detected a dev server running, append the link
      if (devServerUrl && !finalMessage.includes("localhost")) {
        finalMessage += `\n\nYour app is running at [${devServerUrl}](${devServerUrl}) — open it in your browser to see it live.`;
      }

      // If the AI returned a plan, register it and append a note to the message
      if (parsed.plan) {
        const planObj: ImplementationPlan = {
          title: `Implementation Plan`,
          content: parsed.plan,
          messageId: msgId,
        };
        setActivePlan(planObj);
        finalMessage = finalMessage
          ? `${finalMessage}\n\n📋 I've created an **implementation plan** for this task. Click "View Plan" to see the full structure.`
          : `📋 I've created an **implementation plan** for this task. Click "View Plan" to see the full structure.`;
      }

      finalPhases.push({
        trace: [
          {
            type: "reasoning",
            sentences: reasoningSentences,
            durationSeconds: reasoningDuration,
          },
          ...actionNodes,
          {
            type: "step",
            primary: actionNodes.length > 0 ? "Changes applied" : "Completed",
            secondary: activeName || "Calvras",
          },
        ],
        message: finalMessage,
      });

      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, phases: finalPhases, done: true } : m))
      );
      setIsLoading(false);
      abortControllerRef.current = null;
    },
    [projectPath, projectName, isLoading, addProject, addRecent, getProjectContextString, executeActions, messages, effortLevel, devServerUrl]
  );

  // ── Open / Switch Project Folder — uses native file system picker ──────────
  const handleOpenProject = useCallback(async () => {
    if (messages.length > 0) return; // locked during active chat

    try {
      // Use the File System Access API to let the user pick a directory
      if ("showDirectoryPicker" in window) {
        const dirHandle = await (window as any).showDirectoryPicker({ mode: "readwrite" });
        const folderName = dirHandle.name;
        // Try to register the selected path via backend
        try {
          const res = await fetch("/api/fs/create-project", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: folderName }),
          });
          const data = await res.json();
          if (data.ok && data.projectPath) {
            const newProj = { name: data.name || folderName, path: data.projectPath };
            setProjectPath(data.projectPath);
            setProjectName(newProj.name);
            setActiveProject(newProj);
            addProject(newProj);
            return;
          }
        } catch {
          // If backend registration fails, still set locally
          const newProj = { name: folderName, path: folderName };
          setProjectPath(folderName);
          setProjectName(folderName);
          setActiveProject(newProj);
          addProject(newProj);
        }
      } else {
        // Fallback: use a hidden <input type="file" webkitdirectory> trick
        const input = document.createElement("input");
        input.type = "file";
        input.setAttribute("webkitdirectory", "");
        input.setAttribute("directory", "");
        input.style.display = "none";
        document.body.appendChild(input);
        await new Promise<void>((resolve) => {
          input.onchange = async () => {
            const files = Array.from(input.files || []);
            if (files.length > 0) {
              // Extract folder name from webkitRelativePath
              const folderName = files[0].webkitRelativePath?.split("/")?.[0] || "project";
              try {
                const res = await fetch("/api/fs/create-project", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name: folderName }),
                });
                const data = await res.json();
                if (data.ok && data.projectPath) {
                  const newProj = { name: data.name || folderName, path: data.projectPath };
                  setProjectPath(data.projectPath);
                  setProjectName(newProj.name);
                  setActiveProject(newProj);
                  addProject(newProj);
                }
              } catch {
                const newProj = { name: folderName, path: folderName };
                setProjectPath(folderName);
                setProjectName(folderName);
                setActiveProject(newProj);
                addProject(newProj);
              }
            }
            document.body.removeChild(input);
            resolve();
          };
          input.click();
        });
      }
    } catch (err: any) {
      // User cancelled picker — that's fine, do nothing
      if (err?.name !== "AbortError") {
        console.error("Open project failed:", err);
      }
    }
  }, [messages.length, addProject, setActiveProject]);

  // ── Build ChapterScrubber chapters from message history ───────────────────
  const scrubberChapters: Chapter[] = messages
    .filter((m) => m.done)
    .map((m, i) => ({
      id: String(m.id),
      title: m.text ? (m.text.length > 48 ? m.text.slice(0, 48) + "…" : m.text) : `Message ${i + 1}`,
      description: m.phases?.[0]?.message
        ? (m.phases[0].message.length > 80 ? m.phases[0].message.slice(0, 80) + "…" : m.phases[0].message)
        : undefined,
      meta: `#${i + 1}`,
    }));

  return (
    <main
      className="chat-page antialiased"
      style={{ overflow: "hidden", height: "100dvh" }}
    >
      {/* ── Hide global scrollbar, use inner scroll only ────────────────── */}
      <style dangerouslySetInnerHTML={{ __html: `
        html, body { overflow: hidden !important; scrollbar-width: none !important; }
        html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }
        .chat-scroll-area { overflow-y: auto; scrollbar-width: none; }
        .chat-scroll-area::-webkit-scrollbar { display: none; }
      ` }} />

      {/* ── Top-right project badge & switcher ─────────────────────────── */}
      <div
        data-project-badge-wrapper=""
        className="fixed top-3 right-4 z-20 relative"
      >
        <button
          ref={projectBadgeRef}
          type="button"
          onClick={() => {
            if (messages.length > 0) return;
            setProjectDropdownOpen(prev => !prev);
          }}
          title={
            messages.length > 0
              ? `Active Project: ${projectName || "Workspace"} — start a New chat to switch`
              : projectName
              ? `Active Desktop Project: ${projectName} (${projectPath})`
              : "Open project folder"
          }
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium backdrop-blur-md transition-all shadow-xs",
            messages.length > 0
              ? "border-border/60 bg-card/60 text-muted-foreground/80 cursor-default"
              : "border-border bg-card/90 text-muted-foreground hover:bg-card hover:text-foreground cursor-pointer"
          )}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
            className="shrink-0"
          >
            <path
              d="M1.5 4.5C1.5 3.67 2.17 3 3 3h2.38c.28 0 .55.1.74.3l.88.88H11c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5H3c-.83 0-1.5-.67-1.5-1.5v-6Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
          {projectName ? (
            <span className="max-w-[160px] truncate text-foreground font-semibold">
              {projectName}
            </span>
          ) : (
            <span>Open project</span>
          )}
        </button>

        {projectDropdownOpen && messages.length === 0 && (
          <div
            className="absolute right-0 top-full mt-1 z-30 w-52 rounded-lg border border-border bg-card shadow-lg py-1"
            onClick={e => e.stopPropagation()}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
              onClick={() => { handleOpenProject(); setProjectDropdownOpen(false); }}
            >
              Open project folder
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              onClick={() => {
                setActiveProject(null);
                setProjectPath(null);
                setProjectName(null);
                setProjectDropdownOpen(false);
              }}
            >
              Don&#39;t work in a project
            </button>
          </div>
        )}
      </div>

      {/* ── Live clock at top center ────────────────────────────────────── */}
      {clockTime && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-20 pointer-events-none select-none">
          <span className="text-xs text-muted-foreground/60 tabular-nums font-mono font-bold">
            {clockTime}
          </span>
        </div>
      )}

      {/* ── ChapterScrubber — right side, vertically centered ──────────── */}
      {scrubberChapters.length > 0 && (
        <div
          className="fixed right-4 top-1/2 -translate-y-1/2 z-10"
          style={{ top: "50%", transform: "translateY(-50%)" }}
        >
          <ChapterScrubber
            chapters={scrubberChapters}
            side="left"
            currentIndex={scrubberChapters.length - 1}
            onSelect={(_, index) => {
              const doneMessages = messages.filter((m) => m.done);
              const target = doneMessages[index];
              if (!target) return;
              const el = document.getElementById(`msg-${target.id}`);
              el?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          />
        </div>
      )}

      {/* ── Inner scrollable area (no scrollbar) ───────────────────────── */}
      <div
        className="chat-scroll-area"
        style={{ height: "100dvh", overflowY: "auto" }}
      >
        {/* ── Welcome state ────────────────────────────────────────────── */}
        {messages.length === 0 && (
          <div className="chat-welcome">
            <img
              src="/calvras-logo.png"
              alt="Calvras"
              className="h-14 w-14 rounded-xl object-contain mb-4 mx-auto"
            />
            <h1 className="text-3xl font-bold tracking-tight text-foreground">What should Calvras build?</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Describe a component, an app, or an edit. Calvras creates folders and writes real code directly on your Desktop.
            </p>
          </div>
        )}

        {/* ── Chat history ─────────────────────────────────────────────── */}
        <div className="chat-history" aria-label="Conversation" aria-live="polite">
          {messages.map((message, index) => (
            <div
              key={message.id}
              id={`msg-${message.id}`}
              ref={index === messages.length - 1 ? latestMessageRef : undefined}
              className="flex scroll-mt-8 flex-col gap-6"
            >
              {/* User message bubble */}
              <div className="flex justify-end">
                <div className="flex flex-col items-end gap-2 max-w-[85%]">
                  {/* Attachments shown above/below text depending on whether there's text */}
                  {message.attachments && message.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 justify-end">
                      {message.attachments.map((att, i) => (
                        <AttachmentPreview key={i} att={att} />
                      ))}
                    </div>
                  )}
                  {/* Only show text bubble if there's text */}
                  {message.text && (
                    <UserMessageBubble text={message.text} />
                  )}
                </div>
              </div>

              {/* Agent Trace & Response */}
              <AgentWorkflow
                phases={message.phases}
                tools={CUSTOM_TOOLS}
                isComplete={message.done}
                workingLabel="Calvras is working..."
              />

              {/* "View Plan" pill — only shown when this message has an associated plan */}
              {message.done && activePlan && activePlan.messageId === message.id && (
                <div className="flex items-center gap-2 mt-1">
                  <button
                    type="button"
                    onClick={() => setPlanPanelOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-3 py-1 text-[12px] font-medium text-primary hover:bg-primary/10 active:scale-[0.97] transition-all duration-150 cursor-pointer"
                  >
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.4"/>
                      <path d="M4.5 5h5M4.5 7h5M4.5 9h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    </svg>
                    View Plan
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Spacer for composer */}
        <div style={{ height: "2rem" }} />
      </div>

      {/* ── Dev server running banner ────────────────────────────────────── */}
      {devServerUrl && (
        <div className="fixed bottom-[7rem] left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-1.5 text-[12px] font-medium text-emerald-600 dark:text-emerald-400 shadow-sm backdrop-blur-md">
          <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
          Server running —{" "}
          <a
            href={devServerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-emerald-500 transition-colors"
          >
            {devServerUrl}
          </a>
          <button
            type="button"
            onClick={() => setDevServerUrl(null)}
            className="ml-1 text-emerald-500/60 hover:text-emerald-500 transition-colors"
            aria-label="Dismiss"
          >
            <X className="size-3" />
          </button>
        </div>
      )}

      {/* ── Chat Composer ────────────────────────────────────────────────── */}
      <div className="chat-composer">
        <PromptInput
          onSubmit={handleSubmit}
          isThinking={isLoading}
          onStop={handleStop}
          placeholder="Describe a task or /command..."
        />
      </div>

      {/* ── Implementation Plan slide-out panel ──────────────────────────── */}
      {/* Backdrop */}
      {planPanelOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/40 backdrop-blur-sm"
          onClick={() => setPlanPanelOpen(false)}
          aria-hidden="true"
        />
      )}
      {/* Panel */}
      <div
        className={cn(
          "fixed top-0 right-0 z-50 h-full w-full max-w-[520px] bg-card border-l border-border shadow-2xl flex flex-col",
          "transition-transform duration-300 ease-[cubic-bezier(0.25,1,0.5,1)]",
          planPanelOpen ? "translate-x-0" : "translate-x-full"
        )}
        aria-modal="true"
        role="dialog"
        aria-label="Implementation Plan"
      >
        {/* Panel header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4 shrink-0">
          <div className="flex items-center gap-2.5">
            <svg width="16" height="16" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="text-primary">
              <rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.4"/>
              <path d="M4.5 5h5M4.5 7h5M4.5 9h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            <span className="text-sm font-semibold text-foreground">
              {activePlan?.title || "Implementation Plan"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setPlanPanelOpen(false)}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/60 active:scale-[0.92] transition-colors"
            aria-label="Close plan panel"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Plan content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 text-[13.5px] leading-relaxed text-foreground/90 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {activePlan?.content ? (
            <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed select-text">{activePlan.content}</pre>
          ) : (
            <p className="text-muted-foreground italic">No plan available.</p>
          )}
        </div>

        {/* Footer: Proceed button */}
        <div className="shrink-0 border-t border-border px-5 py-4 flex items-center justify-between gap-3">
          <p className="text-[11.5px] text-muted-foreground">
            Tell Calvras to proceed when you're ready.
          </p>
          <button
            type="button"
            onClick={() => {
              setPlanPanelOpen(false);
              // Submit "Proceed with the implementation plan" as the next message
              handleSubmit("Proceed with the implementation plan as outlined. Follow it exactly step by step.");
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-xs hover:bg-primary/90 active:scale-[0.97] transition-all duration-150 cursor-pointer"
          >
            Proceed
          </button>
        </div>
      </div>
    </main>
  );
}
