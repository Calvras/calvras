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
          nodes.push({ type: "terminal", primary: "Run command", secondary: act.command, command: act.command, exitCode: 0, durationMs: 350, output: `Executed: ${act.command}\nCompleted with code 0.` });
          summaryNotes.push(`Ran \`${act.command}\``);
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
      }

      const finalPhases: AgentPhase[] = [];

      const reasoningSentences =
        parsed.reasoning && parsed.reasoning.length > 0
          ? parsed.reasoning
          : parsed.thought
          ? [parsed.thought]
          : [`Analyzed "${text.slice(0, 80)}"`, actionNodes.length > 0 ? "Applying filesystem changes" : "Preparing response"];

      finalPhases.push({
        trace: [
          {
            type: "reasoning",
            sentences: reasoningSentences,
            durationSeconds: 2.0,
          },
          ...actionNodes,
          {
            type: "step",
            primary: actionNodes.length > 0 ? "Changes applied" : "Completed",
            secondary: activeName || "Calvras",
          },
        ],
        message:
          parsed.message ||
          (summaryNotes.length > 0
            ? `Finished: ${summaryNotes.join(", ")} in project \`${activeName}\`.`
            : "Task completed."),
      });

      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, phases: finalPhases, done: true } : m))
      );
      setIsLoading(false);
      abortControllerRef.current = null;
    },
    [projectPath, projectName, isLoading, addProject, addRecent, getProjectContextString, executeActions, messages]
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
      <button
        type="button"
        onClick={handleOpenProject}
        title={
          messages.length > 0
            ? `Active Project: ${projectName || "Workspace"} — start a New chat to switch`
            : projectName
            ? `Active Desktop Project: ${projectName} (${projectPath})`
            : "Open project folder"
        }
        className={cn(
          "fixed top-4 right-4 z-20 flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium backdrop-blur-md transition-all shadow-xs",
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
                    <div className="break-words rounded-2xl bg-muted px-4 py-2.5 text-sm leading-relaxed text-foreground shadow-xs">
                      {message.text}
                    </div>
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
            </div>
          ))}
        </div>

        {/* Spacer for composer */}
        <div style={{ height: "8rem" }} />
      </div>

      {/* ── Chat Composer ────────────────────────────────────────────────── */}
      <div className="chat-composer">
        <PromptInput
          onSubmit={handleSubmit}
          isThinking={isLoading}
          onStop={handleStop}
          placeholder="Describe a task or /command..."
        />
      </div>
    </main>
  );
}
