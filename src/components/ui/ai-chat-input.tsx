"use client";

import * as React from "react";
import { useRef, useState, useEffect, useCallback } from "react";
import { readPreferences } from "@/lib/preferences";
import { AccessSelector, ComposerApproval, type ComposerRequest } from "./composer-access";
import type { AccessMode } from "@/lib/tool-catalog";
import { cn } from "@/lib/utils";
import { LinkifiedText } from "@/components/ui/markdown-content";
import { ArrowUpRight, ChevronDown, Globe, ListTodo, MessageSquare, RotateCcw, ScanSearch, Sparkles, SquarePen, SquareTerminal, Target } from "lucide-react";

// ----------------------------------------------------------------------
// Transition Physics
// ----------------------------------------------------------------------
const SPRING_TRANSITION = "max-width 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), height 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)";
const SMOOTH_HEIGHT_TRANSITION = "max-width 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), height 0.15s ease-out";

const DOCUMENT_EXTENSIONS = /\.(pdf|txt|md|markdown|json|csv|tsv|log|xml|yaml|yml|toml|ini|cfg|conf|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sql|sh|bash|zsh|bat|ps1|cmd|html|htm|css|scss|less|vue|svelte|graphql|prisma)$/i;
const ATTACHMENT_ACCEPT = "image/*,.pdf,.txt,.md,.markdown,.json,.csv,.tsv,.log,.xml,.yaml,.yml,.toml,.ini,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.cs,.php,.sql,.sh,.bat,.ps1,.html,.css,.scss,.vue,.svelte";

function classifyAttachment(file: File): "image" | "document" | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type === "application/pdf" || file.type.startsWith("text/") || ["application/json", "application/xml", "application/yaml", "application/javascript", "application/typescript"].includes(file.type)) return "document";
  if (DOCUMENT_EXTENSIONS.test(file.name)) return "document";
  return null;
}

// ----------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------
interface Attachment {
  id: string;
  file: File;
  url: string;
  name: string;
  width?: number;
  height?: number;
  kind: "image" | "document";
}

// ----------------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------------
function MorphingText({ text }: { text: string }) {
  const [width, setWidth] = useState<number | "auto">("auto");
  const spanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (spanRef.current) {
      setWidth(spanRef.current.offsetWidth);
    }
  }, [text]);

  return (
    <span
      className="relative inline-flex items-center justify-center overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)]"
      style={{ width }}
    >
      <span ref={spanRef} className="invisible whitespace-nowrap px-1">
        {text}
      </span>
      <span
        key={text}
        className="absolute inset-0 flex items-center justify-center whitespace-nowrap animate-in fade-in zoom-in-95 duration-300"
      >
        {text}
      </span>
    </span>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 12V2M7 2L2.5 6.5M7 2L11.5 6.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="5" y="1" width="4" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.75 6.5V7a4.25 4.25 0 0 0 8.5 0v-.5M7 11.25V13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function ScreenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="11" height="7.5" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 12.5h4M7 10v2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="7" cy="6.25" r="1.3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 2.5V11.5M2.5 7H11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon({ withPlus = false }: { withPlus?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M1.5 4.2c0-.66.54-1.2 1.2-1.2h2.3c.32 0 .62.12.85.35l.7.7h4.75c.66 0 1.2.54 1.2 1.2v5.1c0 .66-.54 1.2-1.2 1.2H2.7c-.66 0-1.2-.54-1.2-1.2V4.2Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      {withPlus ? <path d="M7 6.6v3.1M5.45 8.15h3.1" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" /> : <path d="M1.5 5.4h11" stroke="currentColor" strokeWidth="1.25" />}
    </svg>
  );
}

type SlashCommand = {
  id: string;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Hidden instruction prepended to the agent prompt; the composer only shows a chip. */
  directive?: string;
  /** Panel action handled by the host route (no chip, no text). */
  action?: boolean;
};

// Directive commands drop a removable chip in the composer — the user types their own
// request after it and the hidden `directive` rides along to the agent, never shown as a
// sentence in the bubble. Panel commands just open their dock.
const SLASH_COMMANDS: SlashCommand[] = [
  { id: "goal", label: "Goal", hint: "Set what you want done", icon: Target, directive: "This is your goal for the task. Treat the user's message as the outcome to achieve and carry it through to a verified, working result — don't stop partway." },
  { id: "plan", label: "Plan", hint: "Outline the steps, then build", icon: Sparkles, directive: "Take a careful look first: inspect the workspace, lay out a short plan, then start. Don't stop at the plan — carry it through and verify the result." },
  { id: "review", label: "Review", hint: "Check what's broken and fix it", icon: ScanSearch, directive: "Review this workspace for anything broken, unfinished, or inconsistent. Fix what you find, then verify it actually works." },
  { id: "continue", label: "Continue", hint: "Pick up where we left off", icon: RotateCcw, directive: "Continue from where we stopped. Check the current files and any unfinished work, then keep going without repeating finished steps." },
  { id: "new-chat", label: "Start fresh", hint: "Clear this conversation", icon: SquarePen, action: true },
  { id: "tasks", label: "Show what's happening", hint: "Open the task and environment panel", icon: ListTodo, action: true },
  { id: "sidechat", label: "Open side chat", hint: "Ask questions while the agent works", icon: MessageSquare, action: true },
  { id: "terminal", label: "Open the terminal", hint: "Run commands in this folder", icon: SquareTerminal, action: true },
  { id: "browser", label: "Open the browser panel", hint: "See the app you're building", icon: Globe, action: true },
];

function CloseIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2.5 2.5L11.5 11.5M11.5 2.5L2.5 11.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function DynamicBarsIcon({ level }: { level: string }) {
  const isMediumOrHigh = level === "Medium" || level === "Max Effort" || level === "Balanced" || level === "Thorough";
  const isHigh = level === "Max Effort" || level === "Thorough";

  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="8" width="2.5" height="4.5" rx="1" fill="currentColor" className="transition-opacity duration-300" opacity={1} />
      <rect x="5.75" y="5" width="2.5" height="7.5" rx="1" fill="currentColor" className="transition-opacity duration-300" opacity={isMediumOrHigh ? 1 : 0.3} />
      <rect x="10" y="2" width="2.5" height="10.5" rx="1" fill="currentColor" className="transition-opacity duration-300" opacity={isHigh ? 1 : 0.3} />
    </svg>
  );
}

// ----------------------------------------------------------------------
// Attachment Thumbnail
// ----------------------------------------------------------------------
function AttachmentThumb({
  attachment,
  index,
  onRemove,
  onOpen,
  registerRef,
}: {
  attachment: Attachment;
  index: number;
  onRemove: (id: string) => void;
  onOpen: (attachment: Attachment, rect: DOMRect) => void;
  registerRef: (id: string, el: HTMLButtonElement | null) => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  return (
    <button
      ref={(el) => {
        btnRef.current = el;
        registerRef(attachment.id, el);
      }}
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={(e) => {
        e.stopPropagation();
        if (btnRef.current) {
          onOpen(attachment, btnRef.current.getBoundingClientRect());
        }
      }}
      style={{ animationDelay: `${index * 35}ms`, animationFillMode: "backwards" }}
      className={cn(
        "group relative size-12 shrink-0 overflow-hidden rounded-xl border border-border bg-muted outline-none",
        "transition-transform duration-200 ease-[cubic-bezier(0.175,0.885,0.32,1.275)] hover:scale-[1.04] active:scale-[0.96]",
        "animate-in fade-in slide-in-from-top-3 zoom-in-90 duration-400"
      )}
      aria-label={`Open preview of ${attachment.name}`}
    >
      {attachment.kind === "image" ? (
        <img src={attachment.url} alt={attachment.name} className="size-full object-cover" draggable={false} />
      ) : (
        <span className="flex size-full flex-col items-center justify-center gap-0.5 px-1 text-muted-foreground">
          <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 1.5h5.5L13 5v9.5H4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M9.5 1.5V5H13M6 8.5h4M6 11h4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
          <span className="w-full truncate text-center text-[7.5px] font-semibold uppercase tracking-wide">
            {(attachment.name.split(".").pop() ?? "file").slice(0, 4)}
          </span>
        </span>
      )}
      <span className={cn("absolute inset-0 flex items-start justify-end bg-black/0 transition-colors duration-200", isHovered && "bg-black/25")}>
        <span
          role="button" tabIndex={-1}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => { e.stopPropagation(); onRemove(attachment.id); }}
          className={cn(
            "m-1 flex size-4 items-center justify-center rounded-full bg-background/90 text-foreground/70 shadow-sm transition-all duration-200 ease-[cubic-bezier(0.175,0.885,0.32,1.275)] hover:bg-background hover:text-foreground hover:scale-110",
            isHovered ? "opacity-100 scale-100" : "opacity-0 scale-50 pointer-events-none"
          )}
          aria-label={`Remove ${attachment.name}`}
        >
          <CloseIcon />
        </span>
      </span>
    </button>
  );
}

// ----------------------------------------------------------------------
// Shared-Element Gallery Modal
// ----------------------------------------------------------------------
function AttachmentGalleryModal({
  attachment,
  originRect,
  onClose,
}: {
  attachment: Attachment;
  originRect: DOMRect;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<"opening" | "open" | "closing">("opening");
  const [targetRect, setTargetRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
    radius: number;
  } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const maxW = Math.min(window.innerWidth * 0.86, 560);
    const maxH = Math.min(window.innerHeight * 0.78, 720);

    const naturalW = attachment.width || 800;
    const naturalH = attachment.height || 600;
    const scale = Math.min(maxW / naturalW, maxH / naturalH, 1.6);

    const width = naturalW * scale;
    const height = naturalH * scale;

    setTargetRect({
      top: (window.innerHeight - height) / 2,
      left: (window.innerWidth - width) / 2,
      width,
      height,
      radius: 20,
    });

    const raf = requestAnimationFrame(() => setPhase("open"));
    return () => cancelAnimationFrame(raf);
  }, [attachment]);

  const handleClose = useCallback(() => setPhase("closing"), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") handleClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [handleClose]);

  const isOpen = phase === "open";
  const isClosing = phase === "closing";

  const geometry = isOpen && targetRect
      ? targetRect
      : { top: originRect.top, left: originRect.left, width: originRect.width, height: originRect.height, radius: 12 };

  const animEasing = isClosing ? "ease-out" : "cubic-bezier(0.175, 0.885, 0.32, 1.275)";
  const animDur = isClosing ? "0.3s" : "0.45s";
  const flipTransition = `top ${animDur} ${animEasing}, left ${animDur} ${animEasing}, width ${animDur} ${animEasing}, height ${animDur} ${animEasing}, border-radius ${animDur} ${animEasing}`;

  return (
    <div className="fixed inset-0 z-[100]" onClick={handleClose} role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-background/70 backdrop-blur-md transition-opacity duration-400" style={{ opacity: isOpen ? 1 : 0 }} />
      <div
        style={{
          position: "fixed",
          top: geometry.top, left: geometry.left, width: geometry.width, height: geometry.height,
          borderRadius: geometry.radius, transition: flipTransition, overflow: "hidden",
          boxShadow: isOpen ? "0 24px 60px -12px rgb(0 0 0 / 0.35)" : "0 0px 0px 0px rgb(0 0 0 / 0)",
        }}
        className="bg-muted"
        onTransitionEnd={() => { if (phase === "closing") onClose(); }}
        onClick={(e) => e.stopPropagation()}
      >
        {attachment.kind === "image" ? (
          <img ref={imgRef} src={attachment.url} alt={attachment.name} className="size-full object-cover" draggable={false} />
        ) : (
          <span className="flex size-full flex-col items-center justify-center gap-4 p-6 text-center">
            <svg width="64" height="64" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="text-muted-foreground/60">
              <path d="M4 1.5h5.5L13 5v9.5H4z" stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round" />
              <path d="M9.5 1.5V5H13M6 8.5h4M6 11h4" stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round" />
            </svg>
            <span className="max-w-full truncate text-sm font-medium text-foreground">{attachment.name}</span>
          </span>
        )}
      </div>

      <button
        type="button" onClick={handleClose}
        style={{ opacity: isOpen ? 1 : 0, transform: isOpen ? "scale(1)" : "scale(0.7)" }}
        className={cn(
          "fixed right-4 top-4 flex size-9 items-center justify-center rounded-full bg-card/90 text-foreground/70 shadow-md backdrop-blur-sm",
          "transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)] hover:bg-card hover:text-foreground",
          !isOpen && "pointer-events-none"
        )}
      >
        <span className="scale-150"><CloseIcon /></span>
      </button>
    </div>
  );
}

// ----------------------------------------------------------------------
// Main Component
// ----------------------------------------------------------------------

export interface PromptInputProps {
  onSubmit?: (
    value: string,
    meta?: {
      effort: string;
      attachments: File[];
      files?: { type: string; url: string; name?: string }[];
      directive?: string;
    }
  ) => void;
  placeholder?: string;
  className?: string;
  efforts?: string[];
  defaultValue?: string;
  value?: string;
  onChange?: (value: string) => void;
  maxAttachments?: number;
  isThinking?: boolean;
  onStop?: () => void;
  accessMode?: AccessMode;
  onAccessModeChange?: (mode: AccessMode) => void;
  approval?: ComposerRequest | undefined;
  onApprovalDecision?: (choice: string) => void;
  /** The folder Calvras is working in, shown beneath the composer. */
  projectName?: string | null;
  projectPath?: string | null;
  folderBusy?: boolean;
  folderError?: string;
  onFolderFiles?: (files: File[]) => void;
  /** Electron only: open the native folder picker, which can see an empty folder. */
  onPickFolder?: (() => void) | undefined;
  /** A running chat keeps its folder, so changing it means starting a fresh one. */
  onNewChatWithFolder?: (() => void) | undefined;
  onClearFolder?: () => void;
  /** Once a chat has started its folder is fixed; clicking the badge does nothing. */
  folderLocked?: boolean;
  /** Messages the user sent while the agent was busy, stacked above the input. */
  queued?: { id: string; text: string }[];
  onSendQueuedNow?: (id: string) => void;
  onRemoveQueued?: (id: string) => void;
  /** Panel actions chosen from the slash menu. */
  onSlashAction?: (id: string) => void;
  /** Electron only: capture the desktop and attach it to the queued message. */
  onCaptureScreen?: () => Promise<{ file: File; name: string; type: string } | null>;
}

export const PromptInput = React.forwardRef<HTMLDivElement, PromptInputProps>(
  (
    {
      onSubmit,
      placeholder = "Ask anything",
      className,
      efforts = ["Quick", "Balanced", "Thorough"],
      defaultValue = "",
      value: controlledValue,
      onChange,
      maxAttachments = 6,
      isThinking = false,
      onStop,
      accessMode = "automatic", onAccessModeChange, approval, onApprovalDecision, onCaptureScreen,
      projectName = null, projectPath = null, folderBusy = false, folderError = "", onFolderFiles, onPickFolder, onNewChatWithFolder, onClearFolder, onSlashAction,
      folderLocked = false, queued = [], onSendQueuedNow, onRemoveQueued,
    },
    ref
  ) => {
    const [expanded, setExpanded] = useState(false);
    const [isSmoothResize, setIsSmoothResize] = useState(false);
    const [localValue, setLocalValue] = useState(defaultValue);
    const [effortIndex, setEffortIndex] = useState(1);
    useEffect(() => {
      const update = () => { const effort = readPreferences().effort; const index = efforts.indexOf(effort); if (index >= 0) setEffortIndex(index); };
      update(); window.addEventListener("calvras:preferences", update);
      return () => window.removeEventListener("calvras:preferences", update);
    }, [efforts.join(",")]);
    const [folderMenuOpen, setFolderMenuOpen] = useState(false);

    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [activeAttachment, setActiveAttachment] = useState<{ attachment: Attachment; rect: DOMRect } | null>(null);
    const [capturingScreen, setCapturingScreen] = useState(false);
    const [captureError, setCaptureError] = useState("");

    // Audio/Voice recording states
    const [isRecording, setIsRecording] = useState(false);
    const [audioData, setAudioData] = useState<number[]>(new Array(5).fill(0));
    const valueRef = useRef(controlledValue !== undefined ? controlledValue : localValue);

    // Refs for Web Audio & Speech Recognition cleanup
    const streamRef = useRef<MediaStream | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const rafRef = useRef<number | null>(null);
    const recognitionRef = useRef<any>(null);

    const [hoverStyle, setHoverStyle] = useState({ opacity: 0, transform: "translateY(0px) scale(0.95)", transition: "none" });
    const [containerHeight, setContainerHeight] = useState(116);
    const [textareaHeight, setTextareaHeight] = useState(68);
    const [isScrolling, setIsScrolling] = useState(false);

    const isControlled = controlledValue !== undefined;
    const value = isControlled ? controlledValue : localValue;
    const hasValue = value.trim() !== "" || attachments.length > 0;
    const hasAttachments = attachments.length > 0;
    const draftLink = value.match(/(?:https?:\/\/|www\.|localhost:|127\.0\.0\.1:)[^\s<>"']+/i)?.[0];
    const draftLinkHref = draftLink
      ? /^(localhost|127\.0\.0\.1):/i.test(draftLink) ? `http://${draftLink}`
      : /^www\./i.test(draftLink) ? `https://${draftLink}`
      : draftLink
      : undefined;

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const internalContainerRef = useRef<HTMLDivElement>(null);
    const topFadeRef = useRef<HTMLDivElement>(null);
    const bottomFadeRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);
    const thumbRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

    const [slashIndex, setSlashIndex] = useState(0);
    const [slashDismissed, setSlashDismissed] = useState(false);
    const [chip, setChip] = useState<{ id: string; label: string; directive: string; Icon: React.ComponentType<{ className?: string }> } | null>(null);
    const slashQuery = value.startsWith("/") ? value.slice(1).toLowerCase() : "";
    const slashCandidates = value.startsWith("/") && !value.includes("\n") && !value.slice(1).includes(" ")
      ? SLASH_COMMANDS.filter((command) => !slashQuery || `${command.label} ${command.hint} ${command.id}`.toLowerCase().includes(slashQuery))
      : [];
    const slashMenuOpen = expanded && !isThinking && !isRecording && !slashDismissed && slashCandidates.length > 0;
    useEffect(() => { setSlashIndex(0); }, [slashQuery]);
    useEffect(() => { if (!value.startsWith("/")) setSlashDismissed(false); }, [value]);

    // Sync value ref for audio callback closure
    useEffect(() => {
      valueRef.current = value;
    }, [value]);

    const updateFades = () => {
      const el = textareaRef.current;
      if (!el) return;
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (topFadeRef.current) {
        topFadeRef.current.style.opacity = Math.min(scrollTop / 20, 1).toString();
      }
      if (bottomFadeRef.current) {
        const bottomScroll = scrollHeight - clientHeight - scrollTop;
        bottomFadeRef.current.style.opacity = Math.min(Math.max(bottomScroll - 16, 0) / 10, 1).toString();
      }
    };

    const handleValueChange = useCallback((val: string) => {
      setIsSmoothResize(true); 
      if (!isControlled) setLocalValue(val);
      onChange?.(val);
    }, [isControlled, onChange]);

    const chooseSlash = useCallback((command: SlashCommand) => {
      setSlashDismissed(true);
      if (command.directive) {
        setChip({ id: command.id, label: command.label, directive: command.directive, Icon: command.icon });
        handleValueChange("");
        if (!expanded) { setIsSmoothResize(false); setExpanded(true); }
        requestAnimationFrame(() => { textareaRef.current?.focus(); });
        return;
      }
      handleValueChange("");
      onSlashAction?.(command.id);
    }, [handleValueChange, onSlashAction, expanded]);

    const expand = () => {
      setIsSmoothResize(false); 
      setExpanded(true);
    };

    // --- Voice Recording Logic (Real mic + Web Speech API) ---
    const stopRecording = useCallback(() => {
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch {}
        recognitionRef.current = null;
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (audioContextRef.current) {
        try { audioContextRef.current.close(); } catch {}
        audioContextRef.current = null;
      }
      setIsRecording(false);
      setAudioData(new Array(5).fill(0));
    }, []);

    const startRecording = useCallback(async () => {
      setIsSmoothResize(false);
      setExpanded(true);

      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

      if (!SpeechRecognition) {
        console.error("Speech Recognition API not supported in this environment.");
        handleValueChange("[Speech recognition is unavailable in this environment. Please type your message.]");
        return;
      }

      let stream: MediaStream | null = null;
      try {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
      } catch (err) {
        console.error("Microphone access denied:", err);
        handleValueChange("[Microphone access denied. Please grant microphone permissions and try again.]");
        return;
      }

      if (!stream) {
        handleValueChange("[No microphone input detected. Please connect a microphone and try again.]");
        return;
      }

      setIsRecording(true);
      streamRef.current = stream;

      // Web Audio API for frequency visualizer
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        const audioCtx = new AudioCtx();
        audioContextRef.current = audioCtx;

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64; 
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        const updateVisualizer = () => {
          analyser.getByteFrequencyData(dataArray);
          const bands = new Array(5).fill(0);
          const step = Math.floor(dataArray.length / 5);
          for (let i = 0; i < 5; i++) {
            let sum = 0;
            for (let j = 0; j < step; j++) {
              sum += dataArray[i * step + j] ?? 0;
            }
            bands[i] = sum / step / 255;
          }
          setAudioData(bands);
          rafRef.current = requestAnimationFrame(updateVisualizer);
        };
        updateVisualizer();
      } catch {}

      // Speech Recognition initialization
      try {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;

        let baseline = valueRef.current;

        recognition.onresult = (event: any) => {
          let interimTranscript = "";
          let finalTranscript = "";

          for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
              finalTranscript += event.results[i][0].transcript;
            } else {
              interimTranscript += event.results[i][0].transcript;
            }
          }
          
          if (finalTranscript) {
             baseline += (baseline ? " " : "") + finalTranscript;
          }
          
          handleValueChange((baseline + (interimTranscript ? " " + interimTranscript : "")).trim());
        };

        recognition.onerror = (e: any) => {
          console.error("Speech recognition error:", e);
          stopRecording();
        };

        recognition.onend = () => {
           stopRecording();
        };

        recognitionRef.current = recognition;
        recognition.start();
      } catch {
        stopRecording();
      }
    }, [handleValueChange, stopRecording]);

    // Keep textarea auto-scrolled to bottom while recording
    useEffect(() => {
      if (isRecording && textareaRef.current) {
        textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
      }
    }, [value, isRecording]);

    // Cleanup mic/streams on unmount
    useEffect(() => {
      return () => {
        stopRecording();
        attachments.forEach((a) => URL.revokeObjectURL(a.url)); 
      };
    }, [stopRecording, attachments]);

    useEffect(() => {
      if ((value.trim() !== "" || hasAttachments || chip) && !expanded) {
        setIsSmoothResize(false);
        setExpanded(true);
      }
    }, [value, expanded, hasAttachments, chip]);

    useEffect(() => {
      if (expanded && !isRecording) {
        const timer = setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.focus();
            const length = textareaRef.current.value.length;
            textareaRef.current.setSelectionRange(length, length);
          }
        }, 50);
        return () => clearTimeout(timer);
      }
      return undefined;
    }, [expanded, isRecording]);

    // Updates height on value/text change
    useEffect(() => {
      if (!textareaRef.current) return;
      const el = textareaRef.current;
      
      const currentHeight = el.style.height;
      el.style.transition = 'none';
      el.style.height = "0px";
      const scrollHeight = el.scrollHeight;
      el.style.height = currentHeight;
      void el.offsetHeight; 
      el.style.transition = '';
      
      const newHeight = Math.max(68, Math.min(scrollHeight, 160));
      el.style.height = `${newHeight}px`;
      
      setTextareaHeight(newHeight);
      setIsScrolling(scrollHeight > 160);
      
      setTimeout(updateFades, 0);
    }, [value, expanded]); 

    useEffect(() => {
      setContainerHeight(Math.max(116, textareaHeight + 48 + (chip ? 34 : 0)));
      setTimeout(updateFades, 0);
    }, [textareaHeight, chip]);

    const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
      if (internalContainerRef.current && internalContainerRef.current.contains(e.relatedTarget as Node)) return;
      if (value.trim() === "" && !hasAttachments && !isRecording) {
        setIsSmoothResize(false);
        setExpanded(false);
      }
    };

    const handleSubmit = async () => {
      if (value.trim() === "" && !hasAttachments) return;
      setIsSmoothResize(false);
      const files = attachments.map((a) => a.file);
      const attPreviews = await Promise.all(attachments.map(async (a) => ({
        type: a.file.type,
        url: await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Could not read the attachment.")); reader.readAsDataURL(a.file); }),
        name: a.name,
      })));
      onSubmit?.(value, {
        effort: efforts[effortIndex] || "Balanced",
        attachments: files,
        files: attPreviews,
        ...(chip ? { directive: chip.directive } : {}),
      });
      handleValueChange("");
      setChip(null);
      attachments.forEach((a) => URL.revokeObjectURL(a.url));
      setAttachments([]);
      setExpanded(false);
    };

    const cycleEffort = (e: React.MouseEvent) => {
      e.stopPropagation();
      setEffortIndex((prev) => (prev + 1) % efforts.length);
    };

    const openFileChooser = (e: React.MouseEvent) => {
      e.stopPropagation();
      fileInputRef.current?.click();
    };

    const captureScreen = async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!onCaptureScreen || capturingScreen) return;
      setCapturingScreen(true);
      setCaptureError("");
      try {
        const shot = await onCaptureScreen();
        if (shot) acceptFiles([shot.file]);
      } catch (error) {
        setCaptureError(error instanceof Error ? error.message : "The screen could not be captured.");
      } finally {
        setCapturingScreen(false);
      }
    };

    const acceptFiles = (incoming: File[]): boolean => {
      const files = incoming.filter((file) => classifyAttachment(file) !== null);
      if (files.length === 0) return false;
      const room = Math.max(0, maxAttachments - attachments.length);
      const accepted = files.slice(0, room);
      if (accepted.length === 0) return false;

      if (!expanded) { setIsSmoothResize(false); setExpanded(true); }
      else { setIsSmoothResize(true); }

      for (const file of accepted) {
        const url = URL.createObjectURL(file);
        const kind = classifyAttachment(file)!;
        if (kind === "image") {
          const img = new Image();
          img.onload = () => addAttachment(file, url, img.naturalWidth, img.naturalHeight, kind);
          img.onerror = () => addAttachment(file, url, 800, 600, kind);
          img.src = url;
        } else {
          addAttachment(file, url, 0, 0, kind);
        }
      }
      return true;
    };

    const handleFilesChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = "";
      acceptFiles(files);
    };

    const handleFolderChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = "";
      // An empty folder reports no files at all. Passing the empty list on is what lets the
      // app say so instead of swallowing the pick and looking dead.
      onFolderFiles?.(files);
    };

    // The native picker can see a folder with nothing in it; the browser's directory input
    // cannot, so it stays as the fallback for non-Electron builds.
    const chooseFolder = () => {
      if (onPickFolder) onPickFolder();
      else folderInputRef.current?.click();
    };

    const addAttachment = (file: File, url: string, width: number, height: number, kind: "image" | "document") => {
      const id = `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`;
      setAttachments((prev) => [...prev, { id, file, url, name: file.name, width, height, kind }]);
    };

    const removeAttachment = (id: string) => {
      setIsSmoothResize(true);
      setAttachments((prev) => {
        const target = prev.find((a) => a.id === id);
        if (target) URL.revokeObjectURL(target.url);
        return prev.filter((a) => a.id !== id);
      });
      thumbRefs.current.delete(id);
    };

    // Calculate action button states
    const showArrow = (hasValue || isThinking) && !isRecording;
    const showStop = isRecording || (isThinking && !hasValue);
    const showMic = !hasValue && !isRecording && !isThinking;

    const onActionButtonClick = (e: React.MouseEvent) => {
      e.preventDefault();
      if (isThinking && hasValue) {
        void handleSubmit();
      } else if (isThinking && onStop) {
        onStop();
      } else if (isRecording) {
        stopRecording();
      } else if (hasValue) {
        handleSubmit();
      } else {
        startRecording();
      }
    };

    if (approval) return <ComposerApproval request={approval} onDecision={(choice) => onApprovalDecision?.(choice)} onStop={onStop} />;

    return (
      <>
        {/* Outer Wrapper for positioning and max-width scaling */}
        <div
          ref={(node) => {
            if (typeof ref === "function") ref(node);
            else if (ref) (ref as any).current = node;
            // @ts-ignore
            internalContainerRef.current = node;
          }}
          onBlur={handleBlur}
          className={cn("relative flex flex-col w-full mx-auto", className)}
          style={{
            maxWidth: expanded ? 480 : 320,
            transition: isSmoothResize ? "max-width 0.15s ease-out" : "max-width 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            onChange={handleFilesChosen}
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            onChange={handleFolderChosen}
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          />

          {slashMenuOpen && (
            <div
              role="listbox"
              aria-label="Slash commands"
              className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-2xl border border-[#dfd6c8] bg-[#f5f0e8] text-[#1a1512] shadow-[0_18px_50px_-12px_rgba(0,0,0,0.45)] animate-in fade-in slide-in-from-bottom-2 duration-150"
            >
              <p className="px-3.5 pb-1.5 pt-3 text-[9px] font-semibold uppercase tracking-[0.16em] text-[#8a7e72]">What do you want to do?</p>
              <div className="max-h-[320px] overflow-y-auto px-1.5 pb-1.5">
                {(["directive", "action"] as const).map((group, gi) => {
                  const items = slashCandidates
                    .map((command, index) => ({ command, index }))
                    .filter(({ command }) => (command.directive ? group === "directive" : group === "action"));
                  if (!items.length) return null;
                  return (
                    <div key={group} className={cn(gi === 1 && "mt-1 border-t border-[#e3dacd] pt-1")}>
                      {items.map(({ command, index }) => {
                        const Icon = command.icon;
                        const selected = index === slashIndex;
                        return (
                          <button
                            key={command.id}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            onMouseDown={(event) => { event.preventDefault(); chooseSlash(command); }}
                            onMouseEnter={() => setSlashIndex(index)}
                            className={cn(
                              "relative flex w-full items-center gap-2.5 rounded-lg py-1.5 pl-2.5 pr-2 text-left outline-none transition-colors",
                              selected ? "bg-[#ece4d7]" : "hover:bg-[#efe8dd]"
                            )}
                          >
                            {selected && <span aria-hidden="true" className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-[#1a1512]" />}
                            <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full ring-1", command.directive ? "bg-[#1a1512]/[0.06] text-[#6b5a46] ring-[#d8cdbd]" : "text-[#8a7e72] ring-transparent")}>
                              <Icon className="size-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12.5px] font-medium text-[#1a1512]">{command.label}</span>
                              <span className="block truncate text-[10.5px] text-[#8a7e72]">{command.hint}</span>
                            </span>
                            {selected && <kbd className="rounded border border-[#d8cdbd] bg-[#f5f0e8] px-1.5 py-0.5 text-[9px] text-[#8a7e72]">↵</kbd>}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
              <p className="border-t border-[#e3dacd] bg-[#f1ebe0] px-3.5 py-2 text-[9.5px] text-[#8a7e72]">↑↓ to move · Enter to pick · Esc to close</p>
            </div>
          )}

          {/* Independent Attachment Tab (Slides up from behind the prompt input) */}
          <div
            aria-hidden={!hasAttachments}
            style={{
              height: hasAttachments && expanded ? 68 : 0,
              transition: isSmoothResize
                ? "height 0.15s ease-out"
                : "height 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
            }}
            className="w-full relative z-0 overflow-hidden"
          >
            <div
              style={{
                position: "absolute",
                bottom: -8,
                left: 20,
                right: 20,
                height: 68,
                transform: hasAttachments && expanded ? "translateY(0)" : "translateY(100%)",
                opacity: hasAttachments && expanded ? 1 : 0,
                transition: isSmoothResize
                  ? "transform 0.15s ease-out, opacity 0.15s ease-out"
                  : "transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.3s ease-out",
              }}
              className="border border-border border-b-0 bg-muted rounded-t-2xl px-2 pt-2 pb-1 flex items-start gap-2 overflow-x-auto prompt-scrollbar"
            >
              {attachments.map((attachment, index) => (
                <AttachmentThumb
                  key={attachment.id}
                  attachment={attachment}
                  index={index}
                  onRemove={removeAttachment}
                  onOpen={(a, rect) => setActiveAttachment({ attachment: a, rect })}
                  registerRef={(id, el) => thumbRefs.current.set(id, el)}
                />
              ))}
            </div>
          </div>

          {queued.length > 0 && (
            <div role="list" className="mb-1.5 flex flex-col gap-1" aria-label="Waiting to send">
              {queued.map((item) => (
                <div key={item.id} role="listitem" className="flex items-center gap-2 rounded-lg border border-border bg-muted/60 px-2.5 py-1 text-[12px] text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate"><LinkifiedText text={item.text} /></span>
                  {onSendQueuedNow && (
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onSendQueuedNow(item.id)}
                      className="shrink-0 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
                    >
                      Send now
                    </button>
                  )}
                  {onRemoveQueued && (
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onRemoveQueued(item.id)}
                      aria-label={`Discard queued message ${item.text}`}
                      className="flex size-4 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-black/10"
                    >
                      <CloseIcon />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Main Input Card */}
          <div
            onMouseDown={(e) => {
              const isTextarea = e.target === textareaRef.current;
              if (expanded && !isTextarea && !isRecording) {
                e.preventDefault();
                textareaRef.current?.focus();
              }
            }}
            style={{
              borderRadius: 24,
              height: expanded ? containerHeight : 48,
              transition: isSmoothResize ? SMOOTH_HEIGHT_TRANSITION : SPRING_TRANSITION,
              overflow: expanded ? "visible" : "hidden",
              background: "#f5f0e8",
            }}
            className={cn(
              "relative w-full border border-border shadow-sm focus-within:border-ring/40 focus-within:ring-1 focus-within:ring-ring/20 hover:border-border/80 z-10",
              expanded ? "cursor-text" : "cursor-default"
            )}
          >
            <style dangerouslySetInnerHTML={{ __html: `
              .prompt-scrollbar::-webkit-scrollbar { width: 4px; height: 4px; background: transparent; }
              .prompt-scrollbar::-webkit-scrollbar-track { background: transparent; }
              .prompt-scrollbar::-webkit-scrollbar-thumb { background: transparent; border-radius: 4px; }
              .prompt-scrollbar:hover::-webkit-scrollbar-thumb { background: hsl(var(--muted-foreground) / 0.3); }
            `}} />

            {chip && expanded && (
              <div
                className="absolute left-3 top-2 z-[4] flex items-center gap-1.5 rounded-full border border-[#d7ccbb] bg-[#e9e0d1] py-1 pl-2 pr-1 text-[#1a1512] shadow-xs animate-in fade-in zoom-in-95 duration-150"
                data-slash-chip={chip.id}
              >
                <chip.Icon className="size-3" />
                <span className="text-[11.5px] font-semibold leading-none tracking-tight">{chip.label}</span>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setChip(null)}
                  aria-label={`Remove ${chip.label}`}
                  className="ml-0.5 flex size-4 items-center justify-center rounded-full text-[#8a7e72] transition-colors hover:bg-black/10 hover:text-[#1a1512]"
                >
                  <CloseIcon />
                </button>
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => handleValueChange(e.target.value)}
              onScroll={updateFades}
              onPaste={(e) => {
                // Pasted images or files arrive as clipboard files — attach them instead of
                // inserting their names as text so the agent can read the real content.
                const pasted = Array.from(e.clipboardData?.files ?? []);
                if (pasted.length && acceptFiles(pasted)) e.preventDefault();
              }}
              onKeyDown={(e) => {
                if (chip && value === "" && e.key === "Backspace") {
                  e.preventDefault();
                  setChip(null);
                  return;
                }
                if (slashMenuOpen) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashIndex((index) => (index + 1) % slashCandidates.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashIndex((index) => (index - 1 + slashCandidates.length) % slashCandidates.length);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    chooseSlash(slashCandidates[Math.min(slashIndex, slashCandidates.length - 1)]!);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSlashDismissed(true);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
                if (e.key === "Escape" && value.trim() === "" && !hasAttachments) {
                  setIsSmoothResize(false);
                  setExpanded(false);
                }
              }}
              placeholder={placeholder}
              aria-label="Prompt"
              disabled={isRecording}
              style={{
                top: chip ? 38 : 0,
                transition: isSmoothResize
                  ? "height 0.15s ease-out"
                  : "opacity 0.3s ease-out, transform 0.3s ease-out, height 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)"
              }}
              className={cn(
                "prompt-scrollbar absolute top-0 inset-x-0 z-[1] w-full resize-none bg-transparent pl-4 pr-12 py-3.5 text-sm leading-[22px] outline-none cursor-text",
                "text-[#1a1512] placeholder:font-medium placeholder:text-[#8a7e72]",
                expanded ? "opacity-100 scale-100 translate-y-0" : "opacity-0 scale-95 -translate-y-1 pointer-events-none",
                isScrolling ? "overflow-y-auto" : "overflow-y-hidden",
                isRecording && "pointer-events-none"
              )}
            />

            <div
              ref={topFadeRef}
              className="absolute left-4 right-12 top-0 z-[2] h-8 pointer-events-none"
              style={{ background: "linear-gradient(to bottom, #f5f0e8, transparent)", top: chip ? 38 : 0 }}
            />
            <div
              ref={bottomFadeRef}
              className="absolute left-4 right-12 z-[2] h-8 pointer-events-none"
              style={{ 
                opacity: 0, 
                top: `${textareaHeight - 32 + (chip ? 38 : 0)}px`,
                background: "linear-gradient(to top, #f5f0e8, transparent)",
                transition: isSmoothResize ? "top 0.15s ease-out" : "top 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)"
              }}
            />

            <button
              type="button"
              onClick={expand}
              style={{ transition: isSmoothResize ? "none" : "all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)" }}
              className={cn(
                "absolute inset-x-0 top-0 z-[1] cursor-text pl-4 pr-12 py-[15px] text-left text-sm font-medium leading-[17px] outline-none",
                "text-[#8a7e72]",
                !expanded ? "opacity-100 scale-100 translate-y-0" : "opacity-0 scale-105 translate-y-1 pointer-events-none"
              )}
              aria-label="Open prompt input"
            >
              {placeholder}
            </button>

            {/* Bottom Actions Wrapper - Hides when recording to make space for visualizer */}
            <div
              className={cn(
                "absolute bottom-2 left-3 right-12 z-[10] flex items-center gap-0 transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)]",
                expanded && !isRecording ? "opacity-100 blur-0 translate-y-0 pointer-events-auto" : "opacity-0 blur-sm translate-y-2 pointer-events-none"
              )}
            >
              <button
                type="button" onMouseDown={(e) => e.preventDefault()} onClick={cycleEffort}
                className="group flex items-center gap-1 rounded-full px-2 py-1 transition-all duration-200 hover:bg-black/8 outline-none cursor-default text-[#4a3f35] hover:text-[#1a1512]"
              >
                <DynamicBarsIcon level={efforts[effortIndex] || "Medium"} />
                <span className="text-xs font-semibold select-none transition-colors"><MorphingText text={efforts[effortIndex] || "Medium"} /></span>
              </button>

              {draftLink && (
                <a
                  href={draftLinkHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onMouseDown={(e) => e.preventDefault()}
                  title={`Open ${draftLink}`}
                  className="ml-1 flex max-w-[240px] items-center gap-1.5 rounded-full bg-black/5 px-2 py-1 transition-colors hover:bg-black/10"
                >
                  <Globe className="size-3 shrink-0 text-link" aria-hidden="true" />
                  <span className="truncate text-[11px] font-medium leading-none text-link underline decoration-link/50 underline-offset-2">{draftLink}</span>
                  <ArrowUpRight className="size-3 shrink-0 text-link/60" aria-hidden="true" />
                </a>
              )}

              {onCaptureScreen && (
                <button
                  type="button" onMouseDown={(e) => e.preventDefault()} onClick={captureScreen}
                  disabled={capturingScreen || attachments.length >= maxAttachments}
                  title="Look at my screen"
                  aria-label="Look at my screen"
                  className="ml-auto flex size-7 items-center justify-center rounded-full transition-all duration-200 hover:bg-black/8 outline-none cursor-default disabled:opacity-40 disabled:pointer-events-none text-[#4a3f35] hover:text-[#1a1512]"
                >
                  {capturingScreen ? <span className="size-3 animate-spin rounded-full border border-current border-t-transparent" /> : <ScreenIcon />}
                </button>
              )}
              <button
                type="button" onMouseDown={(e) => e.preventDefault()} onClick={openFileChooser} disabled={attachments.length >= maxAttachments}
                className={cn("flex size-7 items-center justify-center rounded-full transition-all duration-200 hover:bg-black/8 outline-none cursor-default disabled:opacity-40 disabled:pointer-events-none text-[#4a3f35] hover:text-[#1a1512]", onCaptureScreen ? "ml-1" : "ml-auto")}
              >
                <PlusIcon />
              </button>
            </div>

            {/* Audio Wave Visualizer Overlay positioned precisely to the left of the mic button */}
            <div
              className={cn(
                "absolute right-12 bottom-2 z-[10] flex h-8 items-center justify-end gap-[3px] transition-all duration-400 ease-[cubic-bezier(0.175,0.885,0.32,1.275)]",
                isRecording ? "w-16 opacity-100 translate-x-0" : "w-0 opacity-0 translate-x-4 pointer-events-none"
              )}
            >
              {audioData.map((val, i) => (
                <div
                  key={i}
                  className="w-1 rounded-full bg-primary transition-[height] duration-75 ease-out"
                  style={{ height: `${Math.max(4, val * 24)}px` }}
                />
              ))}
            </div>

            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }} 
              onClick={onActionButtonClick}
              aria-label={isThinking ? hasValue ? "Queue message" : "Stop task" : showStop ? "Stop recording" : showArrow ? "Send prompt" : "Use voice input"}
              className="absolute right-2 bottom-2 z-[10] flex h-8 w-8 items-center justify-center transition-all duration-300 hover:opacity-90 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-default"
              style={{ borderRadius: 9999, background: "#1a1512", color: "#f5f0e8" }}
            >
              <span className="relative flex h-full w-full items-center justify-center">
                <span className={cn("absolute inset-0 flex items-center justify-center transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)]", showArrow && !showStop ? "opacity-100 scale-100 rotate-0 blur-none" : "opacity-0 scale-50 rotate-45 blur-[1px] pointer-events-none")}>
                  <ArrowUpIcon />
                </span>
                <span className={cn("absolute inset-0 flex items-center justify-center transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)]", showMic ? "opacity-100 scale-100 rotate-0 blur-none" : "opacity-0 scale-50 -rotate-45 blur-[1px] pointer-events-none")}>
                  <MicIcon />
                </span>
                <span className={cn("absolute inset-0 flex items-center justify-center transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)]", showStop ? "opacity-100 scale-100 rotate-0 blur-none" : "opacity-0 scale-50 rotate-45 blur-[1px] pointer-events-none")}>
                  <StopIcon />
                </span>
              </span>
            </button>
          </div>
          {captureError ? <p role="alert" className="mt-1 px-2 text-[11px] leading-4 text-red-400">{captureError}</p> : null}
          <div className="mt-1 flex items-center justify-between gap-2">
            <AccessSelector value={accessMode} onChange={(mode) => onAccessModeChange?.(mode)} />
            <div className="relative min-w-0">
              {folderMenuOpen && <div className="fixed inset-0 z-20" onMouseDown={() => setFolderMenuOpen(false)} aria-hidden="true" />}
              {projectName ? (
                <>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setFolderMenuOpen((open) => !open)}
                    title={folderLocked ? "This chat keeps its folder. Start a new chat to pick a different one." : projectPath || projectName}
                    aria-haspopup="menu"
                    aria-expanded={folderMenuOpen}
                    className="flex max-w-full items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {folderBusy ? <span className="size-3 animate-spin rounded-full border border-current border-t-transparent" /> : <FolderIcon />}
                    <span className="truncate">{folderBusy ? "Adding…" : projectName}</span>
                    <ChevronDown className="size-3 shrink-0 opacity-60" />
                  </button>
                  {folderMenuOpen && (
                    <div role="menu" className="absolute bottom-full right-0 z-30 mb-2 w-60 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg animate-in fade-in slide-in-from-bottom-1 duration-150">
                      {folderLocked ? (
                        <button role="menuitem" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { setFolderMenuOpen(false); onNewChatWithFolder?.(); chooseFolder(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-muted">
                          <FolderIcon withPlus /> Start a new chat in another folder
                        </button>
                      ) : (
                        <>
                          <button role="menuitem" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { setFolderMenuOpen(false); chooseFolder(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-muted">
                            <FolderIcon withPlus /> Choose a new folder
                          </button>
                          {onClearFolder && (
                            <button role="menuitem" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { setFolderMenuOpen(false); onClearFolder(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted">
                              <CloseIcon /> Work with no folder
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </>
              ) : folderLocked ? (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { onNewChatWithFolder?.(); chooseFolder(); }}
                  disabled={folderBusy || !onNewChatWithFolder}
                  aria-label="Add a folder in a new chat"
                  title="A chat keeps one folder for its whole life, so this starts a new chat and picks it."
                  className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  {folderBusy ? <span className="size-3 animate-spin rounded-full border border-current border-t-transparent" /> : <FolderIcon withPlus />}
                  <span>{folderBusy ? "Adding…" : "Add a folder in a new chat"}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={chooseFolder}
                  disabled={folderBusy}
                  aria-label="Add a folder"
                  title="Bring a project folder into Calvras"
                  className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  {folderBusy ? <span className="size-3 animate-spin rounded-full border border-current border-t-transparent" /> : <FolderIcon withPlus />}
                  <span>{folderBusy ? "Adding…" : "Add a folder"}</span>
                </button>
              )}
            </div>
          </div>
          {folderError && <p role="alert" className="mt-1 px-2 text-[11px] leading-4 text-red-400">{folderError}</p>}
        </div>

        {activeAttachment && (
          <AttachmentGalleryModal
            attachment={activeAttachment.attachment} originRect={activeAttachment.rect} onClose={() => setActiveAttachment(null)}
          />
        )}
      </>
    );
  }
);

PromptInput.displayName = "PromptInput";
