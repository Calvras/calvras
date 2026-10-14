import { PluginsPanel } from "./PluginsPanel";
import { useEffect, useRef, useState } from "react";
import { PenSquare, FolderOpen, ChevronDown, ChevronRight, Bell, Search, PanelLeft, Sparkles, User, ArrowUpRight, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { QuotaBanner } from "@/components/ui/quota-banner";

interface Project {
  id?: string;
  name: string;
  tasks?: string[];
  path?: string;
}

interface RecentItem {
  id?: string;
  label: string;
  hasAlert?: boolean;
  projectPath?: string;
  projectName?: string;
}

interface CalvrasSidebarProps {
  projects?: Project[];
  recents?: RecentItem[];
  onNewChat?: () => void;
  onSelectRecent?: (item: RecentItem) => void;
  onSelectProject?: (project: Project) => void;
  onRenameRecent?: (item: RecentItem, newLabel: string) => void;
  onDeleteRecent?: (item: RecentItem) => void;
  onRenameProject?: (project: Project, newName: string) => void;
  onDeleteProject?: (project: Project) => void;
}

const SIDEBAR_W = 250;

export function CalvrasSidebar({
  projects = [],
  recents = [],
  onNewChat,
  onSelectRecent,
  onSelectProject,
  onRenameRecent,
  onDeleteRecent,
  onRenameProject,
  onDeleteProject,
}: CalvrasSidebarProps) {
  const [open, setOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  // Track which project folders have their sub-recents expanded
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const sidebarRef = useRef<HTMLElement>(null);

  // 3-dot menu state
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [usagePanelOpen, setUsagePanelOpen] = useState(false);

  // Close sidebar on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (sidebarRef.current && !sidebarRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const t = setTimeout(() => document.addEventListener("mousedown", handler), 10);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", handler);
    };
  }, [open]);

  // Close open menu on outside click
  useEffect(() => {
    if (!openMenuId) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // Let clicks inside menus / rename inputs propagate normally
      const menuEl = document.getElementById(`chat-menu-${openMenuId}`);
      if (menuEl && menuEl.contains(target)) return;
      setOpenMenuId(null);
    };
    const t = setTimeout(() => document.addEventListener("mousedown", handler), 10);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", handler);
    };
  }, [openMenuId]);

  const toggleProjectExpanded = (key: string) => {
    setExpandedProjects((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Collect all task labels that belong to a project folder
  const projectTaskLabels = new Set<string>();
  projects.forEach((p) => {
    p.tasks?.forEach((t) => projectTaskLabels.add(t));
  });

  // Filter recents: exclude any chat that's already nested under a project folder
  const orphanRecents = recents.filter((r) => !projectTaskLabels.has(r.label));

  const startRename = (item: RecentItem) => {
    setRenamingId(item.id || item.label);
    setRenameValue(item.label);
    setOpenMenuId(null);
  };

  const commitRename = (item: RecentItem) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== item.label) {
      onRenameRecent?.(item, trimmed);
    }
    setRenamingId(null);
    setRenameValue("");
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue("");
  };

  const handleDelete = (item: RecentItem) => {
    onDeleteRecent?.(item);
    setOpenMenuId(null);
  };

  const startRenameProject = (project: Project) => {
    setRenamingId(project.id || project.name);
    setRenameValue(project.name);
    setOpenMenuId(null);
  };

  const commitRenameProject = (project: Project) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== project.name) {
      onRenameProject?.(project, trimmed);
    }
    setRenamingId(null);
    setRenameValue("");
  };

  const renderProjectMenu = (project: Project) => {
    const projectId = project.id || project.name;
    const menuId = `proj-${projectId}`;
    const isMenuOpen = openMenuId === menuId;

    return (
      <>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setOpenMenuId((prev) => (prev === menuId ? null : menuId));
          }}
          className={cn(
            "ml-auto shrink-0 flex h-5 w-5 items-center justify-center rounded transition-opacity",
            "opacity-0 group-hover:opacity-100 hover:bg-[oklch(0.35_0_0)] text-[oklch(0.7_0_0)] hover:text-[oklch(0.985_0_0)]",
            isMenuOpen && "opacity-100"
          )}
          aria-label="More options"
          tabIndex={-1}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>

        <AnimatePresence>
          {isMenuOpen && (
            <motion.div
              id={`chat-menu-${menuId}`}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ duration: 0.12 }}
              className="absolute right-0 top-0 z-10 flex h-full items-center gap-px rounded-md bg-[oklch(0.285_0_0)] px-1 shadow-lg border border-[oklch(1_0_0/8%)]"
              style={{ minWidth: 140 }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => startRenameProject(project)}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-[oklch(0.85_0_0)] hover:bg-[oklch(0.35_0_0)] hover:text-white transition-colors"
              >
                <Pencil className="h-3 w-3 shrink-0" />
                Rename
              </button>
              <button
                onClick={() => {
                  onDeleteProject?.(project);
                  setOpenMenuId(null);
                }}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-[oklch(0.7_0.15_20)] hover:bg-[oklch(0.35_0_0)] hover:text-red-400 transition-colors"
              >
                <Trash2 className="h-3 w-3 shrink-0" />
                Delete
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  };

  /** Renders the ⋯ button + slide-in action panel for a recent item */
  const renderItemMenu = (item: RecentItem) => {
    const itemId = item.id || item.label;
    const isMenuOpen = openMenuId === itemId;

    return (
      <>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setOpenMenuId((prev) => (prev === itemId ? null : itemId));
          }}
          className={cn(
            "ml-auto shrink-0 flex h-5 w-5 items-center justify-center rounded transition-opacity",
            "opacity-0 group-hover:opacity-100 hover:bg-[oklch(0.35_0_0)] text-[oklch(0.7_0_0)] hover:text-[oklch(0.985_0_0)]",
            isMenuOpen && "opacity-100"
          )}
          aria-label="More options"
          tabIndex={-1}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>

        <AnimatePresence>
          {isMenuOpen && (
            <motion.div
              id={`chat-menu-${itemId}`}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ duration: 0.12 }}
              className="absolute right-0 top-0 z-10 flex h-full items-center gap-px rounded-md bg-[oklch(0.285_0_0)] px-1 shadow-lg border border-[oklch(1_0_0/8%)]"
              style={{ minWidth: 140 }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => startRename(item)}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-[oklch(0.85_0_0)] hover:bg-[oklch(0.35_0_0)] hover:text-white transition-colors"
              >
                <Pencil className="h-3 w-3 shrink-0" />
                Rename
              </button>
              <button
                onClick={() => handleDelete(item)}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-[oklch(0.7_0.15_20)] hover:bg-[oklch(0.35_0_0)] hover:text-red-400 transition-colors"
              >
                <Trash2 className="h-3 w-3 shrink-0" />
                Delete
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  };

  return (
    <>
      {/* ── Toggle button — always visible top-left ─────────────── */}
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "fixed top-3 left-3 z-50 flex h-8 w-8 items-center justify-center rounded-md",
          "text-[oklch(0.985_0_0)] hover:bg-[oklch(0.285_0_0)] transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        )}
        aria-label="Toggle sidebar"
      >
        <PanelLeft className="h-4 w-4" />
      </button>

      {/* ── Backdrop ───────────────────────────────────────────── */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity"
          aria-hidden="true"
        />
      )}

      {/* ── Slide-over drawer ──────────────────────────────────── */}
      <aside
        ref={sidebarRef}
        style={{ width: `${SIDEBAR_W}px` }}
        className={cn(
          "fixed top-0 left-0 bottom-0 z-50 flex flex-col",
          "bg-[oklch(0.205_0_0)] text-[oklch(0.985_0_0)]",
          "border-r border-[oklch(1_0_0/10%)] shadow-2xl",
          "transition-transform duration-200 ease-in-out",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-3 pt-3 pb-2 border-b border-[oklch(1_0_0/6%)]">
          {/* Calvras logo / team */}
          <button className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm font-semibold hover:bg-[oklch(0.285_0_0)] transition-colors">
            <img
              src="/calvras-logo.png"
              alt="Calvras"
              className="h-5 w-5 rounded object-contain"
            />
            <span>Calvras</span>
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>

          {/* Top-right icons: search + notifications */}
          <div className="flex items-center gap-0.5">
            <button
              aria-label="Search"
              className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[oklch(0.285_0_0)] text-[oklch(0.7_0_0)] hover:text-[oklch(0.985_0_0)] transition-colors"
            >
              <Search className="h-3.5 w-3.5" />
            </button>
            <button
              aria-label="Notifications"
              className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[oklch(0.285_0_0)] text-[oklch(0.7_0_0)] hover:text-[oklch(0.985_0_0)] transition-colors"
            >
              <Bell className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* ── New chat ───────────────────────────────────────────── */}
        <div className="px-3 pt-2 pb-1">
          <button
            onClick={() => {
              onNewChat?.();
              setOpen(false);
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium bg-[oklch(0.25_0_0)] hover:bg-[oklch(0.3_0_0)] transition-colors shadow-xs"
          >
            <PenSquare className="h-4 w-4 opacity-80" />
            <span>New chat</span>
          </button>
        </div>

        <div className="px-3 py-2"><button onClick={() => { setPluginsOpen(true); setOpen(false); }} className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground">Plugins</button><Link to="/signin" onClick={() => setOpen(false)} className="block rounded-lg px-2.5 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">Sign up</Link></div>
        {/* ── Scrollable body ────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* Projects */}
          <div className="mb-2 mt-2">
            <button
              onClick={() => setProjectsOpen((o) => !o)}
              className="flex w-full items-center justify-between px-2 py-1 text-xs font-semibold text-[oklch(0.647_0_0)] hover:text-[oklch(0.985_0_0)] transition-colors"
            >
              <span>Projects</span>
              <ChevronDown className={cn("h-3 w-3 transition-transform", !projectsOpen && "-rotate-90")} />
            </button>

            {projectsOpen && (
              projects.length > 0 ? (
                projects.map((project) => {
                  const key = project.path || project.name;
                  const hasTasks = project.tasks && project.tasks.length > 0;
                  const isExpanded = expandedProjects[key] ?? false;

                  return (
                    <div key={project.id || key} className="mt-0.5">
                      <div className="relative group flex items-center">
                        {/* Collapse toggle for sub-recents */}
                        {hasTasks ? (
                          <button
                            onClick={() => toggleProjectExpanded(key)}
                            className="flex h-6 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
                            aria-label={isExpanded ? "Collapse" : "Expand"}
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-3 w-3" />
                            ) : (
                              <ChevronRight className="h-3 w-3" />
                            )}
                          </button>
                        ) : (
                          <span className="w-5 shrink-0" />
                        )}

                        {renamingId === (project.id || project.name) ? (
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRenameProject(project);
                              if (e.key === "Escape") { setRenamingId(null); setRenameValue(""); }
                            }}
                            onBlur={() => commitRenameProject(project)}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-1 min-w-0 bg-[oklch(0.32_0_0)] text-[oklch(0.985_0_0)] rounded px-1.5 py-0.5 text-sm outline-none border border-[oklch(0.5_0_0/50%)] focus:border-[oklch(0.6_0_0)]"
                          />
                        ) : (
                          <button
                            onClick={() => {
                              onSelectProject?.(project);
                              setOpen(false);
                            }}
                            className="flex flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-[oklch(0.285_0_0)] transition-colors text-left min-w-0"
                          >
                            <FolderOpen className="h-4 w-4 shrink-0 text-zinc-500" />
                            <span className="truncate font-medium">{project.name}</span>
                            {hasTasks && (
                              <span className="ml-auto text-[10px] text-muted-foreground/60 font-mono tabular-nums">
                                {project.tasks!.length}
                              </span>
                            )}
                          </button>
                        )}

                        {renamingId !== (project.id || project.name) && renderProjectMenu(project)}
                      </div>

                      {/* Collapsible sub-recent tasks under this folder */}
                      {hasTasks && isExpanded && (
                        <div className="ml-5 border-l border-[oklch(1_0_0/8%)] pl-0.5">
                          {project.tasks!.map((task) => {
                            // Find the matching recent item for this task so we have an id
                            const taskRecent = recents.find((r) => r.label === task) ?? { label: task, id: task };
                            const taskId = taskRecent.id || task;
                            const isRenaming = renamingId === taskId;

                            return (
                              <div
                                key={task}
                                className="group relative flex w-full items-center rounded-md pl-2.5 pr-2 py-1 text-[13px] text-muted-foreground hover:text-foreground hover:bg-[oklch(0.27_0_0)] transition-colors"
                              >
                                {isRenaming ? (
                                  <input
                                    autoFocus
                                    value={renameValue}
                                    onChange={(e) => setRenameValue(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") commitRename(taskRecent);
                                      if (e.key === "Escape") cancelRename();
                                    }}
                                    onBlur={() => commitRename(taskRecent)}
                                    onClick={(e) => e.stopPropagation()}
                                    className="flex-1 min-w-0 bg-[oklch(0.32_0_0)] text-[oklch(0.985_0_0)] rounded px-1.5 py-0.5 text-[13px] outline-none border border-[oklch(0.5_0_0/50%)] focus:border-[oklch(0.6_0_0)]"
                                  />
                                ) : (
                                  <>
                                    <button
                                      onClick={() => {
                                        onSelectRecent?.({ label: task, projectName: project.name, projectPath: project.path });
                                        setOpen(false);
                                      }}
                                      className="flex-1 min-w-0 text-left truncate"
                                    >
                                      {task}
                                    </button>
                                    {renderItemMenu(taskRecent)}
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="px-2 py-2 text-xs text-[oklch(0.5_0_0)] italic">
                  No projects yet
                </div>
              )
            )}
          </div>

          {/* Recents — only shows chats NOT already nested under a project */}
          <div className="mt-3">
            <div className="px-2 py-1 text-xs font-semibold text-[oklch(0.647_0_0)]">Recents</div>
            <div className="mt-0.5 flex flex-col gap-px">
              {orphanRecents.length > 0 ? (
                orphanRecents.map((item) => {
                  const itemId = item.id || item.label;
                  const isRenaming = renamingId === itemId;

                  return (
                    <div
                      key={itemId}
                      className="group relative flex w-full items-center rounded-md px-2 py-1.5 text-sm hover:bg-[oklch(0.285_0_0)] transition-colors"
                    >
                      {isRenaming ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename(item);
                            if (e.key === "Escape") cancelRename();
                          }}
                          onBlur={() => commitRename(item)}
                          onClick={(e) => e.stopPropagation()}
                          className="flex-1 min-w-0 bg-[oklch(0.32_0_0)] text-[oklch(0.985_0_0)] rounded px-1.5 py-0.5 text-sm outline-none border border-[oklch(0.5_0_0/50%)] focus:border-[oklch(0.6_0_0)]"
                        />
                      ) : (
                        <>
                          <button
                            onClick={() => {
                              onSelectRecent?.(item);
                              setOpen(false);
                            }}
                            className="flex-1 min-w-0 text-left truncate"
                          >
                            {item.label}
                          </button>
                          {item.hasAlert && <AlertIcon />}
                          {renderItemMenu(item)}
                        </>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="px-2 py-2 text-xs text-[oklch(0.5_0_0)] italic">
                  No recent chats
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── User Profile & Upgrade Footer ───────────────────────── */}
        <div className="p-3 border-t border-[oklch(1_0_0/8%)] bg-[oklch(0.18_0_0)] flex flex-col gap-2.5">
          {/* View Usage Button */}
          <button
            type="button"
            onClick={() => setUsagePanelOpen(true)}
            className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-semibold bg-[#faf8f5] hover:bg-[#f3ede4] text-[#1a1918] transition-all shadow-sm group active:scale-[0.98]"
          >
            <div className="flex items-center gap-1.5">
              <svg className="h-3.5 w-3.5 text-[#6b5e4e]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4"/>
                <path d="M5 8.5 Q6.5 5.5 8 8 Q9.5 10.5 11 7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                <circle cx="8" cy="8" r="1" fill="currentColor"/>
              </svg>
              <span>View Usage</span>
            </div>
            <ArrowUpRight className="h-3.5 w-3.5 opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
          </button>

          {/* User Profile Info */}
          <div className="flex items-center justify-between rounded-md px-1 py-1 text-left">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-stone-700 to-stone-500 text-white font-medium text-xs shadow-inner">
                <User className="h-4 w-4" />
                <span className="absolute bottom-0 right-0 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-[oklch(0.18_0_0)]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold text-foreground">
                  User
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center rounded bg-[oklch(0.285_0_0)] px-1.5 py-0.2 text-[10px] font-medium text-[oklch(0.85_0_0)]">
                    Free plan
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>
      <PluginsPanel open={pluginsOpen} onOpenChange={setPluginsOpen} />

      {/* ── Slide-out Usage Popover (by the side, outside the sidebar) ─ */}
      <AnimatePresence>
        {usagePanelOpen && (
          <>
            {/* Click-outside backdrop */}
            <div
              className="fixed inset-0 z-40 bg-transparent"
              onClick={() => setUsagePanelOpen(false)}
              aria-hidden="true"
            />
            <motion.div
              initial={{ opacity: 0, x: -16, scale: 0.98 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: -16, scale: 0.98 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="fixed bottom-3 left-[260px] z-50 w-[450px] max-w-[calc(100vw-280px)]"
            >
              <QuotaBanner
                limit={1000}
                used={742}
                resetsAt="October 1"
                unit="runs"
                label="Monthly agent usage"
                onUpgrade={() => {
                  setUsagePanelOpen(false);
                  window.location.href = "/pricing";
                }}
                onClose={() => setUsagePanelOpen(false)}
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

function AlertIcon() {
  return (
    <span className="ml-2 shrink-0 text-[oklch(0.63_0.19_25)]">
      <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <text x="8" y="11.5" textAnchor="middle" fontSize="9" fill="currentColor" fontWeight="bold">!</text>
      </svg>
    </span>
  );
}
