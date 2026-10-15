import { marketingHead } from "@/lib/marketing-seo";
import { LandingPage } from "@/components/LandingPage";
import { AgentActivity } from "@/components/AgentActivity";
import { runAgent, type AgentAction, type ToolFeedback } from "@/lib/agent-run";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { PromptInput } from "@/components/ui/ai-chat-input";
import {
  type AgentPhase,
  type TraceNode,
} from "@/components/ui/ai-agent-response";
import { useProjects } from "@/lib/project-context";
import { callAI, type MediaAttachment } from "@/lib/gemini";
import { cn } from "@/lib/utils";
import { ChapterScrubber, type Chapter } from "@/components/ui/chapter-scrubber";
import { Copy, CheckCheck, X } from "lucide-react";
import { DOWNLOAD } from "@/lib/download";
import { isNewerSemver } from "@/lib/version";

export const Route = createFileRoute("/")({
  head: () => marketingHead("/", "Calvras", "Build real projects with Calvras, a Windows x64 desktop AI coding agent for local files, commands, and visible change review."),
  component: LandingPage,
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
  attachments?: AttachedFile[] | undefined;
  phases: AgentPhase[];
  done: boolean;
  status?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  role: "user" | "assistant";
}

interface ImplementationPlan {
  title: string;
  content: string;
  messageId: number;
}

interface UpdateInfo {
  version: string;
  url: string;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * HELPERS
 * ─────────────────────────────────────────────────────────────────────────────
 */

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
      aria-label={copied ? "Copied" : "Copy prompt"}
      title={copied ? "Copied!" : "Copy"}
      className="flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/60 active:scale-[0.92] transition-opacity duration-150 mt-1 self-end opacity-0 group-hover:opacity-100 cursor-pointer"
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
      <div className="group flex flex-col items-end gap-0.5">
        <div className="break-words rounded-2xl bg-muted px-4 py-2.5 text-sm leading-relaxed text-foreground shadow-xs select-text">
          {text}
        </div>
        {copyButton}
      </div>
    );
  }

  return (
    <div className="group flex flex-col items-end gap-0.5">
      <div
        ref={bubbleRef}
        onClick={() => setIsExpanded((prev) => !prev)}
        title={isExpanded ? "Click to fold message" : "Click to expand message"}
        className={cn(
          "relative break-words rounded-2xl bg-muted text-foreground shadow-xs transition-all duration-200 cursor-pointer select-text",
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
 * PLAN PANEL CONTENT — rich structured renderer
 * ─────────────────────────────────────────────────────────────────────────────
 */
function PlanPanelContent({ content }: { content: string }) {
  // Parse markdown into sections by ## headers
  const lines = content.split('\n');
  const sections: { title: string; items: string[] }[] = [];
  let currentSection: { title: string; items: string[] } | null = null;
  let preamble: string[] = [];

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    const h1 = line.match(/^#\s+(.+)/);
    if (h1 && !currentSection) {
      preamble.push(line.replace(/^#+\s+/, '').trim());
      continue;
    }
    if (h2) {
      if (currentSection) sections.push(currentSection);
      currentSection = { title: line.replace(/^#+\s+/, '').trim(), items: [] };
    } else if (currentSection) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.match(/^#+/)) {
        currentSection.items.push(trimmed);
      }
    } else {
      const trimmed = line.trim();
      if (trimmed && !trimmed.match(/^#+/)) preamble.push(trimmed);
    }
  }
  if (currentSection) sections.push(currentSection);

  const phaseColors = [
    { badge: 'bg-blue-500/15 text-blue-400 border-blue-500/30', dot: '#3b82f6', line: '#3b82f620' },
    { badge: 'bg-violet-500/15 text-violet-400 border-violet-500/30', dot: '#8b5cf6', line: '#8b5cf620' },
    { badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', dot: '#10b981', line: '#10b98120' },
    { badge: 'bg-orange-500/15 text-orange-400 border-orange-500/30', dot: '#f97316', line: '#f9731620' },
    { badge: 'bg-pink-500/15 text-pink-400 border-pink-500/30', dot: '#ec4899', line: '#ec489920' },
  ];

  const renderItem = (raw: string, idx: number, totalItems: number, dotColor: string) => {
    const text = raw.replace(/^[-*•]\s+/, '').replace(/^\d+\.\s+/, '');
    const isFilePath = /`[^`]*[\/\\][^`]*`/.test(text) || /\.(tsx?|jsx?|css|json|ts|js|md)/.test(text);
    const parts = text.split(/(`[^`]+`)/);

    return (
      <div key={idx} className="flex items-start gap-2 relative" style={{minHeight: 22}}>
        <div className="relative flex flex-col items-center" style={{width: 16, minHeight: 22}}>
          {idx > 0 && (
            <svg width="16" height="10" style={{position: 'absolute', top: -10, left: 0}} aria-hidden="true">
              <line x1="8" y1="0" x2="8" y2="10" stroke={dotColor} strokeWidth="1.5" strokeOpacity="0.35" />
            </svg>
          )}
          <svg width="16" height="16" style={{flexShrink: 0, marginTop: 3}} aria-hidden="true">
            <circle cx="8" cy="8" r="3" fill={dotColor} fillOpacity="0.85" />
          </svg>
          {idx < totalItems - 1 && (
            <svg width="16" height="100%" style={{flex: 1, minHeight: 8}} aria-hidden="true">
              <line x1="8" y1="0" x2="8" y2="100%" stroke={dotColor} strokeWidth="1.5" strokeOpacity="0.25" />
            </svg>
          )}
        </div>
        <div className="flex-1 min-w-0 pb-1.5">
          <span className={cn('text-[12.5px] leading-relaxed break-words', isFilePath ? 'text-foreground/80' : 'text-foreground/75')}>
            {parts.map((part, pi) =>
              part.startsWith('`') && part.endsWith('`') ? (
                <code
                  key={pi}
                  className="mx-0.5 rounded px-1 py-0.5 text-[11px] font-mono bg-muted/60 border border-border/40 text-primary/90"
                >
                  {part.slice(1, -1)}
                </code>
              ) : (
                <span key={pi}>{part}</span>
              )
            )}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-5 pb-4">
      {preamble.length > 0 && (
        <div className="rounded-xl border border-border/40 bg-muted/20 px-4 py-3">
          {preamble.map((line, i) => (
            <p key={i} className="text-[13px] text-foreground/70 leading-relaxed">{line}</p>
          ))}
        </div>
      )}

      {sections.map((section, si) => {
        const color = phaseColors[si % phaseColors.length];
        const phaseNum = si + 1;
        const visibleItems = section.items.filter(item => {
          const t = item.replace(/^[-*•]\s+/, '').replace(/^\d+\.\s+/, '').trim();
          return t.length > 0;
        });

        return (
          <div key={si} className="rounded-xl border border-border/50 bg-card/40 overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-border/30 bg-muted/10">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true" className="shrink-0 opacity-70">
                <rect x="2" y="3" width="11" height="13" rx="2" stroke="currentColor" strokeWidth="1.3" />
                <rect x="5" y="1" width="11" height="13" rx="2" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.3" />
                <path d="M7 6h6M7 8.5h6M7 11h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
              </svg>
              <span className={cn('text-[11px] font-semibold rounded-full border px-2 py-0.5 shrink-0', color.badge)}>
                Phase {phaseNum}
              </span>
              <span className="text-[12.5px] font-semibold text-foreground/90 truncate">{section.title}</span>
            </div>

            {visibleItems.length > 0 && (
              <div className="px-4 py-3 space-y-0">
                {visibleItems.map((item, ii) => renderItem(item, ii, visibleItems.length, color.dot))}
              </div>
            )}
          </div>
        );
      })}

      {sections.length === 0 && preamble.length === 0 && (
        <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed select-text text-foreground/80">{content}</pre>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * COMPONENT
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function Index() {
  // Expose global new chat handler for Electron shortcut
  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as any).__calvrasNewChat = () => {
        setMessages([]);
        setActivePlan(null);
      };
    }
    return () => {
      if (typeof window !== "undefined") delete (window as any).__calvrasNewChat;
    };
  }, []);
  const { activeProject, setActiveProject, addProject, addRecent, deleteProject, renameProject, newChatSignal } = useProjects();
  const [messages, setMessages] = useState<Message[]>([]);
  const [projectPath, setProjectPath] = useState<string | null>(activeProject?.path || null);
  const [projectName, setProjectName] = useState<string | null>(activeProject?.name || null);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingFolder, setPendingFolder] = useState<File[] | null>(null);
  const [folderError, setFolderError] = useState("");
  const [importing, setImporting] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => { abortControllerRef.current?.abort(); }, []);
  const latestMessageRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Effort level: "Low" | "Medium" | "Max Effort"
  const [effortLevel, setEffortLevel] = useState<string>("Medium");

  // Implementation plan slide-out panel
  const [activePlan, setActivePlan] = useState<ImplementationPlan | null>(null);
  const [planPanelOpen, setPlanPanelOpen] = useState(false);

  // Live clock
  // Update check: button ONLY appears when a newer version is released
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    let mounted = true;
    async function checkForUpdates() {
      try {
        const res = await fetch("https://api.github.com/repos/SHIKARI-hey/Calvras/releases/latest", {
          headers: { Accept: "application/vnd.github.v3+json" },
        });
        if (!res.ok) return;
        const data = await res.json();
        const latestTag = (data.tag_name || "").replace(/^v/i, "").trim();
        const currentVersion = DOWNLOAD.version;
        if (latestTag && isNewerSemver(latestTag, currentVersion)) {
          if (mounted) {
            setUpdateInfo({
              version: latestTag,
              url: data.html_url || "https://calvras.com",
            });
          }
        } else {
          if (mounted) setUpdateInfo(null);
        }
      } catch {
        // Offline or fetch failure: do not show update button
      }
    }

    checkForUpdates();
    const interval = setInterval(checkForUpdates, 30 * 60 * 1000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
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

  // Storage keys for persisting conversation across page refresh
  const CHAT_STORAGE_KEY = "calvras_chat_messages";
  const PLAN_STORAGE_KEY = "calvras_active_plan";

  // Hydrate messages & plan from localStorage on client mount
  const hasHydratedRef = useRef(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CHAT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed.map((message: Message) => ({
            ...message, done: true,
            phases: (message.phases || []).map((phase) => ({ ...phase, trace: (phase.trace || []).filter((node) => node.type !== "reasoning" && node.type !== "step") })),
          })));
        }
      }
      const savedPlan = localStorage.getItem(PLAN_STORAGE_KEY);
      if (savedPlan) {
        const parsedPlan = JSON.parse(savedPlan);
        if (parsedPlan && typeof parsedPlan === "object") {
          setActivePlan(parsedPlan);
        }
      }
    } catch (e) {
      console.warn("Failed to restore chat from localStorage:", e);
    } finally {
      hasHydratedRef.current = true;
    }
  }, []);

  // Persist messages to localStorage whenever they update (after hydration)
  useEffect(() => {
    if (!hasHydratedRef.current) return;
    try {
      if (messages.length > 0) {
        // Strip out huge data: URLs from attachments to stay well within localStorage 5MB quota
        const safeMessages = messages.map((m) => ({
          ...m,
          attachments: m.attachments?.map((a) => ({
            ...a,
            url: a.url && a.url.startsWith("data:") ? "" : a.url,
          })),
        }));
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(safeMessages));
      } else {
        localStorage.removeItem(CHAT_STORAGE_KEY);
      }
    } catch (e) {
      console.warn("Failed to persist chat:", e);
    }
  }, [messages]);

  // Persist activePlan to localStorage
  useEffect(() => {
    if (!hasHydratedRef.current) return;
    try {
      if (activePlan) {
        localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(activePlan));
      } else {
        localStorage.removeItem(PLAN_STORAGE_KEY);
      }
    } catch {}
  }, [activePlan]);

  // Handle New Chat signal
  const prevSignalRef = useRef(newChatSignal);
  useEffect(() => {
    if (newChatSignal !== prevSignalRef.current) {
      prevSignalRef.current = newChatSignal;
      setMessages([]);
      setActivePlan(null);
      try {
        localStorage.removeItem(CHAT_STORAGE_KEY);
        localStorage.removeItem(PLAN_STORAGE_KEY);
      } catch {}
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

  // Auto-scroll while AI is typing
  useEffect(() => {
    if (!isLoading) return;
    scrollAreaRef.current?.scrollTo({ top: scrollAreaRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isLoading]);

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
              endedAt: Date.now(),
              status: "stopped",
              phases: [...m.phases.map((phase) => ({ ...phase, trace: phase.trace.map((node) => node.status === "running" ? { ...node, status: "failed" as const, output: "Stopped waiting. A command already started on the server may still run." } : node) }))],
            }
          : m
      )
    );
  }, []);

  // Get project context snapshot
  const getProjectContextString = useCallback(async (activePath: string): Promise<string> => {
    try {
      const res = await fetch(`/api/fs/tree?projectPath=${encodeURIComponent(activePath)}`);
      if (!res.ok) return "Workspace access failed. Do not infer that this folder is empty.";
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.files)) return `Workspace access failed: ${data.error || "invalid folder response"}.`;
      if (data.files.length === 0) {
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
        ...(projectPath ? { projectPath } : {}),
        ...(projectName ? { projectName } : {}),
      });

      // Auto-create project folder if needed
      let activePath = projectPath;
      let activeName = projectName;

      // Build conversation history for full memory
      const conversationHistory = messages
        .filter((m) => m.done)
        .flatMap((m) => [
          { role: "user" as const, content: m.text || "(attachment)" },
          {
            role: "assistant" as const,
            content: m.phases.map((phase) => [phase.message, ...phase.trace.map((node) => JSON.stringify({ action: node.primary, path: node.secondary, output: node.output, exitCode: node.exitCode, status: node.status, details: node.details }))].filter(Boolean).join("\n")).join("\n\n"),
          },
        ]);

      // Add the initial thinking phase — clean live indicator without fake or hardcoded sentences
      const msgId = Date.now();

      const initialThinkingPhase: AgentPhase = {
        trace: [],
      };

      setMessages((prev) => [
        ...prev,
        {
          id: msgId,
          text,
          attachments: attachedForBubble.length > 0 ? attachedForBubble : undefined,
          phases: [initialThinkingPhase],
          done: false,
          startedAt: msgId,
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
          .slice(-8)
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

      // Append real feedback and tool states in the order they arrive.
      const phases: AgentPhase[] = [];
      const publish = () => {
        if (controller.signal.aborted) return;
        setMessages((previous) => previous.map((message) => message.id === msgId ? { ...message, phases: phases.map((phase) => ({ ...phase, trace: [...phase.trace] })) } : message));
      };
      const outcome = await runAgent({
        prompt: fullPrompt,
        requiresTools: !/^(how|what|why|explain)\b/i.test(text) && /\b(check|inspect|read|edit|fix|build|create|implement|run|deploy|search|update)\b/i.test(text),
        signal: controller.signal,
        infer: (prompt) => callAI(prompt, undefined, mediaList, projectSnapshot, controller.signal),
        onFeedback: (message) => { phases.push({ trace: [], message }); publish(); },
        execute: async (actions) => {
          // Publish immediately so the UI shows a running spinner at once
          const workingPhase: AgentPhase = { trace: [] };
          phases.push(workingPhase);
          publish();
          if (!activePath) {
            const canCreate = actions.some((action) => action.type === "create_file" || action.type === "write_file") && !actions.some((action) => action.type === "read_file" || action.type === "list_dir");
            if (!canCreate) throw new Error("Select a project folder first so Calvras can inspect the actual files.");
            const response = await fetch("/api/fs/create-project", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: projectNameFrom(text) }), signal: controller.signal });
            const data = await response.json();
            if (!response.ok || !data.ok || !data.projectPath) throw new Error(data.error || "Could not create a workspace.");
            activePath = data.projectPath;
            activeName = data.name;
            setProjectPath(activePath);
            setProjectName(activeName);
            addProject({ name: data.name, path: data.projectPath });
          }
          const feedback: ToolFeedback[] = [];
          const routes: Record<AgentAction["type"], string> = {
            // File system — served under /api/fs/...
            create_file: "fs/create", write_file: "fs/write-file", read_file: "fs/read-file", list_dir: "fs/list-dir", run_command: "fs/command",
            rename_file: "fs/rename", delete_file: "fs/delete", copy_file: "fs/copy", get_file_info: "fs/stat",
            search_files: "fs/search", find_files: "fs/find-files",
            search_replace: "fs/search-replace",
            // Git — served under /api/git/...
            git_status: "git/status", git_diff: "git/diff", git_log: "git/log",
            git_add: "git/add", git_commit: "git/commit", git_checkout: "git/checkout",
            git_branch: "git/branch", git_restore: "git/restore", git_push: "git/push", git_clone: "git/clone",
            // Build & run — served under /api/run/...
            run_build: "run/build", run_tests: "run/test", run_lint: "run/lint",
            run_typecheck: "run/typecheck", install_deps: "run/install",
          };
          const labels: Record<AgentAction["type"], string> = {
            create_file: "Create file", write_file: "Write file", read_file: "Read file", list_dir: "List directory", run_command: "Run command",
            rename_file: "Rename file", delete_file: "Delete file", copy_file: "Copy file", get_file_info: "File info",
            search_files: "Search files", find_files: "Find files",
            search_replace: "Search & replace",
            git_status: "Git status", git_diff: "Git diff", git_log: "Git log",
            git_add: "Git add", git_commit: "Git commit", git_checkout: "Git checkout",
            git_branch: "Git branch", git_restore: "Git restore", git_push: "Git push", git_clone: "Git clone",
            run_build: "Run build", run_tests: "Run tests", run_lint: "Run lint",
            run_typecheck: "Type check", install_deps: "Install dependencies",
          };
          for (const action of actions) {
            controller.signal.throwIfAborted();
            const isTerminal = action.type === "run_command" || action.type.startsWith("git_") || action.type.startsWith("run_") || action.type === "install_deps";
            const node: TraceNode = { id: crypto.randomUUID(), type: isTerminal ? "terminal" : "tool", primary: labels[action.type], secondary: action.command || action.path || action.from || action.url || ".", status: "running", ...(isTerminal ? { command: action.command ?? action.message ?? action.branch ?? action.url ?? action.type } : {}) };
            workingPhase.trace.push(node);
            publish();
            const started = Date.now();
            try {
              const response = await fetch(`/api/${routes[action.type]}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...action, projectPath: activePath }),
                signal: isTerminal
                  ? AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)])
                  : controller.signal,
              });
              const data = await response.json();
              const ok = response.ok && data.ok === true && (action.type !== "run_command" || data.exitCode === 0);
              node.status = ok ? "completed" : "failed";
              node.durationMs = Date.now() - started;
              if (isTerminal) {
                // run_command returns exitCode; git/run routes return output string
                node.exitCode = data.exitCode ?? (data.ok ? 0 : 1);
                node.output = data.output || data.error || "";
              } else if (data.content !== undefined) {
                node.output = data.content;
              } else if (Array.isArray(data.results)) {
                // search_files: array of { file, line, text }
                node.output = data.results.map((r: { file: string; line: number; text: string }) => `${r.file}:${r.line}: ${r.text}`).join("\n");
              } else if (Array.isArray(data.files)) {
                // find_files: array of file path strings
                node.output = data.files.join("\n");
              } else if (Array.isArray(data.entries)) {
                node.output = data.entries.map((entry: { name: string; type: string }) => `${entry.type}: ${entry.name}`).join("\n");
              } else {
                node.output = data.error || JSON.stringify(data);
              }
              feedback.push({ action, ok, result: data });
              publish();
            } catch (error) {
              node.status = "failed";
              node.durationMs = Date.now() - started;
              node.output = controller.signal.aborted ? "Stopped waiting for this action. A command already started on the server may still run." : error instanceof Error ? error.message : "Action failed.";
              if (!controller.signal.aborted) { feedback.push({ action, ok: false, result: { error: node.output } }); publish(); }
              else throw error;
            }
          }
          return feedback;
        },
      });
      if (abortControllerRef.current !== controller) return;
      if (outcome.plan) setActivePlan({ title: "Implementation Plan", content: outcome.plan, messageId: msgId });
      if (outcome.message) phases.push({ trace: [], message: outcome.message });
      setMessages((previous) => previous.map((message) => message.id === msgId ? { ...message, phases, done: true, status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}), endedAt: Date.now() } : message));
      setIsLoading(false);
      abortControllerRef.current = null;
    },
    [projectPath, projectName, isLoading, addProject, addRecent, getProjectContextString, messages]
  );
  // ── Open / Switch Project Folder — uses native file system picker ──────────
  const handleOpenProject = useCallback(() => {
    if (messages.length > 0) return;
    const input = document.createElement("input");
    input.type = "file";
    input.setAttribute("webkitdirectory", "");
    input.onchange = () => {
      const files = Array.from(input.files || []).filter((file) =>
        !file.webkitRelativePath.split("/").some((part) => ["node_modules", ".git", ".env"].includes(part) || part.startsWith(".env."))
      );
      setFolderError("");
      if (files.length) setPendingFolder(files);
    };
    input.click();
  }, [messages.length]);

  const confirmFolder = async () => {
    if (!pendingFolder || importing) return;
    setImporting(true);
    setFolderError("");
    try {
      if (pendingFolder.length > 2000 || pendingFolder.reduce((total, file) => total + file.size, 0) > 50 * 1024 * 1024) throw new Error("Choose a folder with up to 2,000 files and 50 MB.");
      const form = new FormData();
      form.append("name", pendingFolder[0]?.webkitRelativePath.split("/")[0] || "project");
      pendingFolder.forEach((file) => form.append("files", file, file.webkitRelativePath));
      const response = await fetch("/api/fs/import", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Unable to import folder.");
      const project = { name: data.name, path: data.projectPath };
      setProjectPath(project.path);
      setProjectName(project.name);
      setActiveProject(project);
      addProject(project);
      setPendingFolder(null);
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : "Unable to import folder.");
    } finally { setImporting(false); }
  };
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

      <Dialog open={!!pendingFolder} onOpenChange={(open) => { if (!open && !importing) setPendingFolder(null); }}>
        <DialogContent className="max-w-[440px] rounded-2xl bg-card p-7">
          <DialogTitle className="text-center text-xl">Bring this folder into Calvras?</DialogTitle>
          <DialogDescription className="text-center leading-6">Calvras will work with an uploaded copy of your project. Your original folder stays on your computer.</DialogDescription>
          <div className="rounded-lg border bg-background px-4 py-3 text-center text-sm">{pendingFolder?.[0]?.webkitRelativePath.split("/")[0]}<span className="mt-1 block text-xs text-muted-foreground">{pendingFolder?.length} files · dependencies, Git data, and environment secrets excluded</span></div>
          <p className="text-center text-xs leading-5 text-muted-foreground">Only import projects you trust. Review generated commands before running them.</p>
          {folderError && <p role="alert" className="text-sm text-red-400">{folderError}</p>}
          <button disabled={importing} onClick={confirmFolder} className="auth-primary disabled:opacity-50">{importing ? "Importing folder…" : "Import and continue"}</button>
          <button disabled={importing} onClick={() => setPendingFolder(null)} className="rounded-lg border py-2.5 text-sm text-muted-foreground">Cancel</button>
        </DialogContent>
      </Dialog>
      {/* ── Top-right project badge & switcher ─────────────────────────── */}
      <div
        data-project-badge-wrapper=""
        className="fixed top-[32px] right-4 z-20 flex items-center gap-2"
      >
        {updateInfo && (
          <a
            href={updateInfo.url}
            target="_blank"
            rel="noopener noreferrer"
            title={`A new update is available: Calvras v${updateInfo.version}. Click to download.`}
            className="flex items-center rounded-lg border border-border/80 bg-[#2A2A2A] hover:bg-[#333333] px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-md transition-all shadow-xs cursor-pointer select-none"
          >
            Update
          </a>
        )}
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
              : "Upload a folder"
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
            <span>Upload a folder</span>
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
        ref={scrollAreaRef}
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
            <h1 className="text-[clamp(1.5rem,3vw,2rem)] font-normal tracking-tight text-foreground">Your next idea starts here.</h1>

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
              <AgentActivity phases={message.phases} done={message.done} startedAt={message.startedAt} endedAt={message.endedAt} status={message.status} error={message.error} />

              {/* Compact plan card — shown when this message has an associated plan */}
              {message.done && activePlan && activePlan.messageId === message.id && (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setPlanPanelOpen(true)}
                  onKeyDown={(e) => e.key === 'Enter' && setPlanPanelOpen(true)}
                  className="mt-2 max-h-[100px] overflow-hidden rounded-xl border border-border bg-card/60 px-4 py-3 cursor-pointer hover:bg-card transition-colors relative group"
                  aria-label="View implementation plan"
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="text-primary shrink-0">
                      <rect x="1.5" y="1.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.3"/>
                      <path d="M4 4.5h6M4 7h6M4 9.5h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    </svg>
                    <span className="text-xs font-semibold text-foreground">Implementation Plan</span>
                    <span className="ml-auto text-[10px] text-muted-foreground/60 group-hover:text-primary transition-colors">Click to expand →</span>
                  </div>
                  <p className="text-[11.5px] text-muted-foreground leading-relaxed line-clamp-3">{activePlan.content.slice(0, 200)}</p>
                  <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-card/80 to-transparent rounded-b-xl" />
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Spacer for composer — keeps AI response well away from input */}
        <div style={{ height: "180px" }} />
      </div>

      {/* ── Chat Composer ────────────────────────────────────────────────── */}
      <div className="chat-composer">
        <PromptInput
          onSubmit={(value, meta) => handleSubmit(value, meta?.files)}
          isThinking={isLoading}
          onStop={handleStop}
          placeholder="Describe a task or /command..."
        />
      </div>

      {/* ── Implementation Plan slide-out panel ──────────────────────────── */}
      {/* Backdrop */}
      {planPanelOpen && (
        <div
          className="fixed inset-0 z-40 bg-transparent pointer-events-auto"
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
            <PlanPanelContent content={activePlan.content} />
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


