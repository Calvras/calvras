import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronRight, Eye, FileText, Folder, FolderOpen, FolderPlus, Globe2, PanelRightClose, RefreshCw, Search, Users, X } from "lucide-react";
import hljs from "highlight.js/lib/common";
import AgentAvatar from "@/components/ui/agent-avatar";
import { formatElapsed } from "@/components/ui/ai-agent-response";
import { BrowserPanel } from "@/components/BrowserPanel";
import { safePreviewUrl } from "@/lib/preview-url";
import type { SubagentJob } from "@/components/AgentActivity";
import type { ToolAction } from "@/lib/tool-catalog";
import { cn } from "@/lib/utils";

export type DockTab = "files" | "preview" | "browser" | "agents";

type Props = {
  open: boolean;
  tab: DockTab;
  onTabChange: (tab: DockTab) => void;
  onClose: () => void;
  projectPath: string | null;
  projectName: string | null;
  previewUrl: string;
  onPickFolder?: (() => void) | undefined;
  showBrowser: boolean;
  showAgents: boolean;
  browserActive: boolean;
  agents: any[];
  jobs: SubagentJob[];
  execute: (action: ToolAction) => Promise<any>;
};

const MIN_DOCK_WIDTH = 340;
const WIDTH_KEY = "calvras_browser_width";
const ROLE_LABELS: Record<string, string> = { builder: "Implementation", verifier: "Verification", researcher: "Research & review" };

function maxDockWidth() {
  return typeof window === "undefined" ? 760 : Math.max(MIN_DOCK_WIDTH, window.innerWidth - 380);
}

function clampDockWidth(value: number) {
  return Math.round(Math.min(Math.max(value, MIN_DOCK_WIDTH), maxDockWidth()));
}

function defaultDockWidth() {
  if (typeof window === "undefined") return 520;
  return clampDockWidth(Math.min(Math.max(window.innerWidth * 0.46, 380), 760));
}

type FileEntry = { path: string; type?: string };
type TreeNode = { name: string; path: string; dirs: TreeNode[]; files: FileEntry[] };

const segments = (value: string) => value.split(/[\\/]+/).filter(Boolean);

/** Group the flat list the runtime returns into folders, so a 2000-entry project reads as a
 * tree instead of one long scroll. Paths come back with the platform separator, so the split
 * accepts both and keys nodes on forward slashes. */
export function buildTree(entries: FileEntry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", dirs: [], files: [] };
  const index = new Map<string, TreeNode>([["", root]]);
  const ensure = (pathKey: string): TreeNode => {
    const found = index.get(pathKey);
    if (found) return found;
    const parts = segments(pathKey);
    const parent = ensure(parts.slice(0, -1).join("/"));
    const node: TreeNode = { name: parts.at(-1) || pathKey, path: pathKey, dirs: [], files: [] };
    parent.dirs.push(node);
    index.set(pathKey, node);
    return node;
  };
  for (const entry of entries) {
    const parts = segments(entry.path);
    if (!parts.length) continue;
    if (entry.type === "directory") ensure(parts.join("/"));
    else ensure(parts.slice(0, -1).join("/")).files.push({ ...entry, path: parts.join("/") });
  }
  const sort = (node: TreeNode) => {
    node.dirs.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => (segments(a.path).at(-1) || "").localeCompare(segments(b.path).at(-1) || ""));
    node.dirs.forEach(sort);
  };
  sort(root);
  return root;
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", css: "css",
  scss: "scss", html: "xml", svg: "xml", md: "markdown", py: "python", sh: "bash", yml: "yaml", yaml: "yaml",
  rs: "rust", go: "go", java: "java", rb: "ruby", php: "php", sql: "sql", toml: "ini", xml: "xml",
};

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Highlight at most the first slice of a large file; the rest is shown verbatim so nothing the
 * user is reading is silently dropped. */
export function highlightFile(path: string, content: string) {
  const language = LANGUAGES[(segments(path).at(-1) || "").split(".").pop()?.toLowerCase() || ""];
  const head = content.slice(0, 120_000);
  return (language ? hljs.highlight(head, { language, ignoreIllegals: true }).value : escapeHtml(head)) + escapeHtml(content.slice(120_000));
}

function matchesFilter(path: string, filter: string) {
  return filter.trim() === "" || path.toLowerCase().includes(filter.trim().toLowerCase());
}

/** The reference panel stamps its summary with a wall-clock time, not an elapsed count. */
function clockAt(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** The card already spells out the file name, so the chip carries what it does not: the kind. */
const KIND_BY_EXT: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", json: "JSON",
  css: "CSS", scss: "SCSS", html: "HTML", svg: "SVG", md: "Markdown", py: "Python",
  sh: "Shell", yml: "YAML", yaml: "YAML", rs: "Rust", go: "Go", java: "Java", rb: "Ruby",
  php: "PHP", sql: "SQL", toml: "TOML", xml: "XML", txt: "Text",
};

function fileKindLabel(path: string) {
  const name = segments(path).at(-1) || "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "Plain text";
  const ext = name.slice(dot + 1).toLowerCase();
  return KIND_BY_EXT[ext] ?? `.${ext}`;
}

function TreeBranch({ node, depth, expanded, onToggle, filter, openFile, busy }: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  filter: string;
  openFile: (path: string) => void;
  busy: boolean;
}) {
  const visibleDirs = node.dirs.filter((dir) => dir.files.length || dir.dirs.length);
  const visibleFiles = node.files.filter((file) => matchesFilter(file.path, filter));
  if (!visibleDirs.length && !visibleFiles.length && depth > 0) return null;
  return (
    <>
      {visibleDirs.map((dir) => {
        const isOpen = expanded.has(dir.path) || (filter.trim() !== "" && matchesFilter(dir.path, filter));
        return (
          <div key={dir.path}>
            <button
              type="button"
              className="dock-row"
              style={{ paddingLeft: `${6 + depth * 12}px` }}
              aria-expanded={isOpen}
              onClick={() => onToggle(dir.path)}
            >
              <span className="dock-tile" aria-hidden="true">{isOpen ? <FolderOpen /> : <Folder />}</span>
              <span className="truncate">{dir.name}</span>
              <span className="dock-row-count">{dir.files.length + dir.dirs.length}</span>
            </button>
            {isOpen && <TreeBranch node={dir} depth={depth + 1} expanded={expanded} onToggle={onToggle} filter={filter} openFile={openFile} busy={busy} />}
          </div>
        );
      })}
      {visibleFiles.map((file) => (
        <button
          key={file.path}
          type="button"
          className="dock-row"
          style={{ paddingLeft: `${6 + (depth + 1) * 12}px` }}
          disabled={busy}
          title={file.path}
          onClick={() => openFile(file.path)}
        >
          <span className="dock-tile" aria-hidden="true"><FileText /></span>
          <span className="truncate">{segments(file.path).at(-1)}</span>
        </button>
      ))}
    </>
  );
}

export function RightDock({ open, tab, onTabChange, onClose, projectPath, projectName, previewUrl, onPickFolder, showBrowser, showAgents, browserActive, agents, jobs, execute }: Props) {
  const asideRef = useRef<HTMLElement | null>(null);
  const stopResizeRef = useRef<(() => void) | null>(null);
  const [width, setWidth] = useState(0);
  const [resizing, setResizing] = useState(false);

  const applyWidth = (value: number, persist = true) => {
    const next = clampDockWidth(value);
    setWidth(next);
    const page = asideRef.current?.closest(".chat-page") as HTMLElement | null;
    page?.style.setProperty("--browser-dock-width", `${next}px`);
    if (persist) { try { localStorage.setItem(WIDTH_KEY, String(next)); } catch { /* private mode */ } }
  };

  useEffect(() => {
    let stored = 0;
    try { stored = Number(localStorage.getItem(WIDTH_KEY)); } catch { /* private mode */ }
    applyWidth(Number.isFinite(stored) && stored > 0 ? stored : defaultDockWidth(), false);
    return () => stopResizeRef.current?.();
  }, []);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (browserActive || event.button !== 0) return;
    const panel = asideRef.current;
    if (!panel) return;
    event.preventDefault();
    stopResizeRef.current?.();
    const startX = event.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    const page = panel.closest(".chat-page") as HTMLElement | null;
    setResizing(true);
    page?.classList.add("is-resizing-browser");
    document.body.style.cursor = "col-resize";
    const move = (moveEvent: PointerEvent) => applyWidth(startWidth + startX - moveEvent.clientX, false);
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      stopResizeRef.current = null;
      setResizing(false);
      page?.classList.remove("is-resizing-browser");
      document.body.style.cursor = "";
      try { localStorage.setItem(WIDTH_KEY, String(clampDockWidth(panel.getBoundingClientRect().width))); } catch { /* private mode */ }
    };
    stopResizeRef.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const resizeWithKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (browserActive || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const current = asideRef.current?.getBoundingClientRect().width ?? (width || defaultDockWidth());
    applyWidth(current + (event.key === "ArrowLeft" ? (event.shiftKey ? 64 : 24) : -(event.shiftKey ? 64 : 24)));
  };

  const resetWidth = () => {
    if (browserActive) return;
    const page = asideRef.current?.closest(".chat-page") as HTMLElement | null;
    page?.style.removeProperty("--browser-dock-width");
    try { localStorage.removeItem(WIDTH_KEY); } catch { /* private mode */ }
    requestAnimationFrame(() => setWidth(Math.round(asideRef.current?.getBoundingClientRect().width || 0)));
  };

  useEffect(() => {
    const close = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && open) onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open, onClose]);

  const tabs = [
    { id: "files" as DockTab, label: "Workspace files", short: "Files", icon: FileText, visible: Boolean(projectPath) },
    { id: "preview" as DockTab, label: "Preview", short: "Preview", icon: Eye, visible: Boolean(projectPath) },
    { id: "browser" as DockTab, label: "Browser", short: "Browser", icon: Globe2, visible: showBrowser },
    { id: "agents" as DockTab, label: "Subagents", short: "Subagents", icon: Users, visible: showAgents },
  ].filter((entry) => entry.visible);

  const activeTab = tabs.some((entry) => entry.id === tab) ? tab : tabs[0]?.id || "files";

  return (
    <aside
      ref={asideRef}
      className="browser-dock workspace-dock"
      data-open={open}
      data-active={browserActive && activeTab === "browser"}
      data-resizing={resizing}
      data-tab={activeTab}
      aria-label="Workspace dock"
      aria-hidden={!open}
    >
      <div
        className="browser-dock-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize browser panel"
        aria-valuemin={MIN_DOCK_WIDTH}
        aria-valuemax={maxDockWidth()}
        aria-valuenow={width}
        aria-disabled={browserActive}
        tabIndex={browserActive ? -1 : 0}
        title="Drag to resize · double-click to reset"
        onPointerDown={beginResize}
        onDoubleClick={resetWidth}
        onKeyDown={resizeWithKeys}
      >
        <span aria-hidden="true" />
      </div>
      <header className="dock-head">
        <div className="dock-tabs" role="tablist" aria-label="Dock sections">
          {tabs.length ? tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={activeTab === entry.id}
              title={entry.label}
              onClick={() => onTabChange(entry.id)}
              className={cn("dock-tab", activeTab === entry.id && "is-selected")}
            >
              <entry.icon className="size-3.5" aria-hidden="true" />
              {entry.short}
            </button>
          )) : <span className="dock-title">Workspace</span>}
        </div>
        <div className="dock-head-actions">
          {browserActive && activeTab === "browser" ? <span className="browser-dock-live"><span className="is-working" aria-hidden="true" />Agent in control</span> : null}
          <button type="button" className="browser-dock-close" onClick={onClose} title="Close panel (Esc)" aria-label="Close browser panel">
            <PanelRightClose className="size-4" aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="dock-body">
        <Panel label="Workspace files" active={activeTab === "files"}>
          <FilesPane projectPath={projectPath} projectName={projectName} onPickFolder={onPickFolder} execute={execute} open={open && activeTab === "files"} />
        </Panel>
        <Panel label="Preview" active={activeTab === "preview"}>
          <PreviewPane previewUrl={previewUrl} execute={execute} />
        </Panel>
        <Panel label="Browser" active={activeTab === "browser"} className="dock-panel--browser">
          <BrowserPanel active={browserActive} />
        </Panel>
        <Panel label="Subagents" active={activeTab === "agents"}>
          <AgentsPane agents={agents} jobs={jobs} tick={open && activeTab === "agents"} execute={execute} />
        </Panel>
      </div>
    </aside>
  );
}

/** Every section stays mounted, because the <webview> holding a page Calvras is mid-task on must
 * never be torn down by a tab click; only the active one is displayed. */
function Panel({ label, active, className, children }: { label: string; active: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={cn("dock-panel", className)} role="tabpanel" aria-label={label} hidden={!active} style={active ? undefined : { display: "none" }}>
      {children}
    </div>
  );
}

function FilesPane({ projectPath, projectName, onPickFolder, execute, open }: { projectPath: string | null; projectName: string | null; onPickFolder?: (() => void) | undefined; execute: Props["execute"]; open: boolean }) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [file, setFile] = useState<{ path: string; content: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listedAt, setListedAt] = useState(0);
  const loadedFor = useRef("");

  const load = async () => {
    if (!projectPath) return;
    setBusy(true); setError("");
    try {
      const result = await execute({ type: "list_files", path: "." });
      if (result?.ok === false) throw new Error(String(result.error || "The folder could not be listed."));
      const list: FileEntry[] = (result?.entries || []).filter((entry: FileEntry) => entry?.path);
      setEntries(list);
      setTruncated(Boolean(result?.truncated));
      setListedAt(Date.now());
      loadedFor.current = projectPath;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!open || !projectPath) return;
    if (loadedFor.current !== projectPath) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectPath]);

  const openFile = async (path: string) => {
    setBusy(true); setError("");
    try {
      const result = await execute({ type: "read_file", path });
      if (result?.ok === false) throw new Error(String(result.error || "This file could not be read."));
      const content = String(result?.content ?? "");
      const lines = result?.totalLines ? `lines ${result.startLine || 1}–${result.endLine || result.totalLines} of ${result.totalLines}` : "";
      setFile({ path, content, note: [`${content.length.toLocaleString()} characters`, lines, result?.truncated ? "truncated by the reader" : ""].filter(Boolean).join(" · ") });
      setListedAt(Date.now());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  const tree = useMemo(() => buildTree(entries), [entries]);
  // The runtime returns files and folders it walked into, so the honest count is the tree itself.
  const counts = useMemo(() => {
    let dirs = 0;
    let files = 0;
    const walk = (node: TreeNode) => { dirs += node.dirs.length; files += node.files.length; node.dirs.forEach(walk); };
    walk(tree);
    return { dirs, files };
  }, [tree]);
  const highlighted = useMemo(() => (file ? highlightFile(file.path, file.content) : ""), [file]);

  if (!projectPath) {
    return (
      <div className="dock-empty-block">
        <Folder className="size-7" aria-hidden="true" />
        <p>Nothing is open yet. Pick a folder and its files appear here.</p>
        {onPickFolder ? (
          <button type="button" className="dock-button" onClick={onPickFolder}>
            <FolderPlus className="size-3.5" aria-hidden="true" />
            Add a project folder
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="dock-fill">
      <div className="dock-summary">
        <span className="dock-tile" aria-hidden="true">{file ? <FileText /> : <FolderOpen />}</span>
        <span className="dock-summary-body">
          <span className="dock-summary-time">{listedAt ? `Updated at ${clockAt(listedAt)}` : busy ? "Reading the folder" : "Not read yet"}</span>
          <span className="dock-summary-text">{file
            ? `${segments(file.path).at(-1)} · ${file.note}`
            : `${projectName || "This workspace"} · ${counts.files.toLocaleString()} ${counts.files === 1 ? "file" : "files"} in ${counts.dirs.toLocaleString()} ${counts.dirs === 1 ? "folder" : "folders"}`}</span>
        </span>
      </div>
      <div className="dock-toolbar">
        {file ? (
          <button type="button" className="dock-button" onClick={() => setFile(null)}>
            <ChevronRight className="size-3.5 rotate-180" aria-hidden="true" />
            All files
          </button>
        ) : (
          <>
            <div className="dock-search">
              <Search className="size-3.5" aria-hidden="true" />
              <input value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter files" />
            </div>
          </>
        )}
      </div>
      <p className="dock-caption" title={projectPath || ""}>{file ? file.path : `${projectName || "Project"}${projectPath ? ` · ${projectPath}` : ""}`}</p>
      {error ? <p className="dock-error" role="alert">{error}</p> : null}
      {file ? (
        <>
          <div className="dock-section-row"><h3 className="dock-section">Source</h3><span className="dock-chip">{fileKindLabel(file.path)}</span></div>
          <pre className="dock-code" aria-label="File contents"><code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
        </>
      ) : (
        <>
          <div className="dock-section-row">
            <h3 className="dock-section">Files</h3>
            <span className="dock-chip">{filter.trim() ? `${counts.files} matching` : truncated ? "listing capped" : "complete listing"}</span>
          </div>
          <div className="dock-tree">
            {!busy && !entries.length && !error ? <p className="dock-empty">This folder has no files Calvras can list yet.</p> : null}
            <TreeBranch node={tree} depth={0} expanded={expanded} filter={filter} busy={busy} openFile={openFile} onToggle={(path) => setExpanded((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; })} />
            {truncated ? <p className="dock-sub">The listing stopped at its cap, so deeper folders may be missing.</p> : null}
          </div>
        </>
      )}
    </div>
  );
}

function PreviewPane({ previewUrl, execute }: { previewUrl: string; execute: Props["execute"] }) {
  const url = safePreviewUrl(previewUrl);
  const [nonce, setNonce] = useState(0);
  const [checking, setChecking] = useState(false);
  const [detected, setDetected] = useState("");
  const [note, setNote] = useState("");
  const shown = safePreviewUrl(detected) || url;

  const recheck = async () => {
    setChecking(true); setNote("");
    try {
      const result = await execute({ type: "check_server" });
      if (result?.ready && safePreviewUrl(result.url)) setDetected(String(result.url));
      else setNote(result?.error ? String(result.error) : "Nothing is listening on a local port yet, so there is no preview to show. Ask Calvras to start the server.");
    } catch (reason) {
      setNote(reason instanceof Error ? reason.message : String(reason));
    } finally { setChecking(false); }
  };

  if (!shown) {
    return (
      <div className="dock-empty-block">
        <Eye className="size-7" aria-hidden="true" />
        <p>No local server preview is open. Start the dev server and this tab shows the running page.</p>
        <button type="button" className="dock-button" onClick={() => void recheck()} disabled={checking}>
          <RefreshCw className={`size-3.5 ${checking ? "animate-spin" : ""}`} aria-hidden="true" />
          Look for a running server
        </button>
        {note ? <p className="dock-error" role="alert">{note}</p> : null}
      </div>
    );
  }

  return (
    <div className="dock-fill">
      <div className="dock-summary">
        <span className="dock-tile" aria-hidden="true"><Eye /></span>
        <span className="dock-summary-body">
          <span className="dock-summary-time">Local server</span>
          <span className="dock-summary-text" title={shown}>{shown}</span>
        </span>
      </div>
      <div className="dock-toolbar">
        <button type="button" className="dock-button" onClick={() => { setNonce((value) => value + 1); }} title="Reload the preview">
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Reload
        </button>
        <button type="button" className="dock-button" onClick={() => void recheck()} disabled={checking}>
          <RefreshCw className={`size-3.5 ${checking ? "animate-spin" : ""}`} aria-hidden="true" />
          Re-check
        </button>
      </div>
      {note ? <p className="dock-error" role="alert">{note}</p> : null}
      <iframe
        key={`${shown}-${nonce}`}
        title="Local project preview"
        src={shown}
        sandbox="allow-scripts allow-forms allow-same-origin"
        referrerPolicy="no-referrer"
        className="dock-preview"
      />
    </div>
  );
}

function AgentsPane({ agents, jobs, tick, execute }: { agents: any[]; jobs: SubagentJob[]; tick: boolean; execute: Props["execute"] }) {
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState("");
  useEffect(() => {
    if (!tick) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [tick]);

  const label = (role: string) => ROLE_LABELS[role] || role;
  const statusWord = (status: string) => (status === "limit" ? "out of steps" : status);
  const elapsed = (job: SubagentJob) => {
    if (!job.startedAt) return "queued";
    const seconds = Math.max(1, Math.round(((job.endedAt || now) - job.startedAt) / 1_000));
    return formatElapsed(seconds);
  };
  const running = jobs.filter((job) => ["queued", "running"].includes(job.status));
  const lastStamp = jobs.reduce((latest, job) => Math.max(latest, job.endedAt || job.startedAt || 0), 0);
  const runningRoles = agents.filter((group: any) => group?.active).length;

  const stop = async (id: string) => {
    setBusyId(id);
    try { await execute({ type: "cancel_agent", id }); } finally { setBusyId(""); }
  };

  return (
    <div className="dock-fill">
      <div className="dock-summary">
        <span className="dock-tile" aria-hidden="true"><Users /></span>
        <span className="dock-summary-body">
          <span className="dock-summary-time">{lastStamp ? `Updated at ${clockAt(lastStamp)}` : "Nothing handed off yet"}</span>
          <span className="dock-summary-text">{jobs.length ? `${jobs.length} ${jobs.length === 1 ? "task" : "tasks"} delegated this session` : "Calvras splits work into parallel workers when a part of the task can run alongside the rest."}</span>
        </span>
      </div>
      <div className="dock-section-row">
        <h3 className="dock-section">Workers</h3>
        <span className="dock-chip">{runningRoles} {runningRoles === 1 ? "active" : "running"}</span>
      </div>
      <ul className="dock-list">
        {(agents.length ? agents : Object.keys(ROLE_LABELS).map((role) => ({ role }))).map((group: any) => {
          const jobsForRole = Array.isArray(group.jobs) ? group.jobs : [];
          const last = jobsForRole.at(-1);
          const state = group.active ? "running" : group.queued ? `queued (${group.queued})` : last ? statusWord(String(last.status)) : "idle";
          return (
            <li key={String(group.role)} className="dock-item">
              <AgentAvatar seed={String(group.role)} size={24} animated={Boolean(group.active)} aria-hidden="true" />
              <span className="dock-item-main">
                <span className="dock-item-title">{label(String(group.role))}</span>
                <span className="dock-item-sub">{group.active ? String(group.active.task || "").slice(0, 90) : `${jobsForRole.length} task${jobsForRole.length === 1 ? "" : "s"} this session`}</span>
              </span>
              <span className="dock-badge">{state}</span>
            </li>
          );
        })}
      </ul>
      <div className="dock-section-row">
        <h3 className="dock-section">Tasks</h3>
        {running.length ? <span className="dock-chip">{running.length} still open</span> : null}
      </div>
      {!jobs.length ? <p className="dock-empty">No subagent has run in this session yet. Calvras hands work here when a part of the task can be done in parallel.</p> : null}
      <ul className="dock-list">
        {jobs.map((job) => (
          <li key={job.id} className="dock-item">
            <AgentAvatar seed={job.role} size={24} animated={job.status === "running"} aria-hidden="true" />
            <span className="dock-item-main">
              <span className="dock-item-title" title={job.task}>{job.task}</span>
              <span className="dock-item-sub">
                {[label(job.role), elapsed(job), job.engine ? [job.engine.profile, job.engine.model].filter(Boolean).join(" · ") : "", job.worktree?.branch || ""].filter(Boolean).join(" · ")}
              </span>
              {job.updates?.length ? <span className="dock-item-log">{job.updates.at(-1)}</span> : null}
              {job.result && job.result !== job.updates?.at(-1) ? <span className="dock-item-log">{job.result}</span> : null}
            </span>
            <span className="dock-badge">{statusWord(job.status)}</span>
            {["queued", "running"].includes(job.status) ? (
              <button type="button" className="dock-button dock-button--tight" disabled={busyId === job.id} onClick={() => void stop(job.id)} aria-label={`Stop ${job.task.slice(0, 40)}`}>
                <X className="size-3" aria-hidden="true" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default RightDock;
