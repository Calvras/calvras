import { useEffect, useRef, useState } from "react";
import { ChevronDown, Folder, MoreHorizontal, Search, Settings, SquarePen, X } from "lucide-react";
import { SettingsPanel } from "./SettingsPanel";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { cn } from "@/lib/utils";
interface Project { id?: string; name: string; tasks?: string[]; path?: string }
interface RecentItem { id?: string; label: string; hasAlert?: boolean; projectPath?: string; projectName?: string }
interface Props {
  projects?: Project[]; recents?: RecentItem[]; onNewChat?: () => void;
  onSelectRecent?: (item: RecentItem) => void; onSelectProject?: (project: Project) => void;
  onRenameRecent?: (item: RecentItem, label: string) => void; onDeleteRecent?: (item: RecentItem) => void;
  onRenameProject?: (project: Project, name: string) => void; onDeleteProject?: (project: Project) => void;
}
export function CalvrasSidebar({ projects = [], recents = [], onNewChat, onSelectRecent, onSelectProject, onRenameProject, onRenameRecent, onDeleteProject, onDeleteRecent }: Props) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<{ save: (name: string) => void } | null>(null);
  const [newName, setNewName] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const drawer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ",") { event.preventDefault(); setSettings(true); }
      if (event.key === "Escape") setOpen(false);
    };
    const openSettings = () => setSettings(true);
    const toggleDrawer = () => setOpen((current) => !current);
    document.addEventListener("keydown", key);
    window.addEventListener("calvras:open-settings", openSettings);
    window.addEventListener("calvras:toggle-drawer", toggleDrawer);
    return () => {
      document.removeEventListener("keydown", key);
      window.removeEventListener("calvras:open-settings", openSettings);
      window.removeEventListener("calvras:toggle-drawer", toggleDrawer);
    };
  }, []);
  // The drawer is docked rather than floating: the page reserves its width while it is open, so
  // opening it moves the conversation across instead of covering it. On a desktop window there is
  // room for that split from the start, so it comes up already docked.
  useEffect(() => {
    document.documentElement.dataset["drawer"] = open ? "open" : "closed";
    return () => { delete document.documentElement.dataset["drawer"]; };
  }, [open]);
  useEffect(() => {
    if (window.matchMedia("(min-width: 1200px)").matches) setOpen(true);
  }, []);
  const normalized = query.trim().toLowerCase();
  const visibleProjects = projects.filter((project) => project.name.toLowerCase().includes(normalized));
  const visibleRecents = recents.filter((recent) => recent.label.toLowerCase().includes(normalized));
  const newChat = () => onNewChat?.();
  const menu = (label: string, save: ((name: string) => void) | undefined, remove: (() => void) | undefined) => <details className="sidebar-menu"><summary aria-label={`Options for ${label}`}><MoreHorizontal size={14} /></summary><div>{save && <button onClick={() => { setNewName(label); setRenaming({ save }); }}>Rename</button>}{remove && <button onClick={remove}>Remove</button>}</div></details>;
  return <>
    <div ref={drawer} className={cn("app-drawer", open && "is-open")} aria-hidden={!open}>
      <aside className="app-sidebar" aria-label="Main sidebar">
        <header className="sidebar-head">
          <button className="sidebar-brand" aria-label="Calvras home" title="Calvras" onClick={newChat}><img src="/calvras-logo.png" alt="" /><span>Calvras</span></button>
          <button className="sidebar-close" aria-label="Close sidebar" title="Close sidebar · Esc" onClick={() => setOpen(false)}><X size={15} /></button>
        </header>
        <div className="sidebar-actions">
          <button className="sidebar-new" onClick={newChat}><SquarePen size={15} /><span>New chat</span></button>
          <label className="sidebar-search"><Search size={14} /><input aria-label="Search sidebar" placeholder="Search chats and projects" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        </div>
        <div className="sidebar-list">
          {visibleProjects.length > 0 && <section>
            <p className="sidebar-caption"><span>Projects</span><span>{visibleProjects.length}</span></p>
            {visibleProjects.map((project) => { const id = project.path || project.id || project.name; const isOpen = Boolean(expanded[id]); return <div key={id} className="sidebar-project">
              <div className="sidebar-row">
                <button className="sidebar-disclosure" aria-label={`${isOpen ? "Collapse" : "Expand"} ${project.name}`} aria-expanded={isOpen} onClick={() => setExpanded((current) => ({ ...current, [id]: !current[id] }))}><ChevronDown size={12} className={cn("transition-transform", !isOpen && "-rotate-90")} /></button>
                <Folder size={14} className="sidebar-row-icon" />
                <button className="sidebar-row-label" title={project.path} onClick={() => { onSelectProject?.(project); }}>{project.name}</button>
                {menu(project.name, onRenameProject ? (name) => onRenameProject(project, name) : undefined, onDeleteProject ? () => onDeleteProject(project) : undefined)}
              </div>
              {isOpen && <div className="sidebar-tasks">
                {(project.tasks || []).slice(0, 8).map((task) => <button key={task} className="sidebar-task" onClick={() => { const recent = recents.find((item) => item.label === task && item.projectPath === project.path); if (recent) onSelectRecent?.(recent); else onSelectProject?.(project); }}>{task}</button>)}
                {!project.tasks?.length && <p>No conversations yet</p>}
              </div>}
            </div>; })}
          </section>}
          {visibleRecents.length > 0 && <section>
            <p className="sidebar-caption"><span>Recent</span><span>{visibleRecents.length}</span></p>
            {visibleRecents.map((recent) => <div key={recent.id || recent.label} className="sidebar-row sidebar-recent">
              <button className="sidebar-row-label" onClick={() => { onSelectRecent?.(recent); }}>{recent.label}</button>
              {menu(recent.label, onRenameRecent ? (name) => onRenameRecent(recent, name) : undefined, onDeleteRecent ? () => onDeleteRecent(recent) : undefined)}
            </div>)}
          </section>}
          {!visibleProjects.length && !visibleRecents.length && <p className="sidebar-empty">{normalized ? `Nothing matches “${query.trim()}”.` : "Projects and chats will appear here."}</p>}
        </div>
        <footer className="sidebar-foot">
          <button className="sidebar-foot-row" onClick={() => setSettings(true)}><Settings size={15} /><span>Settings</span><kbd>Ctrl ,</kbd></button>
          <p className="sidebar-foot-note">On this computer</p>
        </footer>
      </aside>
    </div>
    <SettingsPanel open={settings} onOpenChange={setSettings} />
    <Dialog open={Boolean(renaming)} onOpenChange={(open) => { if (!open) setRenaming(null); }}><DialogContent className="rounded-2xl"><DialogTitle>Rename</DialogTitle><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (newName.trim()) { renaming?.save(newName.trim()); setRenaming(null); } }}><input aria-label="New name" autoFocus className="settings-control w-full" value={newName} onChange={(event) => setNewName(event.target.value)} /><button className="rounded-lg bg-white/90 px-4 py-2 text-xs text-black" disabled={!newName.trim()}>Save name</button></form></DialogContent></Dialog>
  </>;
}
