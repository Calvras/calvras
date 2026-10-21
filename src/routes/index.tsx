import { marketingHead } from "@/lib/marketing-seo";
import { LandingPage } from "@/components/LandingPage";
import { LaunchGate, installedVersion } from "@/components/LaunchScreen";
import { servesWorkspace, workspaceHostFrom } from "@/lib/workspace-host";
import { AgentActivity, type SubagentJob } from "@/components/AgentActivity";
import { runAgent, type AgentAction, type AgentOutcome } from "@/lib/agent-run";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { agentIntent, asksForCapabilities, asksToReproduce } from "@/lib/agent-intent";
import { executeInOrder } from "@/lib/agent-context";
import { RuntimeClient } from "@/lib/runtime-client";
import type { AccessMode, ToolAction } from "@/lib/tool-catalog";
import { TOOL_RISK } from "@/lib/tool-catalog";
import type { ComposerRequest } from "@/components/ui/composer-access";
import { TasksPanel, type ScheduledRunView, type TaskStep } from "@/components/TasksPanel";
import { effectivePolicies, readPolicies, readPreferences, savePolicies, type Policies, type Preferences } from "@/lib/preferences";
import { blockReason, urlHost } from "@/lib/policy-rules";
import { fidelityNote } from "@/lib/image-fidelity";
import { recordUsage } from "@/lib/telemetry";
import { reportTask } from "@/lib/site-session";
import { PromptInput } from "@/components/ui/ai-chat-input";
import { LinkifiedText } from "@/components/ui/markdown-content";
import {
  type AgentPhase,
  type TraceNode,
} from "@/components/ui/ai-agent-response";
import { useProjects } from "@/lib/project-context";
import { memoryKeyFor, readMemoryAt, storedUser, writeMemoryAt, writeStoredUser, type StoredChat } from "@/lib/account";
import { callAI, isProviderTrouble, patientBackoffMs, PROVIDER_PATIENCE_MS, type MediaAttachment } from "@/lib/gemini";
import { CALVRAS_SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, policyNotes } from "@/lib/system-prompt";
import { playCompletionChimeWhenUnfocused } from "@/lib/completion-sound";
import { decodeTextDataUrl, extractPdfText, isPdfAttachment, isTextLikeAttachment } from "@/lib/attachment-text";
import { cn } from "@/lib/utils";
import { ChapterScrubber, type Chapter } from "@/components/ui/chapter-scrubber";
import { RightDock, type DockTab } from "@/components/RightDock";
import { TerminalDock } from "@/components/TerminalDock";
import { browserBridge, hasInAppBrowser, isInAppBrowserTool } from "@/lib/browser-bridge";
import { evaluatePreviewHealth } from "@/lib/preview-health";
import { Copy, CheckCheck, ListTodo, PanelRight, SquareTerminal } from "lucide-react";
import { SideChat } from "@/components/SideChat";
import { UpdatePill } from "@/components/UpdatePill";

export const Route = createFileRoute("/")({
  head: () => marketingHead("/", "Calvras", "Build real projects with Calvras, a Windows x64 desktop AI coding agent for local files, commands, and visible change review."),
  loader: (context) => ({ workspace: servesWorkspace(workspaceHostFrom(context)) }),
  component: Home,
});

/** One address, two products: the desktop runtime on this machine serves the workspace, while the
 * public site that the same build answers on calvras.com is the marketing page only. */
function Home() {
  const { workspace } = Route.useLoaderData();
  if (!workspace) return <LandingPage />;
  return <LaunchGate><Index /></LaunchGate>;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * TYPES
 * ─────────────────────────────────────────────────────────────────────────────
 */

interface AttachedFile {
  name: string;
  type: string;
  url: string; // object URL or data URL
}

/** Tool rows say what is happening in plain words instead of printing a log line with a
 * file name in it. The exact path or command still lives on the row and shows when the
 * user expands it. */
const TOOL_NARRATION: Record<string, string> = {
  semantic_search: "Searching the code",
  search_knowledge: "Searching the module map",
  read_module: "Reading a module card",
  build_knowledge: "Mapping the folder's modules",
  read_file: "Opening a file",
  read_image: "Looking at an image",
  list_files: "Listing the files",
  list_dir: "Listing the folder",
  directory_tree: "Mapping the folder",
  get_file_info: "Checking a file",
  grep_search: "Searching the code",
  search_files: "Searching the code",
  find_files: "Finding files",
  search_symbols: "Searching the code",
  go_to_definition: "Following the code",
  find_references: "Following the code",
  get_hover_info: "Following the code",
  list_symbols: "Reading the structure",
  read_diagnostics: "Reading the errors",
  get_errors: "Reading the errors",
  get_stack_trace: "Reading the errors",
  read_package_json: "Reading the setup",
  analyze_project: "Getting a read on the project",
  detect_framework: "Getting a read on the project",
  read_project_structure: "Getting a read on the project",
  map_dependencies: "Checking the dependencies",
  write_file: "Writing a file",
  create_file: "Creating a file",
  search_replace: "Editing a file",
  multi_replace: "Editing a file",
  insert_code: "Editing a file",
  delete_lines: "Editing a file",
  apply_patch: "Editing a file",
  apply_diff: "Editing a file",
  multi_file_edit: "Editing several files",
  refactor_code: "Refactoring",
  format_code: "Formatting the code",
  format_file: "Formatting the code",
  organize_imports: "Tidying the imports",
  rename_file: "Renaming a file",
  move_file: "Moving a file",
  copy_file: "Copying a file",
  delete_file: "Deleting a file",
  undo_edit: "Undoing a change",
  create_checkpoint: "Saving a restore point",
  rollback_changes: "Rolling back",
  list_checkpoints: "Listing restore points",
  generate_tests: "Writing tests",
  generate_documentation: "Writing documentation",
  explain_code: "Reading through the code",
  run_command: "Running a command",
  run_terminal: "Running a command",
  run_code: "Running the code",
  run_tests: "Running the tests",
  run_single_test: "Running a test",
  run_build: "Building the app",
  run_lint: "Running the linter",
  run_linter: "Running the linter",
  run_typecheck: "Type-checking the code",
  install_dependencies: "Installing dependencies",
  install_deps: "Installing dependencies",
  start_dev_server: "Starting the server",
  start_server: "Starting the server",
  stop_dev_server: "Stopping the server",
  check_server: "Checking the server",
  run_background_process: "Starting a background process",
  get_terminal_output: "Reading the terminal",
  check_preview: "Looking at the preview",
  compare_to_reference: "Comparing the page to your screenshot",
  check_console_errors: "Checking for console errors",
  verify_changes: "Verifying the change",
  debug_code: "Debugging",
  take_screenshot: "Taking a screenshot",
  take_screen_screenshot: "Taking a screenshot",
  inspect_element: "Inspecting the page",
  test_responsive_layout: "Testing the layout",
  open_browser: "Opening the page",
  navigate_browser: "Loading the page",
  click_element: "Clicking on the page",
  click_at: "Clicking the spot it is looking at",
  hover_at: "Moving the pointer over the page",
  drag_at: "Dragging across the page",
  type_into_page: "Typing into the page",
  fill_input: "Typing into the page",
  press_page_key: "Pressing a key on the page",
  scroll_page: "Scrolling the page",
  upload_file_to_page: "Uploading to the page",
  wait_for_element: "Waiting for the page",
  queue_batch: "Adding the list to the queue",
  next_batch: "Taking the next targets",
  report_batch: "Marking a target finished",
  batch_status: "Checking the queue",
  schedule_run: "Appointing work for later",
  list_scheduled: "Checking the appointments",
  cancel_scheduled: "Cancelling an appointment",
  read_page: "Reading the page",
  web_search: "Searching the web",
  search_documentation: "Reading the docs",
  probe_key: "Testing the API key",
  manage_environment_variables: "Saving the API key",
  git_status: "Checking git",
  git_diff: "Checking git",
  git_show_diff: "Checking git",
  git_log: "Reading the git history",
  git_branch: "Checking the branch",
  git_add: "Staging the change",
  git_commit: "Committing the change",
  git_push: "Pushing the change",
  git_checkout: "Switching branch",
  git_restore: "Restoring a file",
  git_clone: "Cloning the repo",
  deploy_application: "Deploying",
  plan_tasks: "Planning the work",
  create_task_list: "Planning the work",
  delegate_task: "Handing off a subtask",
  ask_subagent: "Asking a subagent",
  read_agent: "Checking a subagent",
  write_memory: "Taking a note",
  read_memory: "Checking the notes",
  track_progress: "Checking progress",
  summarize_changes: "Summarising the change",
};

const COMMAND_NARRATION: [RegExp, string][] = [
  [/\b(?:npm|pnpm|yarn|bun) (?:ci|install)\b/, "Installing dependencies"],
  [/\b(?:npm|pnpm|yarn|bun) run dev\b|\bvite\b(?! build)/, "Starting the dev server"],
  [/\b(?:npm|pnpm|yarn|bun) run build\b|\b(?:vite|next|turbo) build\b/, "Building the app"],
  [/\b(?:npm|pnpm|yarn|bun) (?:test|run test)\b|\bvitest\b|\bjest\b|\bpytest\b/, "Running the tests"],
  [/\btsc\b|typecheck/, "Type-checking the code"],
  [/\beslint\b|\beslint\b|run lint/, "Running the linter"],
  [/\bgit\b/, "Working with git"],
  [/\b(?:curl|wget|httpie)\b/, "Hitting the endpoint"],
  [/\bnode\b.*\.(?:mjs|cjs|js)/, "Running the script"],
  [/\b(?:kill|taskkill)\b/, "Stopping a process"],
];

function humanToolLabel(action: { type: string; command?: string | undefined; intent?: string | undefined }): string {
  // The model says in its own words why it is making this call; that sentence is what the
  // user reads while the timeline is collapsed. The lookup below is only the fallback for
  // a call that came back without one.
  const intent = action.intent?.trim().replace(/\s+/g, " ");
  if (intent && intent.length > 3) return intent.charAt(0).toUpperCase() + intent.slice(1);
  const command = action.command?.trim().toLowerCase() ?? "";
  if (action.type === "run_command" || action.type === "run_terminal") {
    for (const [pattern, label] of COMMAND_NARRATION) if (pattern.test(command)) return label;
  }
  return TOOL_NARRATION[action.type] ?? action.type.replaceAll("_", " ");
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
  rating?: "up" | "down" | undefined;
  subagents?: SubagentJob[] | undefined;
  /** Phase-plan steps the run never reached, so the reply can offer to pick the work back up. */
  openSteps?: string[] | undefined;
  /** Why a stopped turn stopped: the button, or a newer message taking the run over. Absent
   *  means neither, which is a bug and gets said as one rather than dressed up as a stop. */
  stopReason?: string | undefined;
  role: "user" | "assistant";
}

/** Posts a folder to one of the import endpoints and returns the project it created. */
async function requestImport(endpoint: string, body: BodyInit, headers?: Record<string, string>): Promise<{ name: string; projectPath: string }> {
  const response = await fetch(endpoint, { method: "POST", body, ...(headers ? { headers } : {}) });
  const data: { ok?: boolean; error?: string; name?: string; projectPath?: string } = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok || !data.name || !data.projectPath) throw new Error(data.error || `The folder upload could not be completed (HTTP ${response.status}).`);
  return { name: data.name, projectPath: data.projectPath };
}

/** How long one model call keeps retrying through rate limits and dropped streams before the
 * turn gives up lives in the inference layer next to the errors it waits out. */
const CONTEXT_COMPRESSION_SYSTEM_PROMPT = `You compress the working memory of Calvras, an AI agent. Merge the supplied earlier memory and the new conversation turns into one dense continuation brief. Preserve exactly: the user's goals and constraints, decisions made, completed work, files/paths/commands that matter, failures and unresolved problems, and the next steps for any unfinished task. Keep the user's wording for explicit preferences. Never invent results. Output plain text under 900 words.`;

function readSessionMemory(key: string): { summary: string; covered: number } {
  const value = readMemoryAt(key) as { summary?: unknown; covered?: unknown } | null;
  if (value && typeof value.summary === "string") return { summary: value.summary, covered: Number(value.covered) || 0 };
  return { summary: "", covered: 0 };
}

function writeSessionMemory(key: string, memory: { summary: string; covered: number }) {
  writeMemoryAt(key, memory);
}

/** A stored conversation comes back whole: every bubble is finished, because a run that was
 * still going when the app closed cannot resume by itself. */
function restoreTranscript(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const message = raw as Message;
    // Reasoning rows are part of the reply format now, so they persist with the
    // trace; a restored conversation still shows its Thought block.
    const phases = (message.phases || []).map((phase) => ({ ...phase, trace: (phase.trace || []).map((node) => (node.type === "reasoning" && node.status === "running" ? { ...node, status: "completed" as const } : node)) }));
    const hasResponse = phases.some((phase) => phase.message?.trim() || phase.trace.length);
    const interrupted = !message.done || (Boolean(message.startedAt) && !message.endedAt && !hasResponse);
    const lastRecordedTime = message.endedAt ?? Math.max(message.startedAt || 0, ...phases.map((phase) => phase.endedAt || phase.startedAt || 0));
    return { ...message, phases, done: true, ...(lastRecordedTime ? { endedAt: lastRecordedTime } : {}), ...(interrupted ? { status: "stopped" as const } : {}) };
  });
}

/** Object URLs and pasted images expire or blow the storage quota, so a saved conversation
 * keeps the words and the trace instead of the attachments themselves. */
function storableTranscript(messages: Message[]): unknown[] {
  return messages.map((message) => ({
    ...message,
    ...(message.attachments ? { attachments: message.attachments.map((file) => ({ ...file, url: file.url.startsWith("data:") ? "" : file.url })) } : {}),
  }));
}

/**
 * One finished turn, told to the site that verified this account. That is what makes the owner's
 * "per account usage" and "what people ask it" columns real rather than a guess. It goes out on the
 * person's own Telemetry switch — the same one the local activity log obeys — and carries the status,
 * how many actions the run took, how long it took, and the first 300 characters of what they typed.
 * Never a file, a key, or the agent's reply.
 */
async function reportTurn(input: { prompt: string; status: string; seconds: number; phases: Message["phases"] }) {
  const user = storedUser();
  if (!user?.session) return;
  const tools = input.phases.reduce((total, phase) => total + (phase.trace || []).filter((node) => node.type !== "reasoning" && node.type !== "step").length, 0);
  const answer = await reportTask(user.session, { status: input.status, prompt: input.prompt, tools, seconds: input.seconds, version: await installedVersion() });
  // The site has switched this account off, so this computer stops acting as it. The sentence comes
  // from the owner's own console, and the sign-in screen is where it is shown.
  if (answer.blocked) {
    writeStoredUser({ ...user, blocked: answer.error || "This account has been blocked by the owner." });
    window.location.href = "/";
  }
}

function digestTurn(message: Message): string {
  const final = [...message.phases].reverse().find((phase) => phase.message?.trim())?.message?.trim() || "";
  const attachments = message.attachments?.map((file) => file.name).join(", ") || "";
  const actions = message.phases.flatMap((phase) => phase.trace.filter((node) => !["reasoning", "step"].includes(node.type)).map((node) => `${node.status === "completed" ? "ok" : "FAILED"} ${node.primary}${node.secondary ? ` ${node.secondary}` : ""}`)).slice(-12);
  return [
    `User: ${(message.text || "(attachment)").slice(0, 700)}`,
    attachments ? `Attached: ${attachments}` : "",
    final ? `Assistant: ${final.slice(0, 1400)}` : "",
    actions.length ? `Actions: ${actions.join("; ")}` : "",
  ].filter(Boolean).join("\n");
}

function fallbackSessionSummary(existing: string, turns: Message[]): string {
  return [existing.trim(), ...turns.map(digestTurn)].filter(Boolean).join("\n\n").slice(-16_000);
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

/** The message sent when the user presses "Pick it back up": continue the stopped run from its
 * own unfinished steps instead of re-sending the original request, which would restart it. */
function resumeBrief(message: Message, history: Message[]): string {
  const open = (message.openSteps ?? []).filter((step) => step.trim()).slice(0, 8);
  // The stopped turn carries the agent's own narration, not the ask, so the request has to come
  // from the user messages that led to it.
  const request = [...history].reverse().find((item) => item.role === "user" && item.text.trim())?.text ?? message.text;
  return [
    "Pick the task below back up. Do not start it again and do not redo work that is already in the project — check the files and the plan first, then continue from the earliest step that is still open.",
    open.length ? `Steps the last run never finished:\n${open.map((step) => `- ${step}`).join("\n")}` : "The last run stopped with no steps recorded, so read the current state of the project to work out what is already done before continuing.",
    request.trim() ? `Original request:\n${request.slice(0, 1500)}` : "",
  ].filter(Boolean).join("\n\n");
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
          <LinkifiedText text={text} />
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
          "relative break-words rounded-xl bg-muted text-foreground transition-colors duration-200 cursor-pointer select-text",
          isExpanded
            ? "px-4 py-2.5 text-sm leading-relaxed max-w-full"
            : "px-4 py-2.5 max-h-[100px] overflow-hidden hover:bg-muted/90 text-sm leading-relaxed"
        )}
      >
        {isExpanded ? (
          <div className="whitespace-pre-wrap"><LinkifiedText text={text} /></div>
        ) : (
          <div className="whitespace-pre-wrap"><LinkifiedText text={text} /></div>
        )}
      </div>
      {copyButton}
    </div>
  );
}

export function Index() {
  // Expose global new chat handler for Electron shortcut
  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as any).__calvrasNewChat = () => {
        abortControllerRef.current?.abort(); void runtimeRef.current?.stop(); runtimeRef.current = null; setApprovalQueue([]); queuedRef.current = []; setQueued([]); startNewChat();
      };
    }
    return () => {
      if (typeof window !== "undefined") delete (window as any).__calvrasNewChat;
    };
  }, []);
  const { activeProject, setActiveProject, addProject, addRecent, deleteProject, renameProject, activeChatId, chats, saveChat, triggerNewChat } = useProjects();
  const [messages, setMessages] = useState<Message[]>([]);
  const [projectPath, setProjectPath] = useState<string | null>(activeProject?.path || null);
  const [projectName, setProjectName] = useState<string | null>(activeProject?.name || null);
  const [isLoading, setIsLoading] = useState(false);
  const [accessMode, setAccessMode] = useState<AccessMode>("automatic");
  const [approvalQueue, setApprovalQueue] = useState<(ComposerRequest & { sessionId: string; local?: boolean; resolve?: (choice: string | undefined) => void })[]>([]);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [sidechatOpen, setSidechatOpen] = useState(false);
  const [browserAvailable, setBrowserAvailable] = useState(false);
  const [browserEverUsed, setBrowserEverUsed] = useState(false);
  const [browserActive, setBrowserActive] = useState(false);
  // One right-hand surface for the whole workspace: the files the agent is editing, the terminal
  // it runs commands in, the page it is driving, and the subagents it handed work to.
  const [dockOpen, setDockOpen] = useState(false);
  const [dockTab, setDockTab] = useState<DockTab>("files");
  // The shell lives at the bottom edge, not inside the right dock, so a running command stays
  // visible while the conversation and the file tree are both open above it.
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [dockMounted, setDockMounted] = useState(false);
  const dockMountedRef = useRef(false);
  const serverPreviewUrlRef = useRef("");
  // The most recent screenshot the user sent, kept across turns so a rebuilt screen can
  // always be measured against the picture it was supposed to match.
  const referenceImageRef = useRef("");
  // True once this conversation has asked for the screen in that image to be reproduced.
  const referenceTargetRef = useRef(false);
  // Mount the dock closed first so the first reveal slides in instead of popping.
  const openDock = useCallback((next: DockTab) => {
    setDockTab(next);
    if (!dockMountedRef.current) {
      dockMountedRef.current = true;
      setDockMounted(true);
      setDockOpen(false);
      requestAnimationFrame(() => requestAnimationFrame(() => setDockOpen(true)));
    } else {
      setDockOpen(true);
    }
  }, []);
  const revealBrowserPanel = (lock: boolean) => {
    setBrowserActive(lock);
    setBrowserEverUsed(true);
    openDock("browser");
  };
  const [runtimeState, setRuntimeState] = useState<any>({ tasks: [], agents: [], logs: [], checkpoints: [], memory: {} });
  const runtimeRef = useRef<RuntimeClient | null>(null);
  // Every subagent job the pool reported while a turn was live, kept so the finished turn shows
  // the same rows it showed while it was running.
  const subagentLogRef = useRef<Map<string, SubagentJob>>(new Map());
  const runtimeStartRef = useRef<Promise<RuntimeClient> | null>(null);
  const steeringRef = useRef<string[]>([]);
  // Messages the user sends while a task is running are held here and released one at a
  // time as each task finishes. "Send now" pushes one into the live task instead.
  const [queued, setQueued] = useState<{ id: string; text: string; files?: { type: string; url: string; name?: string }[]; effort?: string; directive?: string }[]>([]);
  const queuedRef = useRef<typeof queued>([]);
  const writeQueue = useCallback((next: typeof queued) => { queuedRef.current = next; setQueued(next); }, []);
  // Appointments the agent made in this folder, read back from .calvras/schedule.json.
  const [scheduled, setScheduled] = useState<ScheduledRunView[]>([]);
  const isLoadingRef = useRef(false); isLoadingRef.current = isLoading;
  // The scheduled run whose turn is in flight right now, so its real outcome can be reported.
  const pendingScheduledRef = useRef<ScheduledRunView | null>(null);
  const approvalRef = useRef(approvalQueue); approvalRef.current = approvalQueue;
  useEffect(() => { const mode = localStorage.getItem("calvras_access_mode"); if (["ask", "automatic", "full"].includes(mode || "")) setAccessMode(mode as AccessMode); }, []);
  useEffect(() => { setBrowserAvailable(hasInAppBrowser()); }, []);
  // Keep the panel locked for the whole task; it unlocks as soon as the run ends.
  useEffect(() => { if (!isLoading) setBrowserActive(false); }, [isLoading]);
  const askDecision = useCallback((request: any, sessionId: string, signal?: AbortSignal): Promise<string | undefined> => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Task stopped.")); return; }
    const abort = () => { setApprovalQueue((queue) => queue.filter((item) => item.id !== request.id)); reject(new Error("Task stopped.")); };
    signal?.addEventListener("abort", abort, { once: true });
    const finish = (choice: string | undefined) => { signal?.removeEventListener("abort", abort); resolve(choice); };
    setApprovalQueue((queue) => [...queue.filter((item) => item.id !== request.id), { ...request, sessionId, resolve: finish }]);
  }), []);
  // "Always allow" answers this approval once and then never asks about this tool again. The rule
  // goes to the same store the Settings Tool Permissions switch writes, so it survives a restart
  // and the user can take it back there.
  const allowToolRule = (type?: string) => {
    if (!type) return;
    const policies = readPolicies();
    savePolicies({ ...policies, toolRules: { ...policies.toolRules, [type]: "allow" } });
  };
  const decideApproval = useCallback(async (choice: string, answer?: string) => {
    const request = approvalRef.current[0]; if (!request || request.busy) return;
    setApprovalQueue((queue) => queue.map((item) => item.id === request.id ? { ...item, busy: true } : item));
    // A typed answer is the fourth option: the action is refused and their own words are handed
    // to the running turn, because "use pnpm instead" is not the same decision as allowing npm.
    const typed = choice === "answer" ? String(answer || "").trim() : "";
    try {
      if (request.kind === "question") {
        if (request.resolve) request.resolve(choice);
        else {
          const response = await fetch("/api/agent/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: request.sessionId, questionId: request.id, answer: choice }) });
          const result = await response.json(); if (!result.ok) throw new Error(result.error || "Could not send the answer.");
        }
      }
      else if (request.local) {
        // The visible browser runs inside this process, so its approval resolves here.
        if (typed) request.resolve?.("deny");
        else {
          if (choice === "always") allowToolRule(request.action?.type);
          request.resolve?.(choice === "always" ? "once" : choice);
        }
      }
      else {
        // The runtime only understands once / task / deny, so "always" buys this action exactly
        // as "once" does and the durable half is the rule saved alongside it.
        const response = await fetch("/api/agent/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: request.sessionId, approvalId: request.id, choice: typed ? "deny" : choice === "always" ? "once" : choice }) });
        const result = await response.json(); if (!result.ok) throw new Error(result.error);
        if (!typed && choice === "always") allowToolRule(request.action?.type);
        request.resolve?.(result.token);
      }
      if (typed) {
        steeringRef.current.push(typed);
        setMessages((previous) => [...previous, { id: Date.now(), text: typed, phases: [], done: true, role: "user", status: "finished" }]);
      }
      setApprovalQueue((queue) => queue.filter((item) => item.id !== request.id));
    } catch (error) { setApprovalQueue((queue) => queue.map((item) => item.id === request.id ? { ...item, busy: false, question: `${request.question} (${error instanceof Error ? error.message : "Please retry"})` } : item)); }
  }, []);
  const ensureRuntime = useCallback(async (root: string, task = "Workspace inspection") => {
    if (runtimeRef.current?.root === root) return runtimeRef.current;
    if (runtimeStartRef.current) return runtimeStartRef.current;
    const starting = (async () => { const client = new RuntimeClient(root, askDecision); const state = await client.start(accessMode, task, effectivePolicies(root), readPreferences().workerRouting); runtimeRef.current = client; setRuntimeState(state); return client; })();
    runtimeStartRef.current = starting;
    try { return await starting; } finally { runtimeStartRef.current = null; }
  }, [accessMode, askDecision]);
  const workspaceExecute = useCallback(async (action: ToolAction, options?: { userInitiated?: boolean }) => {
    if (!projectPath) return { ok: false, error: "Select a project folder first." };
    const client = await ensureRuntime(projectPath);
    const result = await client.execute(action, undefined, undefined, options);
    setRuntimeState(await client.status()); return result;
  }, [projectPath, ensureRuntime]);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const client = runtimeRef.current; if (!client?.id) return;
      try { const state = await client.status(); if (!active) return; setRuntimeState(state);
        for (const group of state.agents || []) for (const job of group.jobs || []) {
          subagentLogRef.current.set(job.id, {
            id: job.id, role: job.role, task: String(job.task || "").slice(0, 200), status: job.status,
            startedAt: job.startedAt, endedAt: job.endedAt,
            // The engine the session routes this role onto, read back from the session's own
            // status rather than from anything the worker said about itself.
            engine: job.engine ? { profile: job.engine.profile, model: job.engine.model } : undefined,
            // The worker's own final report, when it produced one. Nothing here is summarised on
            // its behalf — the row shows the sentence the subagent actually finished with.
            result: typeof (job.outcome as { message?: unknown } | undefined)?.message === "string" ? String((job.outcome as { message: string }).message).slice(0, 1500) : undefined,
            updates: (job.updates || []).slice(-6).map((line: string) => String(line).slice(0, 400)),
            // The checkout git really made for this job, with the file count read back from git.
            worktree: job.worktree ? { branch: job.worktree.branch, path: job.worktree.path, files: job.worktree.files, error: job.worktree.error } : undefined,
          });
        }
        const incoming = [...state.approvals.map((item: any) => ({ ...item, kind: "approval", sessionId: client.id })), ...(state.questions || []).map((item: any) => ({ ...item, kind: "question", sessionId: client.id }))];
        setApprovalQueue((queue) => [...queue.filter((item) => item.resolve || incoming.some((pending) => pending.id === item.id)), ...incoming.filter((item) => !queue.some((existing) => existing.id === item.id))]);
      } catch { /* Session might be closing. */ }
    };
    const timer = setInterval(refresh, 1200); return () => { active = false; clearInterval(timer); };
  }, []);
  const changeAccess = (mode: AccessMode) => { setAccessMode(mode); savePolicies({ ...readPolicies(), securityPreset: mode }); void runtimeRef.current?.update({ mode, policies: effectivePolicies(projectPath), routing: readPreferences().workerRouting }); };
  useEffect(() => {
    const changed = (event: Event) => { const preferences = (event as CustomEvent<Preferences>).detail; setAccessMode(preferences.accessMode); void runtimeRef.current?.update({ mode: preferences.accessMode, policies: effectivePolicies(projectPath), routing: preferences.workerRouting }); };
    window.addEventListener("calvras:preferences", changed);
    return () => window.removeEventListener("calvras:preferences", changed);
  }, [projectPath]);
  // Every Settings switch that gates the agent is pushed into the live session, so a
  // rule changed mid-task takes effect on the next action instead of the next chat.
  useEffect(() => {
    const applied = (event: Event) => {
      const policies = (event as CustomEvent<Policies>).detail;
      setAccessMode(policies.securityPreset);
      void runtimeRef.current?.update({ mode: policies.securityPreset, policies: effectivePolicies(projectPath), routing: readPreferences().workerRouting });
    };
    window.addEventListener("calvras:policies", applied);
    return () => window.removeEventListener("calvras:policies", applied);
  }, [projectPath]);
  // The composer labels its own send button with what pressing it will actually do, so the
  // current delivery rule has to be in state rather than re-read from storage on submit.
  const [sendPolicy, setSendPolicy] = useState<Policies["queuedDelivery"]>("interrupt");
  useEffect(() => {
    const sync = () => setSendPolicy(effectivePolicies(projectPath).queuedDelivery);
    sync();
    window.addEventListener("calvras:policies", sync);
    window.addEventListener("calvras:preferences", sync);
    return () => { window.removeEventListener("calvras:policies", sync); window.removeEventListener("calvras:preferences", sync); };
  }, [projectPath]);
  const [folderError, setFolderError] = useState("");
  const [importing, setImporting] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Why the turn on screen is being stopped, so the reply can say that instead of one canned
  // sentence for a pressed button, a newer message taking over, and a run that died on its own.
  const stopReasonRef = useRef<"user" | "replaced">("user");
  useEffect(() => () => { abortControllerRef.current?.abort(); }, []);
  const latestMessageRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Effort level: "Low" | "Medium" | "Max Effort"
  const [effortLevel, setEffortLevel] = useState<string>("Medium");


  // Project badge is display-only; folders are added from the composer.

  // Sync when activeProject changes from context
  useEffect(() => {
    if (activeProject) {
      setProjectPath(activeProject.path);
      setProjectName(activeProject.name);
    }
  }, [activeProject]);

  // The conversation on screen. History and New chat change it through the account store; the
  // id stays null until a fresh chat gets its first message, so History only lists threads
  // that actually have something in them.
  const [chatId, setChatId] = useState<string | null>(null);
  const chatIdRef = useRef<string | null>(null);
  // The conversation this screen believes is open. The effect below reacts to the store changing
  // it, which means a thread that just chose its own id has to move this marker with it: naming a
  // fresh conversation writes it into History, History sets the active id, and that catch-up is
  // not the user switching away. Reading it as a switch aborted the run that had just started and
  // wiped its transcript.
  const openChatRef = useRef<string | null | undefined>(undefined);
  // Set while a transcript is being loaded so restoring a chat cannot re-save it as a change.
  const loadedChatRef = useRef<string | null>(null);
  const applyChatId = (id: string | null) => { chatIdRef.current = id; openChatRef.current = id; setChatId(id); };
  const sessionMemoryKey = () => memoryKeyFor(chatIdRef.current);
  const startNewChat = () => {
    writeSessionMemory(memoryKeyFor(null), { summary: "", covered: 0 });
    triggerNewChat();
  };

  useEffect(() => {
    if (openChatRef.current === activeChatId) return;
    openChatRef.current = activeChatId;
    applyChatId(activeChatId);
    const stored = activeChatId ? chats.find((chat) => chat.id === activeChatId) : undefined;
    loadedChatRef.current = activeChatId;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsLoading(false);
    setMessages(stored ? restoreTranscript(stored.messages) : []);
    if (stored?.projectPath && stored?.projectName) {
      setProjectPath(stored.projectPath);
      setProjectName(stored.projectName);
    }
    if (!activeChatId) {
      // A new conversation starts with no screenshot and no screen to reproduce.
      referenceImageRef.current = "";
      referenceTargetRef.current = false;
    }
  }, [activeChatId, chats]);

  useEffect(() => { localStorage.removeItem("calvras_active_plan"); }, []);

  // Every turn is written back to the account's chat store under this conversation's id, so
  // leaving for History and coming back returns the same thread.
  useEffect(() => {
    if (!chatId || !messages.length) return;
    if (loadedChatRef.current === chatId) { loadedChatRef.current = null; return; }
    saveChat(chatId, { messages: storableTranscript(messages), ...(projectPath && projectName ? { projectPath, projectName } : {}) });
    // saveChat comes from context and is a new function every render; the transcript itself is
    // the only thing that should trigger a write.
  }, [messages, chatId, projectPath, projectName]);

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
    const stopReason = stopReasonRef.current;
    stopReasonRef.current = "user";
    setMessages((prev) =>
      prev.map((m) =>
        !m.done
          ? {
              ...m,
              done: true,
              endedAt: Date.now(),
              status: "stopped",
              stopReason,
              phases: [...m.phases.map((phase) => ({ ...phase, trace: phase.trace.map((node) => node.status === "running" ? { ...node, status: "failed" as const, output: "Stopped waiting. A command already started on the server may still run." } : node) }))],
            }
          : m
      )
    );
  }, []);

  // One-click desktop capture: attaches the real screen as an image for the next turn.
  const handleCaptureScreen = useCallback(async () => {
    const capture = (window as any).__electron?.captureScreen;
    if (typeof capture !== "function") throw new Error("Screen capture is only available in the desktop app.");
    const shot = await capture();
    if (!shot?.image) throw new Error("The screen capture came back empty.");
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(shot.image));
    if (!match) throw new Error("The screen capture was not a readable image.");
    const mime = match[1] || "image/png";
    const payload = match[3] ?? "";
    const bytes = match[2] ? Uint8Array.from(atob(payload), (char) => char.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(payload));
    const blob = new Blob([bytes], { type: mime });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `screen-${stamp}.png`;
    return { file: new File([blob], name, { type: "image/png" }), name, type: "image/png" };
  }, []);

  // ── Main submit handler ────────────────────────────────────────────────────
  const handleSubmit = useCallback(
    async (
      value: string,
      attachmentFiles?: { type: string; url: string; name?: string }[],
      effort = "Balanced",
      directive?: string
    ) => {
      const text = value.trim();
      if (!text && (!attachmentFiles || attachmentFiles.length === 0)) return;
      if (isLoading) {
        const item = { id: crypto.randomUUID(), text, ...(attachmentFiles?.length ? { files: attachmentFiles } : {}), effort, ...(directive ? { directive } : {}) };
        const delivery = effectivePolicies(projectPath).queuedDelivery;
        // "Send Immediately" hands the message to the turn that is already running.
        // Attachments and slash directives still wait, because steering carries text only.
        if (delivery === "immediate" && text && !item.files && !directive) {
          steeringRef.current.push(text);
          setMessages((previous) => [...previous, { id: Date.now(), text, phases: [], done: true, role: "user", status: "finished" }]);
          return;
        }
        // The default takes over. A new prompt while a task runs means the task on screen is no
        // longer the one they want, so it stops where it stands and this turn starts. "Queue"
        // in Settings keeps the old behaviour of holding it above the input until the run ends.
        if (delivery === "queue") {
          writeQueue([...queuedRef.current, item]);
          return;
        }
        stopReasonRef.current = "replaced";
        handleStop();
      }
      if (runtimeRef.current && !await runtimeRef.current.preserveWorkersFor(projectPath)) runtimeRef.current = null;
      steeringRef.current = [];

      setIsLoading(true);
      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Build attached file previews for the bubble
      const attachedForBubble: AttachedFile[] = (attachmentFiles || []).map((a) => ({
        name: a.name || "file",
        type: a.type || "application/octet-stream",
        url: a.url,
      }));

      // The first message names the conversation and puts it in History. Later turns keep
      // writing to that same entry, so one chat is one item the user can come back to.
      if (chatIdRef.current === null) {
        const id = `chat-${Date.now()}`;
        applyChatId(id);
        addRecent({
          id,
          label: (text || attachedForBubble[0]?.name || "Attachment").slice(0, 32) + ((text.length > 32) ? "…" : ""),
          ...(projectPath ? { projectPath } : {}),
          ...(projectName ? { projectName } : {}),
        });
      }

      // Auto-create project folder if needed
      let activePath = projectPath;
      let activeName = projectName;

      // Build conversation history: a compressed memory covers older turns, while the
      // most recent turns stay verbatim so references like "do that" still resolve.
      const priorTurns = messages.filter((m) => m.done);
      const recentTurns = priorTurns.slice(-6);
      const olderTurns = priorTurns.slice(0, Math.max(0, priorTurns.length - 6));
      const conversationHistory = recentTurns
        .flatMap((m) => [
          { role: "user" as const, content: m.text || "(attachment)" },
          {
            role: "assistant" as const,
            content: m.phases.map((phase) => [phase.message?.slice(0, 1200), ...phase.trace.slice(-4).map((node) => JSON.stringify({ action: node.primary, path: node.secondary, output: node.output?.slice(-500), exitCode: node.exitCode, status: node.status }))].filter(Boolean).join("\n")).join("\n\n"),
          },
        ]);

      // Add the initial thinking phase — clean live indicator without fake or hardcoded sentences
      const msgId = Date.now();
      subagentLogRef.current.clear();

      const initialThinkingPhase: AgentPhase = {
        trace: [],
        startedAt: msgId,
        activity: "thinking",
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
      const projectSnapshot = activePath ? `Workspace folder: ${activePath}. Inspect files through tools as needed.` : "";

      // Build media list for AI. PDFs and text-like documents are extracted to text so the
      // model can read them; images go through multimodal parts as before.
      const mediaList: MediaAttachment[] = [];
      const documentContext: string[] = [];
      const extractedTexts = new Map<string, string>();
      if (attachmentFiles && attachmentFiles.length > 0) {
        for (const att of attachmentFiles) {
          const name = att.name || "attachment";
          if (isPdfAttachment(name, att.type)) {
            try { const text = await extractPdfText(att.url); extractedTexts.set(name, text); documentContext.push(`[ATTACHED FILE: ${name}]\n${text}`); }
            catch (error) { console.warn(`[attachments] PDF extraction failed for ${name}: ${error instanceof Error ? `${error.name}: ${error.message} | ${error.stack}` : String(error)}`); documentContext.push(`[ATTACHED FILE: ${name}] (The PDF could not be read.)`); }
            continue;
          }
          if (isTextLikeAttachment(name, att.type)) {
            try { const text = decodeTextDataUrl(att.url).slice(0, 60_000); extractedTexts.set(name, text); documentContext.push(`[ATTACHED FILE: ${name}]\n${text}`); }
            catch (error) { console.warn(`[attachments] Text extraction failed for ${name}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`); documentContext.push(`[ATTACHED FILE: ${name}] (The file could not be read.)`); }
            continue;
          }
          mediaList.push({
            mimeType: att.type || "image/jpeg",
            data: att.url,
          });
        }
      }
      const attachedImages = mediaList.filter((item) => (item.mimeType || "").startsWith("image/"));
      const lastAttached = attachedImages[attachedImages.length - 1];
      if (lastAttached?.data) referenceImageRef.current = lastAttached.data;
      // An image is context until the words around it ask for that screen. Once the
      // conversation has asked for it, later turns in this session inherit the target.
      if (attachedImages.length && asksToReproduce(text)) referenceTargetRef.current = true;

      // Keep the real file inside the workspace, or in the global Calvras vault when no
      // folder is selected, so the agent can reuse it in later turns either way.
      let storedAttachments: { name: string; relativePath: string; type: string; size: number; scope: "workspace" | "vault"; textRelativePath?: string }[] = [];
      if (attachmentFiles?.length) {
        try {
          const response = await fetch("/api/agent/attachments", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectPath: activePath || "", files: attachmentFiles.map((att) => ({ name: att.name || "attachment", type: att.type, dataUrl: att.url, text: extractedTexts.get(att.name || "attachment") })) }),
            signal: controller.signal,
          });
          const data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data.error || "The attachment could not be stored.");
          storedAttachments = data.files || [];
        } catch (error) {
          if (controller.signal.aborted) throw error;
          documentContext.push(`[ATTACHMENT STORAGE FAILED] ${error instanceof Error ? error.message : "The file could not be saved inside Calvras."}`);
        }
      }

      // Recent verified work in this workspace, so the agent continues instead of repeating itself.
      let workspaceJournal = "";
      if (activePath) {
        try {
          const response = await fetch(`/api/agent/journal?projectPath=${encodeURIComponent(activePath)}`, { signal: controller.signal });
          const data = await response.json();
          if (response.ok && data.ok && typeof data.content === "string") workspaceJournal = data.content.slice(-14000);
        } catch (error) {
          if (controller.signal.aborted) throw error;
        }
      }

      // Build the full prompt with conversation history context
      let fullPrompt = text || "(The user sent an attachment, please analyze it)";
      if (conversationHistory.length > 0) {
        const historyStr = conversationHistory
          .slice(-8)
          .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 2000)}`)
          .join("\n");
        fullPrompt = `[CONVERSATION HISTORY]\n${historyStr}\n\n[CURRENT USER MESSAGE]\n${text || "(attachment)"}`;
      }

      // Time context on every message; behavior rules live in the server system prompt.
      const now = new Date();
      const timeStr = now.toLocaleString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      });
      fullPrompt = `[CURRENT TIME]: ${timeStr}\n\n${fullPrompt}`;
      if (directive) fullPrompt = `[TASK DIRECTIVE — how to approach this request]\n${directive}\n\n${fullPrompt}`;
      if (documentContext.length) fullPrompt = `${fullPrompt}\n\n${documentContext.join("\n\n")}`;
      if (storedAttachments.length) {
        const inVault = storedAttachments.every((file) => file.scope === "vault");
        const location = inVault
          ? "saved in the Calvras attachment vault and remain available across chats"
          : "saved inside this workspace";
        const reuse = inVault
          ? "Their extracted text or image is already included for this turn, so review it directly. They remain available in later turns. These belong to the user: do not delete or edit them unless asked."
          : "Use read_image for stored images and read_file for the extracted .txt sidecars. These belong to the user: do not delete or edit them unless asked.";
        fullPrompt = `${fullPrompt}\n\n[STORED ATTACHMENTS]\nThe user's files are ${location} and remain available in later turns:\n${storedAttachments.map((file) => `- ${file.relativePath} (${file.type || "file"}, ${file.size} bytes)${file.textRelativePath ? `; extracted text: ${file.textRelativePath}` : ""}`).join("\n")}\n${reuse}`;
      }

      // Build phases: one phase per agent turn (tools + message)
      const phases: AgentPhase[] = [initialThinkingPhase];
      let currentPhase: AgentPhase | null = initialThinkingPhase;
      // Once the agent starts running tools, its running commentary belongs in the
      // timeline as the expandable Thought block rather than as reply text.
      let toolRounds = 0;
      let liveThought: { node: TraceNode; startedAt: number } | null = null;
      // A free tier can park the model for half an hour while a long queue is still open. That
      // wait is the run's business, but silence looks like a hang, so it says so once per turn.
      let providerWaitSaid = false;

      const publish = () => {
        if (controller.signal.aborted) return;
        setMessages((previous) => previous.map((message) => message.id === msgId ? { ...message, phases: phases.map((phase) => ({ ...phase, trace: [...phase.trace] })) } : message));
      };

      /** The streamed commentary becomes a real Thought row: it collapses to
       * "Thought for Ns" and expands to the sentences the agent actually wrote. */
      const noteThought = (text: string) => {
        if (!currentPhase) { currentPhase = { trace: [], startedAt: Date.now(), activity: "thinking" }; phases.push(currentPhase); }
        if (!liveThought) {
          const node: TraceNode = { id: crypto.randomUUID(), type: "reasoning", status: "running", sentences: [] };
          currentPhase.trace.push(node);
          liveThought = { node, startedAt: Date.now() };
        }
        liveThought.node.sentences = text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean).slice(-5);
      };
      const closeThought = () => {
        if (!liveThought) return;
        const { node, startedAt } = liveThought;
        liveThought = null;
        if (!node.sentences?.length) {
          for (const phase of phases) { const index = phase.trace.indexOf(node); if (index >= 0) phase.trace.splice(index, 1); }
          return;
        }
        node.status = "completed";
        node.durationSeconds = Math.max(0.6, Math.round((Date.now() - startedAt) / 100) / 10);
      };

      // Cross-turn memory: genuinely compress older turns before they fall out of the
      // verbatim window, so a long chat keeps its plan, decisions and unfinished work.
      let sessionMemory = readSessionMemory(sessionMemoryKey());
      const uncovered = olderTurns.slice(Math.min(sessionMemory.covered, olderTurns.length));
      const uncoveredChars = uncovered.reduce((total, turn) => total + turn.text.length + turn.phases.reduce((sum, phase) => sum + (phase.message?.length || 0), 0), 0);
      if (uncovered.length >= 4 || uncoveredChars > 18_000) {
        const divider: AgentPhase = { trace: [], startedAt: Date.now(), divider: { state: "compressing" } };
        phases.splice(0, phases.length, divider);
        currentPhase = null;
        publish();
        let summary = "";
        const transcript = [
          sessionMemory.summary ? `[EXISTING SESSION MEMORY]\n${sessionMemory.summary}` : "",
          ...uncovered.map(digestTurn),
        ].filter(Boolean).join("\n\n").slice(-60_000);
        try {
          summary = (await callAI(`Merge this session into one continuation brief:\n\n${transcript}`, CONTEXT_COMPRESSION_SYSTEM_PROMPT, undefined, undefined, controller.signal, undefined, "Quick")).trim();
        } catch (error) {
          if (controller.signal.aborted) throw error;
        }
        sessionMemory = { summary: (summary || fallbackSessionSummary(sessionMemory.summary, uncovered)).slice(0, 16_000), covered: olderTurns.length };
        writeSessionMemory(sessionMemoryKey(), sessionMemory);
        divider.divider = { state: "compressed" };
        divider.endedAt = Date.now();
        const resumed: AgentPhase = { trace: [], startedAt: Date.now(), activity: "thinking" };
        phases.push(resumed);
        currentPhase = resumed;
        publish();
      }
      if (sessionMemory.summary.trim()) {
        fullPrompt = `[EARLIER SESSION MEMORY — compressed from earlier turns, still true]\n${sessionMemory.summary}\n\n${fullPrompt}`;
      }

      const intent = agentIntent(text, messages.filter((message) => message.done).map((message) => message.text), Boolean(activePath));
      const hasAttachments = Boolean(attachmentFiles?.length);
      // Conversation is decided by what the message asks for, never by whether a folder happens
      // to be open — that is what made "hey" answer with a workspace listing. Anything wanting
      // live or external information stays on the full agent path so it can actually go look.
      const wantsLiveInfo = /\b(search|look\s?up|latest|current|today|this\s+week|news|weather|price|version|changelog|github|gitlab|website|url|http|docs?|documentation)\b/i.test(text);
      const isChatTurn = !intent.requiresTools && !intent.requiresWork && !hasAttachments && !wantsLiveInfo;
      const directAttachmentReview = hasAttachments && !intent.requiresWork;
      if (directAttachmentReview) {
        fullPrompt = `${fullPrompt}\n\n[ATTACHMENT REVIEW MODE] The user's attached file content is already included above — text, PDF text, or the image itself. Review it directly now with actions: [] and status complete. Never call file or workspace tools to read an attachment. Answer the actual question in your own words using the attached evidence, with a direct verdict and specific reasons.`;
      }
      if (isChatTurn) {
        // The rule that stops "hey" becoming a task menu also flattened "what can you do" into three
        // vague lines, so the one question where the list IS the answer gets its own note.
        fullPrompt = `${fullPrompt}\n\n[CONVERSATION MODE] This message is conversation, not file or code work. Reply directly in your own words with actions: [] and status complete. Do not call tools.${asksForCapabilities(text)
          ? " The user is asking what you can do, so name what you actually do: every capability as its own markdown bullet, each one specific about what happens, none left out, then exactly one follow-up question they can answer in a sentence — about something in that list or in what they said. No \"what would you like to work on?\", no \"which of these interests you?\", no second question, no numbered options."
          : " Do not say the words project, folder, workspace, repository, files, or work on. Do not offer a menu of tasks, ask what the user wants to work on, or invite them to assign work. A greeting gets a one-line casual greeting back and nothing else — worded differently from every greeting already in this conversation, and with no emoji unless the user used one first. A question gets a direct answer to the question actually asked, in 1-4 sentences, then stop. That length is about padding, never about shape: when the answer holds two or more items, or the user said list / name / how many / what are they, put each item on its own markdown bullet rather than in one comma-separated sentence, and give all of them."}`;
      }
      if (workspaceJournal.trim() && intent.requiresTools) {
        fullPrompt = `${fullPrompt}\n\n[PROJECT JOURNAL — recent work verified in this workspace]\n${workspaceJournal.trim()}\nStay consistent with this. Anything marked failed or unfinished is not done; verify before claiming it works.`;
      }
      // First encounter with a workspace: map it completely before touching anything — unless the
      // ask is about a page, where the folder is not the subject and scanning it is a delay.
      const seenWorkspaces = (() => { try { return JSON.parse(localStorage.getItem("calvras_seen_workspaces") || "[]") as string[]; } catch { return [] as string[]; } })();
      const firstEncounter = Boolean(activePath) && !seenWorkspaces.includes(activePath!);
      if (firstEncounter && intent.requiresTools && !intent.webFirst) {
        fullPrompt = `[FIRST ENCOUNTER] This workspace has not been explored yet. Before changing anything, understand it: run directory_tree at the root, read_package_json (or the equivalent manifest), the entry point, the main configs, and the README when present. Read broadly until you know the layout, then implement the request.\n\n${fullPrompt}`;
      }
      const initialActions = firstEncounter && intent.requiresTools && !intent.webFirst
        ? [{ type: "directory_tree", path: "." } as AgentAction, { type: "read_package_json", path: "." } as AgentAction]
        : intent.initialActions;
      // After repeated command failures, steer the agent to research the real error
      // instead of burning the run on identical retries.
      let terminalFailureStreak = 0;
      const recordTerminalResult = (terminal: boolean, ok: boolean) => {
        if (!terminal) return;
        terminalFailureStreak = ok ? 0 : terminalFailureStreak + 1;
        if (terminalFailureStreak < 2) return;
        terminalFailureStreak = 0;
        steeringRef.current.push("[SYSTEM] Two terminal actions failed in a row. Stop retrying the same approach. Read the actual error above, then use web_search or search_documentation to confirm the command, API, or version, and re-read the relevant files. For a web task, use check_console_errors and read_page to see what actually failed. Change the approach based on that evidence. If no working path exists, explain the blocker instead of repeating the attempt.");
      };
      type PreviewInspection = {
        ok: boolean;
        healthy: boolean;
        issues: string[];
        url: string;
        title: string;
        text: string;
        consoleErrors: string[];
        screenshot: boolean;
        layout?: Record<string, unknown> | null;
        error?: string;
      };
      // Loads, probes and captures the visible preview. Completion is gated on
      // this result, so it must reflect the real rendered page, not the server.
      const inspectPreview = async (url: string, options: { reload?: boolean; node?: TraceNode } = {}): Promise<PreviewInspection> => {
        const node: TraceNode = options.node ?? { id: crypto.randomUUID(), type: "tool", toolName: "check_preview", primary: "Looking at the preview", secondary: url, mono: true, status: "running" };
        if (!options.node) currentPhase?.trace.push(node);
        node.status = "running";
        delete node.durationMs;
        node.secondary = url;
        publish();
        const started = Date.now();
        const errorFloor = browserBridge.getConsoleErrors().length;
        const loaded = await browserBridge.preview(url, options.reload ? { reload: true } : undefined).catch(() => null);
        if (!loaded?.ok) {
          node.status = "failed";
          node.durationMs = Date.now() - started;
          node.output = `The preview did not load at ${url}.`;
          publish();
          return { ok: false, healthy: false, url, title: "", text: "", consoleErrors: [], screenshot: false, issues: ["The preview page did not load in the browser panel."], error: "The preview did not load in the browser panel." };
        }
        // Give the first render, styles and hydration a moment to settle before judging it.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const [layout, shot] = await Promise.all([
          browserBridge.probe().catch(() => null),
          browserBridge.screenshot(false).catch(() => null),
        ]);
        const consoleErrors = browserBridge.getConsoleErrors().slice(errorFloor).slice(-20);
        const health = evaluatePreviewHealth(layout, consoleErrors);
        const text = String(layout?.text || "").replace(/\s+/g, " ").trim();
        const pageUrl = String(layout?.url || loaded.url || url);
        const title = String(layout?.title || loaded.title || "");
        node.status = health.healthy ? "completed" : "failed";
        node.durationMs = Date.now() - started;
        node.output = [
          `Preview ${health.healthy ? "verified" : "needs work"}: ${title || pageUrl}`,
          `URL: ${pageUrl}`,
          layout ? `Layout: ${layout.textLength ?? 0} chars of text, ${layout.visibleElements ?? 0} visible elements, ${layout.richElements ?? 0} media/interactive, ${layout.styleTags ?? 0} inline styles, ${layout.stylesheetLinks ?? 0} stylesheet links.` : "Layout: could not be inspected.",
          text ? `Visible page text:\n${text.slice(0, 3000)}` : "Visible page text: (none)",
          health.issues.length ? `Problems:\n${health.issues.map((issue) => `- ${issue}`).join("\n")}` : "Problems: none",
          consoleErrors.length ? `Console errors:\n${consoleErrors.map((entry) => `- ${entry}`).join("\n")}` : "Console errors: none",
        ].filter(Boolean).join("\n");
        if (shot?.image) {
          node.image = shot.image;
          // Drop the oldest picture, never the newest: the last screenshots are the ones that
          // describe the page as it is now, and losing them sends the agent back to searching.
          if (mediaList.length >= 3) mediaList.shift();
          mediaList.push({ mimeType: shot.mimeType || "image/png", data: shot.image });
        }
        publish();
        return {
          ok: true,
          healthy: health.healthy,
          issues: health.issues,
          url: pageUrl,
          title,
          text: text.slice(0, 1800),
          consoleErrors: consoleErrors.slice(0, 10),
          screenshot: Boolean(shot?.image),
          layout: layout ? {
            textLength: layout.textLength,
            visibleElements: layout.visibleElements,
            richElements: layout.richElements,
            styleTags: layout.styleTags,
            stylesheetLinks: layout.stylesheetLinks,
            stylesheetCount: layout.stylesheetCount,
            overlay: layout.overlay || "",
          } : null,
        };
      };
      let compressionPhase: AgentPhase | null = null;
      // Settings the model must know about; the runtime enforces the same rules regardless.
      const turnNotes = policyNotes(effectivePolicies(activePath || projectPath));
      const turnSystem = isChatTurn ? CHAT_SYSTEM_PROMPT : turnNotes ? `${CALVRAS_SYSTEM_PROMPT}\n${turnNotes}` : undefined;
      const outcome = await runAgent({
        prompt: fullPrompt,
        requiresTools: directAttachmentReview && !activePath ? false : intent.requiresTools,
        requiresWork: directAttachmentReview && !activePath ? false : intent.requiresWork,
        signal: controller.signal,
        initialActions: directAttachmentReview && !activePath ? [] : initialActions,
        finishOnServerReady: intent.finishOnServerReady,
        hasReferenceImage: Boolean(referenceImageRef.current) && referenceTargetRef.current,
        getSteering: () => steeringRef.current.splice(0),
        compress: async (transcript) => callAI(
          `Re-summarize this agent working session so it can continue without restarting. Preserve the task, completed work, concrete paths and commands, decisions, failures and exact next steps. Do not invent anything.\n\n${transcript}`,
          CONTEXT_COMPRESSION_SYSTEM_PROMPT,
          undefined, undefined, controller.signal, undefined, "Quick"
        ),
        onCompression: (state) => {
          if (state === "compressing") {
            if (currentPhase) { currentPhase.endedAt = Date.now(); currentPhase = null; }
            compressionPhase = { trace: [], startedAt: Date.now(), divider: { state: "compressing" } };
            phases.push(compressionPhase);
          } else if (compressionPhase) {
            compressionPhase.divider = { state: "compressed" };
            compressionPhase.endedAt = Date.now();
            compressionPhase = null;
            currentPhase = { trace: [], startedAt: Date.now(), activity: "thinking" };
            phases.push(currentPhase);
          }
          publish();
        },
        infer: async (prompt, onDelta) => {
          if (!currentPhase) { currentPhase = { trace: [], startedAt: Date.now(), activity: "thinking" }; phases.push(currentPhase); }
          // Only a phase that has not run a single tool is "thinking". Composing the next
          // step after real work has started is still work, so the indicator stays Working.
          else if (!currentPhase.trace.some((node) => node.type !== "reasoning")) currentPhase.activity = "thinking";
          publish();
          // A chat turn never needs the workspace runtime booted, and the folder context is the
          // thing that tempts the model into describing their project back at them. A page task
          // doesn't either: the tools that need the folder boot it themselves when one is asked for.
          if (activePath && !isChatTurn && !intent.webFirst) await ensureRuntime(activePath, text);
          // A rate-limited or dropped provider is this run's problem, not the user's, and a
          // ten-minute budget is how a three-hour task dies — a free tier parks itself for half an
          // hour and says so. Wait it out: longer pauses for a provider that named a reset window,
          // short ones for a blip, every pause checked against the stop button, and the user never
          // sees the provider's name or a sentence telling them to send the message again.
          const patientSince = Date.now();
          for (let attempt = 0; ; attempt++) {
            try {
              return await callAI(prompt, turnSystem, mediaList, isChatTurn ? "" : `${projectSnapshot}\n${runtimeRef.current?.context || ""}`, controller.signal, onDelta, isChatTurn ? "Quick" : effort);
            } catch (error) {
              const reason = error instanceof Error ? error.message : "";
              if (!isProviderTrouble(reason) || controller.signal.aborted) throw error;
              if (Date.now() - patientSince > PROVIDER_PATIENCE_MS) {
                // Out of patience, still out of credit. Hand the round back with no actions so
                // the loop reports the agent's own last line instead of the provider's failure.
                return '{"message":"","actions":[],"status":"blocked"}';
              }
              const waitMs = patientBackoffMs(reason, attempt);
              if (!providerWaitSaid && (waitMs >= 30_000 || Date.now() - patientSince > 60_000)) {
                providerWaitSaid = true;
                noteThought("The model is at its limit right now, so I'm waiting it out instead of stopping. Nothing for you to resend.");
                publish();
              }
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              if (controller.signal.aborted) throw error;
            }
          }
        },
        onMessageDelta: (message) => {
          if (!currentPhase) { currentPhase = { trace: [], startedAt: Date.now() }; phases.push(currentPhase); }
          if (toolRounds === 0) currentPhase.message = message;
          else noteThought(message);
          publish();
        },
        onFeedback: (message) => {
          if (!currentPhase) {
            currentPhase = { trace: [], startedAt: Date.now() };
            phases.push(currentPhase);
          }
          if (!message.trim()) return;
          // The first update reads as the reply. Once the agent is working, its running
          // commentary belongs to the Thought row instead of repeating as an answer.
          if (toolRounds === 0) currentPhase.message = message;
          else noteThought(message);
          publish();
        },
        onPhaseComplete: (message, final) => {
          closeThought();
          // An interim update already lives in the timeline; only the closing reply
          // is written out as the message under the header.
          if (final === false) { publish(); return; }
          // Phase complete: finalize current phase with its message
          if (currentPhase) {
            currentPhase.message = message;
            currentPhase.endedAt = Date.now();
            currentPhase = null;
            publish();
          } else if (message.trim()) {
            // The final summary frequently repeats the last progress update verbatim —
            // keep a single record instead of rendering the same sentence twice.
            const previous = phases[phases.length - 1];
            if (previous?.message?.trim() === message.trim()) return;
            // Message without tools (e.g. final answer with no actions) — create a message-only phase
            phases.push({ trace: [], message, startedAt: Date.now(), endedAt: Date.now() });
            publish();
          }
        },
        execute: async (actions) => {
          closeThought();
          toolRounds += 1;
          if (!currentPhase) {
            currentPhase = { trace: [], startedAt: Date.now() };
            phases.push(currentPhase);
          }
          currentPhase.activity = "working";
          publish();
          const browserOnlyTurn = hasInAppBrowser() && accessMode === "full" && actions.length > 0 && actions.every((action) => isInAppBrowserTool(action.type));
          if (!activePath && !browserOnlyTurn) {
            const canCreate = actions.some((action) => action.type === "create_file" || action.type === "write_file") && !actions.some((action) => action.type === "read_file" || action.type === "list_dir");
            if (!canCreate) {
              // No workspace: skip project actions instead of hardcoding a user-facing
              // folder demand. The model sees this note and answers in its own words.
              const notice = hasAttachments
                ? "The user's attachment is already included in your context, so this tool call was skipped and is not needed. Review the attachment directly and answer the user's actual question now with actions: [] and status complete. Do not mention tooling, directories, or workspaces."
                : intent.requiresTools
                ? "No project folder is selected, so this project action was not run. If the task truly needs existing files, ask for a folder in your own words. If it starts a new build, use create_file or write_file and the user will be asked where that folder should live before anything is created. Otherwise answer the user directly without tools."
                : "This message is conversation, not file work. The action was skipped. Answer the user's message directly in your own words with actions: [] and status complete. Do not call tools, mention directories or workspaces, or ask what work the user wants.";
              return actions.map((action) => ({ action, ok: false, result: { skipped: true, noWorkspace: true, error: notice } }));
            }
            // Nothing is open, so the folder has to be the user's decision, not a side effect of
            // the model returning a write. Deny it and the build simply has nowhere to go yet.
            const projectName = projectNameFrom(text);
            // "Always allow" on this card writes the create-file rule, and this gate reads it back,
            // so the click lands once and holds — and Settings is still the only place to revoke it.
            const answer = effectivePolicies(null).toolRules["create_file"] === "allow" ? "once"
              : await askDecision({ id: crypto.randomUUID(), kind: "approval", local: true, question: `Create a new project folder "${projectName}" and build there?`, reason: "No folder is open, so this build has nowhere to live yet. Deny it and tell Calvras where to work instead.", action: { type: "create_file", path: projectName } }, "", controller.signal);
            if (!answer || answer === "deny") {
              const notice = "The user did not allow a new project folder, so nothing was created and no file was written. Ask them in your own words where this work should live, or answer without files. Do not retry creating a folder in this turn.";
              return actions.map((action) => ({ action, ok: false, result: { skipped: true, noWorkspace: true, error: notice } }));
            }
            const response = await fetch("/api/fs/create-project", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: projectName }), signal: controller.signal });
            const data = await response.json();
            if (!response.ok || !data.ok || !data.projectPath) throw new Error(data.error || "Could not create a workspace.");
            activePath = data.projectPath;
            activeName = data.name;
            setProjectPath(activePath);
            setProjectName(activeName);
            addProject({ name: data.name, path: data.projectPath });
          }

          return executeInOrder(actions, async (action) => {
            controller.signal.throwIfAborted();
            const isTerminal = TOOL_RISK[action.type] === "execute" || action.type.startsWith("git_");
            const node: TraceNode = { id: crypto.randomUUID(), type: isTerminal ? "terminal" : "tool", toolName: action.type, mono: true, primary: humanToolLabel(action), secondary: action.command || action.path || action.from || action.url || ".", status: "running", ...(isTerminal ? { command: action.command ?? action.message ?? action.branch ?? action.url ?? action.type } : {}) };
            if (currentPhase) currentPhase.trace.push(node);
            publish();
            const started = Date.now();
            try {
              const usesVisibleBrowser = hasInAppBrowser() && accessMode === "full" && isInAppBrowserTool(action.type);
              let data: any;
              if (action.type === "use_user_file") {
                const root = activePath || projectPath;
                if (!root) data = { ok: false, error: "Select a workspace folder before bringing a document in." };
                else {
                  try {
                    const imported = await (window as any).__electron.importUserFile(root, String(action.path ?? ""));
                    const reader = (window as any).__electron.readWorkspaceFile;
                    let text = "";
                    if (/\.(pdf)$/i.test(imported.relativePath)) {
                      const { dataUrl } = await reader(root, imported.relativePath);
                      text = await extractPdfText(dataUrl);
                    } else if (isTextLikeAttachment(imported.relativePath, "")) {
                      const { dataUrl } = await reader(root, imported.relativePath);
                      text = decodeTextDataUrl(dataUrl);
                    }
                    data = {
                      ok: true,
                      path: imported.relativePath,
                      fileName: imported.relativePath.split("/").pop(),
                      copiedInside: imported.copied,
                      text: text ? text.slice(0, 24000) : undefined,
                      note: text
                        ? "Use this text to answer the site's questions. Upload it with upload_file_to_page using this exact path."
                        : "The document is now inside the workspace; attach it with upload_file_to_page using this exact path. Its text could not be extracted, so ask the user for an answer you cannot read.",
                    };
                  } catch (error) {
                    data = { ok: false, error: error instanceof Error ? error.message : "That file could not be used." };
                  }
                }
              } else if (action.type === "compare_to_reference") {
                const reference = referenceImageRef.current;
                if (!hasInAppBrowser()) data = { ok: false, error: "compare_to_reference measures the app's visible preview. Get the page loaded in the panel first (start_server, then check_preview)." };
                else if (!reference) data = { ok: false, error: "The user has not sent a screenshot in this session, so there is nothing to compare the render against." };
                else {
                  revealBrowserPanel(false);
                  try { data = await browserBridge.compareWithReference(reference); }
                  catch (error) { data = { ok: false, error: error instanceof Error ? error.message : "The page could not be measured against the screenshot." }; }
                }
              } else if (action.type === "check_preview") {
                const previewUrl = serverPreviewUrlRef.current || browserBridge.getSnapshot().url;
                if (!hasInAppBrowser() || !/^https?:/i.test(previewUrl)) {
                  data = { ok: false, error: "No server preview is open yet. Start the server with start_server, then check_preview." };
                } else {
                  revealBrowserPanel(false);
                  const inspection = await inspectPreview(previewUrl, { reload: true, node });
                  data = { ...inspection, preview: inspection };
                }
              } else if (usesVisibleBrowser) {
                // The split panel is the agent's browser: show it, lock it for the
                // duration of the task, and let the agent drive the real page.
                revealBrowserPanel(true);
                // Full access runs these here instead of through the runtime, so the
                // Settings rules have to be checked at this boundary too.
                const rules = effectivePolicies(activePath || projectPath);
                const targetHost = urlHost(action.url) || urlHost(browserBridge.getSnapshot().url);
                const blocker = blockReason(rules, action.type, targetHost, true);
                if (blocker) data = { ok: false, error: blocker };
                else if (action.type === "run_page_script" && rules.browserJs === "ask" && rules.toolRules["run_page_script"] !== "allow") {
                  const choice = await askDecision({ id: crypto.randomUUID(), kind: "approval", local: true, question: `Run this JavaScript on ${targetHost || "the open page"}?`, reason: "The page script can read and change anything on the site you are looking at.", action }, "", controller.signal);
                  data = choice && choice !== "deny" ? await browserBridge.execute(action.type, action, activePath)
                    : { ok: false, error: "The user did not allow running JavaScript on this page. Use click_element, fill_input or press_page_key instead." };
                }
                else data = await browserBridge.execute(action.type, action, activePath);
              } else {
                const client = await ensureRuntime(activePath!, text);
                data = await client.execute(action, controller.signal, (output) => { node.output = ((node.output || "") + output).slice(-32000); publish(); });
              }
              const ok = data.ok === true;
              node.status = action.type === "check_preview" ? (data.healthy === true ? "completed" : "failed")
                : action.type === "compare_to_reference" ? (data.matched === true ? "completed" : "failed")
                : ok ? "completed" : "failed";
              node.durationMs = Date.now() - started;
              recordTerminalResult(isTerminal, ok);
              if (data.checkpointId) node.checkpointId = data.checkpointId;
              if (data.image) {
                node.image = data.image;
                if (mediaList.length >= 3) mediaList.shift();
                mediaList.push({ mimeType: data.mimeType || "image/png", data: data.image });
              }
              if (data.url && data.ready) node.previewUrl = data.url;
              const serverTool = action.type === "start_dev_server" || action.type === "start_server" || action.type === "check_server";
              if (serverTool && ok && data.ready === true && typeof data.url === "string" && data.url && hasInAppBrowser()) {
                const firstReady = serverPreviewUrlRef.current !== data.url;
                serverPreviewUrlRef.current = data.url;
                // A check_server poll only reveals the panel the first time this URL
                // becomes ready, so closing the preview does not fight the user.
                if (firstReady || action.type !== "check_server") {
                  revealBrowserPanel(false);
                  data.preview = await inspectPreview(data.url);
                }
              }
              if (ok && Array.isArray(data.diffRows)) {
                node.diffRows = data.diffRows;
                node.diffFile = action.path || data.path;
                node.add = data.diffRows.filter((row: { type: string }) => row.type === "add").length;
                node.del = data.diffRows.filter((row: { type: string }) => row.type === "del").length;
              }
              if (isTerminal) {
                // run_command returns exitCode; git/run routes return output string
                node.exitCode = data.exitCode ?? (data.ok ? 0 : 1);
                node.output = data.output || data.error || "";
              } else if (action.type === "read_page" && typeof data.text === "string") {
                const links = Array.isArray(data.links) ? data.links.map((link: any) => `- ${link.text || "(link)"}: ${link.href}`).join("\n") : "";
                node.output = `${data.title || ""}\n${data.url || ""}\n\n${data.text}${links ? `\n\nLinks:\n${links}` : ""}`.trim();
              } else if (action.type === "search_documentation" && data.url) {
                node.type = "search";
                node.sources = [{ name: String(action.url), url: String(data.url) }];
                node.output = `${data.url}\n\n${data.content}`;
              } else if (data.content !== undefined) {
                node.output = data.content;
                node.codeSnippet = String(data.content);
              } else if (action.type === "web_search" && Array.isArray(data.results)) {
                // Every chip below is a URL the engine actually returned, so the user can check
                // the citation instead of trusting the model's summary of it.
                node.type = "search";
                node.sources = data.results.map((item: { title: string; url: string }) => ({ name: item.title, url: item.url }));
                node.output = [
                  `${data.engine || "Search"} returned ${data.results.length} result${data.results.length === 1 ? "" : "s"} for "${data.query}".`,
                  ...data.results.map((item: { title: string; url: string; snippet: string }) => `- ${item.title}\n  ${item.url}${item.snippet ? `\n  ${item.snippet}` : ""}`),
                ].join("\n");
              } else if (Array.isArray(data.results)) {
                // search_files: array of { file, line, text }
                node.output = data.results.map((r: { file: string; line: number; text: string }) => `${r.file}:${r.line}: ${r.text}`).join("\n");
              } else if (Array.isArray(data.files)) {
                // find_files: array of file path strings
                node.output = data.files.join("\n");
              } else if (Array.isArray(data.entries)) {
                node.output = data.entries.map((entry: { name?: string; path?: string; type: string }) => `${entry.type}: ${entry.path || entry.name}`).join("\n");
              } else if (action.type === "check_preview") {
                node.output = node.output || data.error || JSON.stringify(data);
              } else if (action.type === "compare_to_reference") {
                node.output = data.error || (data.fidelity ? fidelityNote(data.fidelity) : JSON.stringify(data));
              } else {
                node.output = data.error || JSON.stringify(data);
              }
              if (action.type !== "check_preview" && Array.isArray(data.consoleErrors) && data.consoleErrors.length) {
                node.output = `${node.output ? `${node.output}\n\n` : ""}Browser console errors:\n${data.consoleErrors.map((item: string) => `- ${item}`).join("\n")}`;
              }
              publish();
              return { action, ok, result: data };
            } catch (error) {
              node.status = "failed";
              node.durationMs = Date.now() - started;
              recordTerminalResult(isTerminal, false);
              node.output = controller.signal.aborted ? "Stopped waiting for this action. A command already started on the server may still run." : error instanceof Error ? error.message : "Action failed.";
              if (!controller.signal.aborted) { publish(); return { action, ok: false, result: { error: node.output } }; }
              else throw error;
            }
          }, controller.signal);
        },
      }).catch((error): AgentOutcome => {
        // Nothing a run throws is the user's to read. The turn closes cleanly on the agent's
        // own last line, and the working indicator stops instead of hanging on a dead promise.
        console.warn(`[agent run ended unexpectedly] ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
        return controller.signal.aborted ? { status: "stopped" } : { status: "blocked" };
      });
      if (abortControllerRef.current !== controller) return;
      // outcome.message is already handled by onPhaseComplete — don't add duplicate phase here
      setMessages((previous) => previous.map((message) => message.id === msgId ? { ...message, phases, done: true, status: outcome.status, subagents: [...subagentLogRef.current.values()].filter((job) => (job.startedAt ?? 0) >= msgId), ...(outcome.error ? { error: outcome.error } : {}), ...(outcome.openSteps ? { openSteps: outcome.openSteps } : {}), endedAt: Date.now() } : message));
      // Persist a compact receipt so later turns know what was actually verified.
      if (activePath && !controller.signal.aborted && outcome.status !== "stopped" && (intent.requiresTools || phases.some((phase) => phase.trace.length))) {
        const actionLines = phases.flatMap((phase) => phase.trace.map((node) => `${node.status === "completed" ? "ok" : "FAILED"} ${node.primary} — ${String(node.secondary || "").slice(0, 180)}`));
        const lastMessage = [...phases].reverse().find((phase) => phase.message?.trim())?.message || "";
        const entry = [
          `**Request:** ${(text || "(attachment)").slice(0, 600)}`,
          `**Outcome:** ${outcome.status}${outcome.error ? ` — ${outcome.error.slice(0, 400)}` : ""}`,
          ...(actionLines.length ? ["**Actions:**", ...actionLines.slice(-25)] : []),
          ...(lastMessage ? [`**Final message:** ${lastMessage.slice(0, 600)}`] : []),
        ].join("\n");
        void fetch("/api/agent/journal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectPath: activePath, text: entry }) }).catch(() => {});
      }
      setIsLoading(false);
      abortControllerRef.current = null;
      recordUsage("task", `${outcome.status}: ${(text || "(attachment)").slice(0, 60)}${activePath ? ` in ${activePath.split(/[\\/]/).pop()}` : ""}`);
      if (readPolicies().telemetry) void reportTurn({ prompt: text || "(attachment)", status: outcome.status, seconds: Math.round((Date.now() - msgId) / 1000), phases });
      if (outcome.status === "finished" || outcome.status === "blocked") playCompletionChimeWhenUnfocused();
      if (firstEncounter && activePath && outcome.status === "finished") {
        try {
          const list = JSON.parse(localStorage.getItem("calvras_seen_workspaces") || "[]") as string[];
          if (!list.includes(activePath)) {
            list.push(activePath);
            localStorage.setItem("calvras_seen_workspaces", JSON.stringify(list.slice(-50)));
          }
        } catch { /* storage unavailable */ }
      }
      if (outcome.status === "finished") void (runtimeRef.current as RuntimeClient | null)?.update({ finished: true });
    },
    [projectPath, projectName, isLoading, addProject, addRecent, messages, ensureRuntime, writeQueue, handleStop]
  );
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  // A task finishing releases exactly one queued message, so six of them go out one
  // after each completed task rather than all at once.
  useEffect(() => {
    if (isLoading) return;
    const next = queuedRef.current[0];
    if (!next) return;
    writeQueue(queuedRef.current.slice(1));
    void handleSubmitRef.current(next.text, next.files, next.effort, next.directive);
  }, [isLoading, writeQueue]);

  // Scheduled work is claimed only when the conversation is genuinely idle, so a run that comes
  // due mid-task waits for the next poll instead of cutting into what the user is watching.
  useEffect(() => {
    if (!projectPath) { setScheduled([]); return; }
    let active = true;
    const read = async () => {
      try {
        const result = await (await fetch(`/api/agent/schedule?projectPath=${encodeURIComponent(projectPath)}`)).json();
        if (active && result?.ok) setScheduled(result.entries || []);
      } catch { /* the folder may be closing; the next poll tries again */ }
    };
    const poll = async () => {
      if (!active || isLoadingRef.current || queuedRef.current.length || pendingScheduledRef.current) return;
      try {
        const result = await (await fetch("/api/agent/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "claim", projectPath }) })).json();
        if (!active || !result?.ok) return;
        setScheduled(result.entries || []);
        const run = (result.due || [])[0] as ScheduledRunView | undefined;
        if (!run) return;
        // It enters through the same path as a typed message, so intent, permissions and the
        // verification gates apply to work started by a clock exactly as to work started by hand.
        pendingScheduledRef.current = run;
        void handleSubmitRef.current(run.prompt);
      } catch { /* a schedule the server cannot read is left untouched */ }
    };
    void read();
    const timer = setInterval(() => void poll(), 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [projectPath]);

  // A scheduled turn is closed out with the status its own turn actually reached, so the ledger
  // records a stopped or blocked run instead of assuming the appointment was kept.
  useEffect(() => {
    if (isLoading || !projectPath) return;
    const run = pendingScheduledRef.current;
    if (!run) return;
    const turn = messages[messages.length - 1];
    if (!turn?.done || String(turn.text || "") !== run.prompt) return;
    pendingScheduledRef.current = null;
    const note = [...(turn.phases || [])].reverse().find((phase) => phase.message?.trim())?.message || turn.error || "";
    void fetch("/api/agent/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "report", projectPath, id: run.id, status: turn.status || "finished", note }) })
      .then(async (response) => { const result = await response.json(); if (result?.ok) setScheduled(result.entries || []); })
      .catch(() => { /* the run stays recorded as started and the panel shows that */ });
  }, [isLoading, messages, projectPath]);

  const sendQueuedNow = useCallback((id: string) => {
    const next = queuedRef.current.find((item) => item.id === id);
    if (!next) return;
    writeQueue(queuedRef.current.filter((item) => item.id !== id));
    if (isLoading) {
      steeringRef.current.push(next.text);
      setMessages((previous) => [...previous, { id: Date.now(), text: next.text, phases: [], done: true, role: "user", status: "finished" }]);
      return;
    }
    void handleSubmitRef.current(next.text, next.files, next.effort, next.directive);
  }, [isLoading, writeQueue]);

  // Pausing, resuming and cancelling are writes to the same ledger the agent's own scheduling
  // tools use, so the panel and the model can never disagree about what is appointed.
  const changeSchedule = useCallback(async (id: string, action: "pause" | "resume" | "cancel") => {
    if (!projectPath) return;
    const body = action === "cancel" ? { action: "remove", projectPath, id } : { action: "enable", projectPath, id, enabled: action === "resume" };
    const result = await (await fetch("/api/agent/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
    if (!result?.ok) throw new Error(result?.error || "The scheduled run is still stored as it was.");
    setScheduled(result.entries || []);
  }, [projectPath]);

  const discardQueued = useCallback((id: string) => {
    writeQueue(queuedRef.current.filter((item) => item.id !== id));
  }, [writeQueue]);
  // ── Folder import: the picker lives in the composer, not the header ────────
  const adoptProject = useCallback((data: { name: string; projectPath: string }) => {
    const project = { name: data.name, path: data.projectPath };
    setProjectPath(project.path);
    setProjectName(project.name);
    setActiveProject(project);
    addProject(project);
    runtimeRef.current = null;
  }, [addProject, setActiveProject]);

  const importFolderFiles = useCallback(async (files: File[]) => {
    if (importing) return;
    if (!files.length) { setFolderError("That folder has no files in it yet, so there is nothing to bring in."); return; }
    const usable = files.filter((file) => !(file.webkitRelativePath || file.name).split(/[\\/]/).some((part) => ["node_modules", ".git", ".env"].includes(part) || part.startsWith(".env.")));
    if (!usable.length) { setFolderError("That folder only holds dependencies and hidden files, which Calvras does not copy."); return; }
    if (usable.length > 2000 || usable.reduce((total, file) => total + file.size, 0) > 50 * 1024 * 1024) { setFolderError("Choose a folder with up to 2,000 files and 50 MB."); return; }
    setImporting(true);
    setFolderError("");
    try {
      const form = new FormData();
      form.append("name", usable[0]?.webkitRelativePath.split("/")[0] || "project");
      usable.forEach((file) => form.append("files", file, file.webkitRelativePath || file.name));
      adoptProject(await requestImport("/api/fs/import", form));
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : "Unable to import folder.");
    } finally {
      setImporting(false);
    }
  }, [importing, adoptProject]);

  /** The native picker is the only way to choose a folder that is still empty, so on the
   *  desktop it replaces the browser's directory input; the server copies the tree itself. */
  const pickProjectFolder = useCallback(async () => {
    if (importing) return;
    let picked: string | null = null;
    try { picked = await (window as any).__electron?.pickFolder?.() ?? null; } catch { return; }
    if (!picked) return;
    setImporting(true);
    setFolderError("");
    try {
      adoptProject(await requestImport("/api/fs/import-path", JSON.stringify({ path: picked }), { "content-type": "application/json" }));
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : "Unable to import folder.");
    } finally {
      setImporting(false);
    }
  }, [importing, adoptProject]);

  const clearFolder = useCallback(() => {
    setActiveProject(null);
    setProjectPath(null);
    setProjectName(null);
    runtimeRef.current = null;
    setFolderError("");
  }, [setActiveProject]);

  const resetConversation = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    void runtimeRef.current?.stop();
    runtimeRef.current = null;
    setApprovalQueue([]);
    setIsLoading(false);
    writeQueue([]);
    // The conversation being left behind stays in History with its own transcript; this only
    // starts a fresh one.
    startNewChat();
  }, [writeQueue]);

  const handleSlashAction = useCallback((id: string) => {
    if (id === "new-chat") { resetConversation(); return; }
    if (id === "tasks") { setTasksOpen(true); setSidechatOpen(false); return; }
    if (id === "sidechat") { setSidechatOpen(true); setTasksOpen(false); return; }
    if (id === "terminal") { setTasksOpen(false); setTerminalOpen(true); return; }
    if (id === "browser") {
      if (browserAvailable) revealBrowserPanel(false);
      else setFolderError("The browser panel is only available in the desktop app.");
    }
  }, [browserAvailable, openDock, resetConversation]);

  const latestSteps: TaskStep[] = (() => {
    const withTrace = [...messages].reverse().find((message) => message.phases.some((phase) => phase.trace.length));
    const trace = withTrace?.phases.flatMap((phase) => phase.trace).slice(-14) || [];
    return trace.map((node, index) => ({
      id: node.id || `step-${index}`,
      label: node.primary || node.toolName || node.type,
      ...(node.secondary ? { detail: node.secondary } : {}),
      status: node.status || "pending",
    }));
  })();
  // ── Build ChapterScrubber chapters from message history ───────────────────
  const getProgress = useCallback(() => {
    const active = [...messages].reverse().find((message) => !message.done);
    const completedChats = messages.filter((message) => message.done).length;
    if (!isLoading && !active) {
      return `No task is currently running. Completed requests this session: ${completedChats}. ${projectName ? `Working folder: ${projectName}.` : "No folder selected."}`;
    }
    const phases = active?.phases ?? [];
    const trace = phases.flatMap((phase) => phase.trace.filter((node) => !["reasoning", "step"].includes(node.type)));
    const completed = trace.filter((node) => node.status === "completed").length;
    const failed = trace.filter((node) => node.status === "failed").length;
    const running = trace.filter((node) => node.status === "running" || node.status === "pending").map((node) => `${node.primary}${node.secondary ? ` (${node.secondary})` : ""}`);
    const lastUpdate = [...phases].reverse().find((phase) => phase.message?.trim())?.message?.trim() || "";
    const elapsed = active?.startedAt ? Math.max(1, Math.round((Date.now() - active.startedAt) / 1000)) : 0;
    // The pool reports a group per role with its own jobs, so the sidechat is given the job
    // statuses rather than a field that does not exist on the group.
    const workers = JSON.stringify((runtimeState.agents || []).map((group: any) => ({
      role: group.role,
      running: group.active ? String(group.active.task || "").slice(0, 120) : null,
      queued: group.queued ?? 0,
      last: group.jobs?.length ? { status: group.jobs.at(-1)?.status, task: String(group.jobs.at(-1)?.task || "").slice(0, 120) } : null,
    })));
    return [
      `Status: the agent is actively working (about ${elapsed}s elapsed on this request).`,
      `Folder: ${projectName || "none"}.`,
      `Tool actions so far: ${trace.length} total, ${completed} completed, ${failed} failed.`,
      running.length ? `Currently running: ${running.join(", ")}` : "Currently between actions (thinking).",
      trace.length ? `Recent sequence: ${trace.slice(-10).map((node) => `${node.status}:${node.primary}`).join(" → ")}` : "",
      lastUpdate ? `Latest update shown to the user: ${lastUpdate.slice(0, 500)}` : "",
      workers !== "[]" ? `Workers: ${workers}` : "",
    ].filter(Boolean).join("\n");
  }, [messages, isLoading, projectName, runtimeState]);

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
      data-browser={dockOpen ? "open" : "closed"}
      data-terminal={terminalOpen ? "open" : "closed"}
      style={{ overflow: "hidden" }}
    >
      {/* ── Hide global scrollbar, use inner scroll only ────────────────── */}
      <style dangerouslySetInnerHTML={{ __html: `
        html, body { overflow: hidden !important; scrollbar-width: none !important; }
        html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }
        .chat-scroll-area { overflow-y: auto; scrollbar-width: none; }
        .chat-scroll-area::-webkit-scrollbar { display: none; }
      ` }} />

      <header className="workspace-header">{isLoading && <span role="status" className="workspace-run-state"><span className="run-state-text">Working</span></span>}</header>

      {/* ── ChapterScrubber — right side, vertically centered ──────────── */}
      {scrubberChapters.length > 0 && !dockOpen && (
        <div
          className="absolute right-4 top-1/2 -translate-y-1/2 z-10"
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

      <div className="workspace-actions" role="toolbar" aria-label="Workspace tools">
        <UpdatePill />
        <button
          type="button"
          aria-label="Workspace files"
          title="Workspace files"
          aria-pressed={dockOpen}
          onClick={() => { if (dockOpen) setDockOpen(false); else { setTasksOpen(false); openDock(dockMountedRef.current ? dockTab : "files"); } }}
          className={cn("shell-icon-button", dockOpen && "is-selected")}
        >
          <PanelRight className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Tasks"
          title="Tasks"
          aria-pressed={tasksOpen}
          onClick={() => { const next = !tasksOpen; setTasksOpen(next); if (next) { setSidechatOpen(false); setDockOpen(false); } }}
          className={cn("shell-icon-button", tasksOpen && "is-selected")}
        >
          <ListTodo className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Show terminal"
          title="Terminal"
          aria-pressed={terminalOpen}
          onClick={() => { setTasksOpen(false); setTerminalOpen((open) => !open); }}
          className={cn("shell-icon-button", terminalOpen && "is-selected")}
        >
          <SquareTerminal className="size-4" />
        </button>
      </div>

      {terminalOpen && <TerminalDock projectPath={projectPath} projectName={projectName} onClose={() => setTerminalOpen(false)} />}

      {tasksOpen && (
        <TasksPanel
          projectPath={projectPath}
          projectName={projectName}
          accessMode={accessMode}
          tasks={runtimeState.tasks || []}
          agents={runtimeState.agents || []}
          steps={latestSteps}
          previewUrl={serverPreviewUrlRef.current}
          scheduled={scheduled}
          routing={runtimeState.routing || {}}
          onScheduleChange={changeSchedule}
          execute={workspaceExecute}
          onClose={() => setTasksOpen(false)}
        />
      )}
      {sidechatOpen && (
        <SideChat onClose={() => setSidechatOpen(false)} getProgress={getProgress} agentBusy={isLoading} />
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
              <AgentActivity phases={message.phases} done={message.done} startedAt={message.startedAt} endedAt={message.endedAt} status={message.status} stopReason={message.stopReason} error={message.error} rating={message.rating} subagents={message.subagents ?? (message.done ? undefined : [...subagentLogRef.current.values()].filter((job) => (job.startedAt ?? 0) >= (message.startedAt ?? 0)))} onRate={(value) => setMessages((previous) => previous.map((item) => item.id === message.id ? { ...item, rating: value ?? undefined } : item))} onResume={index === messages.length - 1 ? () => void handleSubmit(resumeBrief(message, messages.slice(0, index))) : undefined} unfinished={message.openSteps} onUndo={async (checkpointId) => { const result = await workspaceExecute({ type: "undo_edit", checkpointId }, { userInitiated: true }); if (!result.ok) throw new Error(result.error); }} onResolve={async (id, choice) => { const result = await workspaceExecute({ type: "resolve_worker", id, action: choice }, { userInitiated: true }); if (!result.ok) throw new Error(result.error || "That subagent's checkout could not be resolved."); }} />

            </div>
          ))}
        </div>

        {/* Spacer for composer — keeps AI response well away from input */}
        <div style={{ height: "180px" }} />
      </div>

      {/* ── Chat Composer ────────────────────────────────────────────────── */}
      <div className="chat-composer" data-approval={approvalQueue.length > 0}>
        <PromptInput
          onSubmit={(value, meta) => handleSubmit(value, meta?.files, meta?.effort, meta?.directive)}
          isThinking={isLoading}
          onStop={handleStop}
          {...(browserAvailable ? { onCaptureScreen: handleCaptureScreen } : {})}
          accessMode={accessMode} onAccessModeChange={changeAccess}
          approval={approvalQueue[0]} onApprovalDecision={(choice, answer) => void decideApproval(choice, answer)}
          projectName={projectName} projectPath={projectPath}
          folderBusy={importing} folderError={folderError}
          folderLocked={messages.length > 0}
          queued={queued} onSendQueuedNow={sendQueuedNow} onRemoveQueued={discardQueued} sendWhileThinking={sendPolicy}
          onFolderFiles={(files) => void importFolderFiles(files)}
          {...(typeof window !== "undefined" && (window as any).__electron?.pickFolder ? { onPickFolder: () => void pickProjectFolder() } : {})}
          onNewChatWithFolder={resetConversation}
          onClearFolder={clearFolder}
          onSlashAction={handleSlashAction}
          placeholder="Ask anything or describe a task..."
        />
      </div>

      {dockMounted && (
        <RightDock
          open={dockOpen}
          tab={dockTab}
          onTabChange={setDockTab}
          onClose={() => setDockOpen(false)}
          projectPath={projectPath}
          projectName={projectName}
          {...(typeof window !== "undefined" && (window as any).__electron?.pickFolder ? { onPickFolder: () => void pickProjectFolder() } : {})}
          showBrowser={browserEverUsed}
          showAgents={(runtimeState.agents || []).some((group: any) => Array.isArray(group.jobs) && group.jobs.length > 0)}
          browserActive={browserActive}
          agents={runtimeState.agents || []}
          jobs={[...subagentLogRef.current.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))}
          execute={workspaceExecute}
        />
      )}

    </main>
  );
}


