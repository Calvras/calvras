"use client";

import * as React from "react";
import { useRef, useState, useEffect, useCallback } from "react";
import {
  Folder,
  Paperclip,
  FolderOpen,
  Target,
  ClipboardList,
  PenLine,
  Hand,
  ShieldCheck,
  Zap,
  Check,
  MessageCircle,
  Shield,
  Sparkles,
  Radio,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ----------------------------------------------------------------------
// Slash commands — only these 4
// ----------------------------------------------------------------------
const SLASH_COMMANDS = [
  { Icon: Target,        command: "/goal",    label: "Goal",       hint: "Set a goal to keep pursuing" },
  { Icon: MessageCircle, command: "/question",label: "Question",   hint: "Ask a quick question" },
  { Icon: PenLine,       command: "/sketch",  label: "Sketch",     hint: "Draw a sketch" },
  { Icon: ClipboardList, command: "/plan",    label: "Plan mode",  hint: "Turn plan mode on" },
];

// ----------------------------------------------------------------------
// Permissions / Approval modes
// ----------------------------------------------------------------------
const APPROVAL_MODES = [
  {
    id: "ask",
    Icon: Hand,
    label: "Ask first",
    desc: "Check in with me before touching files or running commands",
  },
  {
    id: "approve",
    Icon: ShieldCheck,
    label: "Review changes",
    desc: "Handle small edits freely, ask before anything major",
  },
  {
    id: "full",
    Icon: Zap,
    label: "Full speed",
    desc: "Make edits and run tasks directly without waiting",
  },
] as const;

type ApprovalId = (typeof APPROVAL_MODES)[number]["id"];

// ----------------------------------------------------------------------
// Transition Physics — single easing used everywhere for consistency
// ----------------------------------------------------------------------
const SPRING = "cubic-bezier(0.25, 1, 0.5, 1)";
const SPRING_TRANSITION = `max-width 0.38s ${SPRING}, height 0.38s ${SPRING}`;
const SMOOTH_HEIGHT_TRANSITION = `max-width 0.38s ${SPRING}, height 0.22s ${SPRING}`;

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
      className="relative inline-flex items-center justify-center overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
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

function ModelIcon({ model, className }: { model: string; className?: string }) {
  const icons: Record<string, string> = {
    "Composer 2.5": "https://cdn.21st.dev/assets/mirror/7d/7dc00bc09f225fcda46cbc9c6b669c69c025a231877d6c17baa6a003f04f02b2.svg",
    "Gemini 3.5 Flash": "https://cdn.21st.dev/assets/mirror/cd/cda2df6631d5fa227de3fa04ed78cf354f910ba92a9f086e7455655c10ad9d09.svg",
    "GPT 5.5": "https://cdn.21st.dev/assets/mirror/b9/b93fa7942be639a1dae60194ff12141145d7d9fd59581582d6ff23335755f19c.svg",
    "Opus 4.8": "https://cdn.21st.dev/assets/mirror/5d/5de1221c77cc91e748066fd642ad0eee1c1fa65328814f5178166f901e599709.svg",
    "GLM 5.2": "https://cdn.21st.dev/assets/mirror/b2/b2a6c0ff63efd8a555edf8a174ea6fcfeca120ac1595a2d461ca11d3ae89276c.svg"
  };

  const filters: Record<string, string> = {
    "GPT 5.5": "dark:invert", 
  };

  return (
    <img 
      src={icons[model] || icons["GPT 5.5"]} 
      alt={model} 
      className={cn("object-contain", filters[model], className)} 
    />
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

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 2.5V11.5M2.5 7H11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2.5 2.5L11.5 11.5M11.5 2.5L2.5 11.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ----------------------------------------------------------------------
// Slash command palette
// ----------------------------------------------------------------------
// Slash panel — slides up from behind the input card, same as the attachment tab
// ----------------------------------------------------------------------
function SlashInlinePanel({
  query,
  onSelect,
  activeIndex,
  visible,
}: {
  query: string;
  onSelect: (cmd: string) => void;
  activeIndex: number;
  visible: boolean;
}) {
  const filtered = SLASH_COMMANDS.filter(
    (c) =>
      query === "" ||
      c.command.toLowerCase().includes(query.toLowerCase()) ||
      c.label.toLowerCase().includes(query.toLowerCase())
  );

  const show = visible && filtered.length > 0;
  // Generous height to account for bottom overlap (-8px) and rounded borders
  const panelHeight = filtered.length * 54 + 24;

  return (
    <div
      aria-hidden={!show}
      style={{
        height: show ? panelHeight : 0,
        transition: `height 0.35s cubic-bezier(0.25, 1, 0.5, 1)`,
      }}
      className="w-full relative z-0 overflow-hidden"
    >
      <div
        style={{
          position: "absolute",
          bottom: -8,
          left: 20,
          right: 20,
          height: panelHeight,
          transform: show ? "translateY(0)" : "translateY(100%)",
          opacity: show ? 1 : 0,
          transition: `transform 0.35s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.25s cubic-bezier(0.25, 1, 0.5, 1)`,
          background: "oklch(0.17 0 0)",
        }}
        className="border border-white/10 border-b-0 rounded-t-2xl overflow-hidden"
      >
        <div className="px-2 pt-2 pb-3">
          {filtered.map((item, i) => (
            <button
              key={item.command}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSelect(item.command)}
              className={cn(
                "flex w-full items-center gap-3 px-2 py-2 rounded-xl text-left transition-colors duration-100",
                i === activeIndex ? "bg-white/10" : "hover:bg-white/5"
              )}
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/10">
                <item.Icon className="h-3.5 w-3.5 text-white/70" strokeWidth={1.5} />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-[12px] font-semibold text-white/90 leading-tight">{item.label}</span>
                {item.hint && (
                  <span className="text-[10px] text-white/40 leading-tight mt-0.5">{item.hint}</span>
                )}
              </div>
              <span className="ml-auto text-[10px] font-mono text-white/25 shrink-0">{item.command}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Permissions picker
// ----------------------------------------------------------------------
function ApprovalPicker({
  open,
  selected,
  onSelect,
  onClose,
}: {
  open: boolean;
  selected: ApprovalId;
  onSelect: (id: ApprovalId) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  return (
    <div
      ref={ref}
      className={cn(
        "absolute bottom-full left-0 mb-2 z-50 w-72",
        "rounded-2xl border border-white/10 bg-[#1e1e1e] shadow-xl p-1.5 overflow-hidden",
        "transition-all duration-180 origin-bottom-left",
        open
          ? "opacity-100 scale-100 translate-y-0 pointer-events-auto"
          : "opacity-0 scale-95 translate-y-1.5 pointer-events-none"
      )}
    >
      <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-white/40">
        When Calvras makes changes
      </div>

      <div className="flex flex-col gap-0.5">
        {APPROVAL_MODES.map((mode) => {
          const isSelected = selected === mode.id;
          return (
            <button
              key={mode.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSelect(mode.id);
                onClose();
              }}
              className={cn(
                "group flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors duration-100",
                isSelected
                  ? "bg-white/10 text-white"
                  : "text-white/70 hover:bg-white/5 hover:text-white"
              )}
            >
              <mode.Icon
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0 transition-colors",
                  isSelected ? "text-white" : "text-white/40 group-hover:text-white/60"
                )}
                strokeWidth={1.75}
              />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium leading-tight">
                  {mode.label}
                </div>
                <div className="mt-0.5 text-[11px] leading-snug text-white/45">
                  {mode.desc}
                </div>
              </div>
              {isSelected && (
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/80" strokeWidth={2.2} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DynamicBarsIcon({ level }: { level: string }) {
  const isMediumOrHigh = level === "Medium" || level === "Max Effort";
  const isHigh = level === "Max Effort";

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
function DocIcon({ ext }: { ext: string }) {
  const colors: Record<string, string> = {
    pdf: "#e74c3c",
    docx: "#2b7cd3",
    doc: "#2b7cd3",
    txt: "#6b7280",
    csv: "#16a34a",
  };
  const color = colors[ext.toLowerCase()] ?? "#6b7280";
  return (
    <div className="flex size-full flex-col items-center justify-center gap-0.5" style={{ background: color }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="white" strokeWidth="1.8" strokeLinejoin="round"/>
        <polyline points="14 2 14 8 20 8" stroke="white" strokeWidth="1.8" strokeLinejoin="round"/>
      </svg>
      <span className="text-[8px] font-bold uppercase tracking-wide text-white/90">{ext}</span>
    </div>
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
  const isImage = attachment.file.type.startsWith("image/");
  const ext = attachment.name.split(".").pop() ?? "file";

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
        if (isImage && btnRef.current) {
          onOpen(attachment, btnRef.current.getBoundingClientRect());
        }
      }}
      style={{ animationDelay: `${index * 35}ms`, animationFillMode: "backwards" }}
      className={cn(
        "group relative size-12 shrink-0 overflow-hidden rounded-xl border border-border bg-muted outline-none",
        "transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:scale-[1.04] active:scale-[0.96]",
        "animate-in fade-in slide-in-from-top-3 zoom-in-90 duration-400"
      )}
      aria-label={isImage ? `Open preview of ${attachment.name}` : attachment.name}
    >
      {isImage ? (
        <img src={attachment.url} alt={attachment.name} className="size-full object-cover" draggable={false} />
      ) : (
        <DocIcon ext={ext} />
      )}
      <span className={cn("absolute inset-0 flex items-start justify-end bg-black/0 transition-colors duration-200", isHovered && "bg-black/25")}>
        <span
          role="button" tabIndex={-1}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => { e.stopPropagation(); onRemove(attachment.id); }}
          className={cn(
            "m-1 flex size-4 items-center justify-center rounded-full bg-background/90 text-foreground/70 shadow-sm transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-background hover:text-foreground hover:scale-110",
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

  const animEasing = isClosing ? "ease-out" : "cubic-bezier(0.22, 1, 0.36, 1)";
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
        <img ref={imgRef} src={attachment.url} alt={attachment.name} className="size-full object-cover" draggable={false} />
      </div>

      <button
        type="button" onClick={handleClose}
        style={{ opacity: isOpen ? 1 : 0, transform: isOpen ? "scale(1)" : "scale(0.7)" }}
        className={cn(
          "fixed right-4 top-4 flex size-9 items-center justify-center rounded-full bg-card/90 text-foreground/70 shadow-md backdrop-blur-sm",
          "transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-card hover:text-foreground",
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
    attachments?: { type: string; url: string; name: string }[]
  ) => void;
  placeholder?: string;
  className?: string;
  models?: string[];
  efforts?: string[];
  defaultValue?: string;
  value?: string;
  onChange?: (value: string) => void;
  maxAttachments?: number;
  isThinking?: boolean;
  onStop?: () => void;
}

export const PromptInput = React.forwardRef<HTMLDivElement, PromptInputProps>(
  (
    {
      onSubmit,
      placeholder = "Ask anything",
      className,
      models = ["GPT 5.5", "Opus 4.8", "Gemini 3.5 Flash", "Composer 2.5", "GLM 5.2"],
      efforts = ["Low", "Medium", "Max Effort"],
      defaultValue = "",
      value: controlledValue,
      onChange,
      maxAttachments = 6,
      isThinking = false,
      onStop,
    },
    ref
  ) => {
    const [expanded, setExpanded] = useState(false);
    const [isSmoothResize, setIsSmoothResize] = useState(false);
    const [localValue, setLocalValue] = useState(defaultValue);
    const [selectedModel, setSelectedModel] = useState(models[0] ?? "GPT 5.5");
    const [effortIndex, setEffortIndex] = useState(1);
    const [isModelSelectOpen, setIsModelSelectOpen] = useState(false);

    // Slash command palette
    const [slashQuery, setSlashQuery] = useState<string | null>(null);
    const [slashActiveIndex, setSlashActiveIndex] = useState(0);

    // Approval picker
    const [approvalOpen, setApprovalOpen] = useState(false);
    const [approvalMode, setApprovalMode] = useState<ApprovalId>("full");

    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [activeAttachment, setActiveAttachment] = useState<{ attachment: Attachment; rect: DOMRect } | null>(null);

    // Audio/Voice recording states
    const [isRecording, setIsRecording] = useState(false);
    const [audioData, setAudioData] = useState<number[]>(new Array(5).fill(0));
    const valueRef = useRef(controlledValue !== undefined ? controlledValue : localValue);

    // Refs for Web Audio & Speech Recognition cleanup
    const streamRef = useRef<MediaStream | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const rafRef = useRef<number | null>(null);
    const recognitionRef = useRef<any>(null);
    const demoIntervalRef = useRef<number | null>(null);
    const demoTextIntervalRef = useRef<number | null>(null);

    const [hoverStyle, setHoverStyle] = useState({ opacity: 0, transform: "translateY(0px) scale(0.95)", transition: "none" });
    const [containerHeight, setContainerHeight] = useState(116);
    const [textareaHeight, setTextareaHeight] = useState(68);
    const [isScrolling, setIsScrolling] = useState(false);
    // Stays true during the collapse animation so content isn't clipped mid-transition
    const [overflowVisible, setOverflowVisible] = useState(false);
    const overflowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const isControlled = controlledValue !== undefined;
    const value = isControlled ? controlledValue : localValue;
    const hasValue = value.trim() !== "" || attachments.length > 0;
    const hasAttachments = attachments.length > 0;

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const internalContainerRef = useRef<HTMLDivElement>(null);
    const topFadeRef = useRef<HTMLDivElement>(null);
    const bottomFadeRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const thumbRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

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

      // Slash command detection: trigger when the last "word" starts with "/"
      // e.g. "/" alone, or after a space/newline like "fix auth /go"
      const slashMatch = val.match(/(?:^|[\s\n])\/([\w]*)$/);
      if (slashMatch) {
        setSlashQuery(slashMatch[1] ?? null);
        setSlashActiveIndex(0);
      } else {
        setSlashQuery(null);
      }
    }, [isControlled, onChange]);

    const expand = () => {
      setIsSmoothResize(false); 
      setExpanded(true);
    };

    // --- Voice Recording Logic ---
    const stopRecording = useCallback(() => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
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
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      if (demoIntervalRef.current) {
        window.clearInterval(demoIntervalRef.current);
        demoIntervalRef.current = null;
      }
      if (demoTextIntervalRef.current) {
        window.clearInterval(demoTextIntervalRef.current);
        demoTextIntervalRef.current = null;
      }
      setIsRecording(false);
      setAudioData(new Array(5).fill(0));
    }, []);

    const startRecording = useCallback(async () => {
      setIsSmoothResize(false);
      setExpanded(true);

      let stream: MediaStream | null = null;
      try {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
      } catch (err) {
        console.warn("Microphone access denied or unavailable. Falling back to simulated voice mode for demo.");
      }

      setIsRecording(true);

      // Simulation function for tight sandbox environments
      function simulateText() {
        const fakeText = "Can you build a high fidelity Framer Motion layout animation for a dark mode dashboard?";
        const words = fakeText.split(" ");
        let i = 0;
        let currentBase = valueRef.current;
        demoTextIntervalRef.current = window.setInterval(() => {
          if (i < words.length) {
            currentBase = (currentBase ? currentBase + " " : "") + words[i];
            handleValueChange(currentBase);
            i++;
          } else {
            stopRecording();
          }
        }, 300);
      }

      if (stream) {
        streamRef.current = stream;
        
        // Setup Web Audio API for visualizer
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
            bands[i] = sum / step / 255; // normalize to 0-1
          }
          setAudioData(bands);
          rafRef.current = requestAnimationFrame(updateVisualizer);
        };
        updateVisualizer();

        // Setup Speech Recognition
        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (SpeechRecognition) {
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
            console.error("Speech recognition error", e);
            stopRecording();
          };

          recognition.onend = () => {
             stopRecording();
          };

          recognitionRef.current = recognition;
          recognition.start();
        } else {
          console.warn("Speech Recognition API not supported in this browser. Using simulated text.");
          simulateText();
        }
      } else {
        // Fallback simulated visualizer
        demoIntervalRef.current = window.setInterval(() => {
          setAudioData(Array.from({ length: 5 }, () => Math.random() * 0.8 + 0.1));
        }, 100);
        simulateText();
      }
    }, [handleValueChange, stopRecording]);

    // Keep textarea auto-scrolled to bottom while recording
    useEffect(() => {
      if (isRecording && textareaRef.current) {
        textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
      }
    }, [value, isRecording]);

    // Ensure cleanup of mic/streams on unmount
    useEffect(() => {
      return () => {
        stopRecording();
        attachments.forEach((a) => URL.revokeObjectURL(a.url)); 
      };
    }, [stopRecording, attachments]);


    useEffect(() => {
      if ((value.trim() !== "" || hasAttachments) && !expanded) {
        setIsSmoothResize(false);
        setExpanded(true);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, expanded, hasAttachments]);

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

    // Sync overflow: show immediately on expand, delay hide until after animation on collapse
    useEffect(() => {
      if (overflowTimerRef.current) clearTimeout(overflowTimerRef.current);
      if (expanded) {
        setOverflowVisible(true);
      } else {
        overflowTimerRef.current = setTimeout(() => setOverflowVisible(false), 420);
      }
      return () => {
        if (overflowTimerRef.current) clearTimeout(overflowTimerRef.current);
      };
    }, [expanded]);

    // ONLY updates height on value/text change. Adding attachments leaves this completely isolated.
    useEffect(() => {
      if (!textareaRef.current) return;
      const el = textareaRef.current;

      // Measure at height:0 without showing the jump (transition:none → measure → re-enable → animate)
      el.style.transition = 'none';
      el.style.height = "0px";
      const scrollHeight = el.scrollHeight;
      // Restore previous visual height first (no flash), then force-reflow, then animate to new height
      el.style.height = `${textareaHeight}px`;
      void el.offsetHeight; // flush
      el.style.transition = `height 0.28s cubic-bezier(0.25, 1, 0.5, 1)`;

      const newHeight = Math.max(68, Math.min(scrollHeight, 160));
      el.style.height = `${newHeight}px`;

      setTextareaHeight(newHeight);
      setIsScrolling(scrollHeight > 160);

      setTimeout(updateFades, 0);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, expanded]);

    useEffect(() => {
      setContainerHeight(Math.max(116, textareaHeight + 48));
      setTimeout(updateFades, 0);
    }, [textareaHeight]);

    useEffect(() => {
      if (!isModelSelectOpen && !approvalOpen) return;
      const handleOutsideClick = (e: MouseEvent) => {
        if (internalContainerRef.current && !internalContainerRef.current.contains(e.target as Node)) {
          setIsModelSelectOpen(false);
          setApprovalOpen(false);
        }
      };
      document.addEventListener("mousedown", handleOutsideClick);
      return () => document.removeEventListener("mousedown", handleOutsideClick);
    }, [isModelSelectOpen, approvalOpen]);

    const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
      if (internalContainerRef.current && internalContainerRef.current.contains(e.relatedTarget as Node)) return;
      if (value.trim() === "" && !hasAttachments && !isRecording) {
        setIsSmoothResize(false);
        setExpanded(false);
        setIsModelSelectOpen(false);
        setApprovalOpen(false);
        setSlashQuery(null);
      }
    };

    const handleSubmit = () => {
      if (value.trim() === "" && !hasAttachments) return;
      setIsSmoothResize(false);

      // Convert all attachment blob URLs to base64 data URLs before submitting
      // so the AI can read them and the chat bubble stays stable after revoke
      const pending = attachments.slice();
      const conversions = pending.map(
        (a) =>
          new Promise<{ type: string; url: string; name: string }>((resolve) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve({
                type: a.file.type || "application/octet-stream",
                url: reader.result as string, // data:... base64
                name: a.name,
              });
            reader.onerror = () =>
              resolve({ type: a.file.type, url: a.url, name: a.name });
            reader.readAsDataURL(a.file);
          })
      );

      Promise.all(conversions).then((attachmentData) => {
        onSubmit?.(value, attachmentData.length > 0 ? attachmentData : undefined);
      });

      handleValueChange("");
      attachments.forEach((a) => URL.revokeObjectURL(a.url));
      setAttachments([]);
      setExpanded(false);
      setIsModelSelectOpen(false);
    };

    const cycleEffort = (e: React.MouseEvent) => {
      e.stopPropagation();
      setEffortIndex((prev) => (prev + 1) % efforts.length);
    };

    const openFileChooser = (e: React.MouseEvent) => {
      e.stopPropagation();
      fileInputRef.current?.click();
    };

    // Must be defined before handlePaste and handleFilesChosen
    const addAttachment = useCallback((file: File, url: string, width: number, height: number) => {
      const id = `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`;
      setAttachments((prev) => [...prev, { id, file, url, name: file.name, width, height }]);
    }, []);

    // Paste handler — supports pasting images and files via Ctrl+V
    const handlePaste = useCallback((e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items || []);
      const fileItems = items.filter((item) => item.kind === "file");
      if (fileItems.length === 0) return; // let normal text paste through

      e.preventDefault();
      const room = Math.max(0, maxAttachments - attachments.length);
      const accepted = fileItems.slice(0, room);

      if (!expanded) { setIsSmoothResize(false); setExpanded(true); }
      else { setIsSmoothResize(true); }

      for (const item of accepted) {
        const file = item.getAsFile();
        if (!file) continue;
        const url = URL.createObjectURL(file);
        if (file.type.startsWith("image/")) {
          const img = new Image();
          img.onload = () => addAttachment(file, url, img.naturalWidth, img.naturalHeight);
          img.onerror = () => addAttachment(file, url, 800, 600);
          img.src = url;
        } else {
          addAttachment(file, url, 0, 0);
        }
      }
    }, [maxAttachments, attachments.length, expanded, addAttachment]);

    const handleFilesChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = "";

      if (files.length === 0) return;
      const room = Math.max(0, maxAttachments - attachments.length);
      const accepted = files.slice(0, room);

      if (!expanded) { setIsSmoothResize(false); setExpanded(true); }
      else { setIsSmoothResize(true); }

      for (const file of accepted) {
        const url = URL.createObjectURL(file);
        if (file.type.startsWith("image/")) {
          const img = new Image();
          img.onload = () => addAttachment(file, url, img.naturalWidth, img.naturalHeight);
          img.onerror = () => addAttachment(file, url, 800, 600);
          img.src = url;
        } else {
          addAttachment(file, url, 0, 0);
        }
      }
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
    const showStop = isRecording || isThinking;
    const showArrow = !showStop && hasValue;
    const showMic = !showStop && !hasValue;

    const onActionButtonClick = (e: React.MouseEvent) => {
      e.preventDefault();
      if (isThinking) {
        onStop?.();
      } else if (isRecording) {
        stopRecording();
      } else if (hasValue) {
        handleSubmit();
      } else {
        startRecording();
      }
    };

    return (
      <>
        {/* Outer Wrapper for positioning and max-width scaling */}
        <div
          ref={(node) => {
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
            // @ts-ignore
            internalContainerRef.current = node;
          }}
          onBlur={handleBlur}
          onPaste={handlePaste}
          className={cn("relative flex flex-col w-full", className)}
          style={{
            maxWidth: expanded ? 480 : 320,
            transition: `max-width 0.38s ${SPRING}`,
            willChange: "max-width",
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf,.doc,.docx,.txt,.md,.csv,.xlsx,.pptx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/markdown,text/csv"
            multiple
            onChange={handleFilesChosen}
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
          />

          {/* Slash command panel — slides up from behind the card */}
          <SlashInlinePanel
            query={slashQuery ?? ""}
            visible={slashQuery !== null && expanded}
            activeIndex={slashActiveIndex}
            onSelect={(cmd) => {
              // Replace the trailing slash-word with the chosen command
              const newVal = value.replace(/(?:^|([\s\n]))\/([\w]*)$/, (_, pre) => `${pre ?? ""}${cmd} `);
              handleValueChange(newVal);
              setSlashQuery(null);
              textareaRef.current?.focus();
            }}
          />

          {/* Independent Attachment Tab (Slides up from behind the prompt input) */}
          <div
            aria-hidden={!hasAttachments}
            style={{
              height: hasAttachments && expanded ? 68 : 0,
              transition: `height 0.38s ${SPRING}`,
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
                transition: `transform 0.38s ${SPRING}, opacity 0.28s ${SPRING}`,
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
              transition: `height 0.38s ${SPRING}`,
              overflow: overflowVisible ? "visible" : "hidden",
              background: "#e8e4dd",
              willChange: "height",
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

            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => handleValueChange(e.target.value)}
              onScroll={updateFades}
              onKeyDown={(e) => {
                // Slash palette navigation
                if (slashQuery !== null) {
                  const filtered = SLASH_COMMANDS.filter(
                    (c) =>
                      slashQuery === "" ||
                      c.command.toLowerCase().includes(slashQuery.toLowerCase()) ||
                      c.label.toLowerCase().includes(slashQuery.toLowerCase())
                  );
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashActiveIndex((i) => (i + 1) % filtered.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    const chosen = filtered[slashActiveIndex];
                    if (chosen) {
                      handleValueChange(chosen.command + " ");
                      setSlashQuery(null);
                    }
                    return;
                  }
                  if (e.key === "Escape") {
                    setSlashQuery(null);
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
                  setIsModelSelectOpen(false);
                }
              }}
              placeholder={placeholder}
              aria-label="Prompt"
              disabled={isRecording}
              style={{
                transition: `opacity 0.28s ${SPRING}, transform 0.28s ${SPRING}, height 0.38s ${SPRING}`
              }}
              className={cn(
                "prompt-scrollbar absolute top-0 inset-x-0 z-[1] w-full resize-none bg-transparent pl-4 pr-12 py-3.5 text-sm leading-[22px] text-[oklch(0.13_0_0)] outline-none placeholder:font-medium placeholder:text-[oklch(0.55_0_0)] cursor-text",
                expanded ? "opacity-100 scale-100 translate-y-0" : "opacity-0 scale-95 -translate-y-1 pointer-events-none",
                isScrolling ? "overflow-y-auto" : "overflow-y-hidden",
                isRecording && "pointer-events-none"
              )}
            />

            <div
              ref={topFadeRef}
              className="absolute left-4 right-12 top-0 z-[2] h-8 bg-gradient-to-b from-[#e8e4dd] via-[#e8e4dd]/90 to-transparent pointer-events-none"
            />
            <div
              ref={bottomFadeRef}
              className="absolute left-4 right-12 z-[2] h-8 bg-gradient-to-t from-[#e8e4dd] via-[#e8e4dd]/90 to-transparent pointer-events-none"
              style={{ 
                opacity: 0, 
                top: `${textareaHeight - 32}px`,
                transition: `top 0.38s ${SPRING}`
              }}
            />

            <button
              type="button"
              onClick={expand}
              style={{ transition: `all 0.38s ${SPRING}` }}
              className={cn(
                "absolute inset-x-0 top-0 z-[1] cursor-text pl-4 pr-12 py-[15px] text-left text-sm font-medium leading-[17px] text-[oklch(0.55_0_0)] outline-none",
                !expanded ? "opacity-100 scale-100 translate-y-0" : "opacity-0 scale-105 translate-y-1 pointer-events-none"
              )}
              aria-label="Open prompt input"
            >
              {placeholder}
            </button>

            {/* Bottom Actions Wrapper - Hides when recording to make space for visualizer */}
            <div
              className={cn(
                "absolute bottom-2 left-3 right-12 z-[10] flex items-center gap-0 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                expanded && !isRecording ? "opacity-100 translate-y-0 pointer-events-auto" : "opacity-0 translate-y-1 pointer-events-none"
              )}
            >
              {/* Slash palette — rendered as fixed overlay above composer, not inside card */}

                {/* Permissions picker */}
                <div className="relative">
                  {(() => {
                    const mode = APPROVAL_MODES.find((m) => m.id === approvalMode)!;
                    return (
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation();
                          setApprovalOpen((prev) => !prev);
                          setIsModelSelectOpen(false);
                        }}
                        className={cn(
                          "flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-semibold text-black/50 transition-all duration-200 outline-none hover:bg-black/5 hover:text-black/80 cursor-default",
                          approvalOpen && "bg-black/5 text-black/80"
                        )}
                        aria-label="Permissions"
                      >
                        <mode.Icon className="h-3.5 w-3.5 text-black/50" strokeWidth={1.8} />
                        <MorphingText text={mode.label} />
                      </button>
                    );
                  })()}

                <ApprovalPicker
                  open={approvalOpen}
                  selected={approvalMode}
                  onSelect={setApprovalMode}
                  onClose={() => setApprovalOpen(false)}
                />
              </div>

              <button
                type="button" onMouseDown={(e) => e.preventDefault()} onClick={cycleEffort}
                className="group flex items-center gap-1 rounded-full px-2 py-1 text-black/40 transition-all duration-200 hover:bg-black/5 hover:text-black/70 outline-none cursor-default"
              >
                <DynamicBarsIcon level={efforts[effortIndex] ?? "Medium"} />
                <span className="text-xs font-semibold select-none transition-colors"><MorphingText text={efforts[effortIndex] ?? "Medium"} /></span>
              </button>

              <button
                type="button" onMouseDown={(e) => e.preventDefault()} onClick={openFileChooser} disabled={attachments.length >= maxAttachments}
                className="ml-auto flex size-7 items-center justify-center rounded-full border border-black/20 text-black/50 transition-all duration-200 hover:border-black/40 hover:text-black/80 outline-none cursor-default disabled:opacity-30 disabled:pointer-events-none"
              >
                <PlusIcon />
              </button>
            </div>

            {/* Audio Wave Visualizer Overlay positioned precisely to the left of the mic button */}
            <div
              className={cn(
                "absolute right-12 bottom-2 z-[10] flex h-8 items-center justify-end gap-[3px] transition-all duration-400 ease-[cubic-bezier(0.22,1,0.36,1)]",
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
              aria-label={showArrow ? "Send prompt" : showStop ? "Stop recording" : "Use voice input"}
              style={{ borderRadius: 9999 }}
              className="absolute right-2 bottom-2 z-[10] flex h-8 w-8 items-center justify-center bg-black text-white transition-all duration-300 hover:opacity-90 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-default"
            >
              <span className="relative flex h-full w-full items-center justify-center">
                <span className={cn("absolute inset-0 flex items-center justify-center transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]", showArrow ? "opacity-100 scale-100 rotate-0 blur-none" : "opacity-0 scale-50 rotate-45 blur-[1px] pointer-events-none")}>
                  <ArrowUpIcon />
                </span>
                <span className={cn("absolute inset-0 flex items-center justify-center transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]", showMic ? "opacity-100 scale-100 rotate-0 blur-none" : "opacity-0 scale-50 -rotate-45 blur-[1px] pointer-events-none")}>
                  <MicIcon />
                </span>
                <span className={cn("absolute inset-0 flex items-center justify-center transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]", showStop ? "opacity-100 scale-100 rotate-0 blur-none" : "opacity-0 scale-50 rotate-45 blur-[1px] pointer-events-none")}>
                  <StopIcon />
                </span>
              </span>
            </button>
          </div>
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

