import { useEffect, useRef, useState } from "react";
import { ChevronDown, Folder, FolderOpen, History, PanelLeftClose, Search, Settings, SquarePen, MoreHorizontal } from "lucide-react";
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
  const [section, setSection] = useState<"projects" | "history" | null>(null);
  const [settings, setSettings] = useState(false);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<{ save: (name: string) => void } | null>(null);
  const [newName, setNewName] = useState("");
  const actions = (label: string, save: ((name: string) => void) | undefined, remove: (() => void) | undefined) => <details className="sidebar-menu"><summary aria-label={`Options for ${label}`}><MoreHorizontal size={14} /></summary><div>{save && <button onClick={() => { setNewName(label); setRenaming({ save }); }}>Rename</button>}{remove && <button onClick={remove}>Remove from sidebar</button>}</div></details>;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const panel = useRef<HTMLElement>(null);
  const rail = useRef<HTMLElement>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ",") { event.preventDefault(); setSettings(true); }
      if (event.key === "Escape") setSection(null);
    };
    const pointer = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !rail.current?.contains(event.target as Node)) setSection(null); };
    const openSettings = () => setSettings(true);
    document.addEventListener("keydown", key); document.addEventListener("pointerdown", pointer); window.addEventListener("calvras:open-settings", openSettings);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", pointer); window.removeEventListener("calvras:open-settings", openSettings); };
  }, []);
  const toggle = (next: "projects" | "history") => { setSection((current) => current === next ? null : next); setQuery(""); };
  const newChat = () => { onNewChat?.(); setSection(null); };
  return <>
    <nav ref={rail} aria-label="Main navigation" className="app-rail">
      <button className="shell-icon-button rail-brand" aria-label="Calvras home" title="Calvras" onClick={newChat}><img src="/calvras-logo.png" alt="" className="size-7 object-contain" /></button>
      <button className="shell-icon-button" aria-label="New chat" title="New chat" onClick={newChat}><SquarePen size={18} /></button>
      <button className={cn("shell-icon-button", section === "projects" && "is-selected")} aria-label="Projects" title="Projects" aria-expanded={section === "projects"} onClick={() => toggle("projects")}><FolderOpen size={18} /></button>
      <button className={cn("shell-icon-button", section === "history" && "is-selected")} aria-label="Chat history" title="Chat history" aria-expanded={section === "history"} onClick={() => toggle("history")}><History size={18} /></button>
      <div className="flex-1" />
      <button className="shell-icon-button" aria-label="Settings" title="Settings · Ctrl+," onClick={() => { setSection(null); setSettings(true); }}><Settings size={18} /></button>
    </nav>
    {section && <aside ref={panel} aria-label={section === "projects" ? "Projects sidebar" : "History sidebar"} className="app-sidebar">
      <header className="flex h-16 shrink-0 items-center justify-between px-5"><h2 className="text-sm font-semibold tracking-tight">{section === "projects" ? "Projects" : "History"}</h2><button className="shell-icon-button" aria-label="Close sidebar" title="Close sidebar · Esc" onClick={() => setSection(null)}><PanelLeftClose size={17} /></button></header>
      <div className="px-4 pb-4"><label className="flex items-center gap-2 rounded-lg bg-white/[0.045] px-3 py-2 text-white/35"><Search size={14} /><input aria-label="Search sidebar" placeholder={section === "projects" ? "Find a project" : "Search chats"} value={query} onChange={(event) => setQuery(event.target.value)} className="w-full min-w-0 bg-transparent text-xs text-white/80 outline-none placeholder:text-white/30" /></label></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-5">
        {section === "projects" && <><button className="sidebar-action mb-5" onClick={newChat}><SquarePen size={15} />New conversation</button><p className="sidebar-caption">Your workspaces <span>{projects.length}</span></p>
          {projects.filter((project) => project.name.toLowerCase().includes(query.toLowerCase())).map((project) => { const id = project.path || project.id || project.name; return <div key={id} className="mb-1"><div className="sidebar-row"><button aria-label={`Expand ${project.name}`} onClick={() => setExpanded((current) => ({ ...current, [id]: !current[id] }))} className="p-0.5 text-white/30"><ChevronDown size={12} className={cn("transition-transform", !expanded[id] && "-rotate-90")} /></button><Folder size={15} className="shrink-0 text-white/50" /><button className="min-w-0 flex-1 truncate text-left" title={project.path} onClick={() => { onSelectProject?.(project); setSection(null); }}>{project.name}</button>{actions(project.name, onRenameProject ? (name) => onRenameProject(project,name) : undefined, onDeleteProject ? () => onDeleteProject(project) : undefined)}</div>{expanded[id] && <div className="ml-7 border-l border-white/[0.07] pl-2">{(project.tasks || []).slice(0, 8).map((task) => <button key={task} className="sidebar-action text-white/45" onClick={() => { const recent = recents.find((item) => item.label === task && item.projectPath === project.path); if (recent) onSelectRecent?.(recent); else onSelectProject?.(project); setSection(null); }}><span className="truncate">{task}</span></button>)}{!project.tasks?.length && <p className="px-2 py-2 text-[11px] text-white/25">No conversations yet</p>}</div>}</div>; })}
          {!projects.length && <p className="px-2 py-4 text-xs leading-5 text-white/35">Open a folder to keep your project and conversations together.</p>}</>}
        {section === "history" && <><p className="sidebar-caption">Recent conversations <span>{recents.length}</span></p>{recents.filter((recent) => recent.label.toLowerCase().includes(query.toLowerCase())).map((recent) => <div key={recent.id || recent.label} className="sidebar-row"><button className="min-w-0 flex-1 truncate text-left" onClick={() => { onSelectRecent?.(recent); setSection(null); }}>{recent.label}</button>{actions(recent.label, onRenameRecent ? (name) => onRenameRecent(recent,name) : undefined, onDeleteRecent ? () => onDeleteRecent(recent) : undefined)}</div>)}{!recents.length && <p className="px-2 py-4 text-xs text-white/35">Your conversations will appear here.</p>}</>}
      </div>
      <footer className="border-t border-white/[0.06] px-5 py-4 text-[10px] text-white/30">On this computer</footer>
    </aside>}
    <SettingsPanel open={settings} onOpenChange={setSettings} />
    <Dialog open={Boolean(renaming)} onOpenChange={(open) => { if (!open) setRenaming(null); }}><DialogContent className="rounded-2xl"><DialogTitle>Rename</DialogTitle><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (newName.trim()) { renaming?.save(newName.trim()); setRenaming(null); } }}><input aria-label="New name" autoFocus className="settings-control w-full" value={newName} onChange={(event) => setNewName(event.target.value)} /><button className="rounded-lg bg-white/90 px-4 py-2 text-xs text-black" disabled={!newName.trim()}>Save name</button></form></DialogContent></Dialog>
  </>;
}
