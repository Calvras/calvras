import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { clearScoped, readChats, readScoped, writeChats, writeScoped, type StoredChat } from "./account";

export interface Project {
  name: string;
  path: string;
  tasks?: string[];
}

export interface RecentChat {
  id: string;
  label: string;
  projectPath?: string;
  projectName?: string;
  hasAlert?: boolean;
}

export interface ProjectContextValue {
  projects: Project[];
  recents: RecentChat[];
  activeProject: Project | null;
  setActiveProject: (p: Project | null) => void;
  addProject: (p: Project) => void;
  addRecent: (r: RecentChat) => void;
  deleteRecent: (id: string) => void;
  deleteProject: (path: string) => void;
  renameRecent: (id: string, newLabel: string) => void;
  renameProject: (path: string, newName: string) => void;
  triggerNewChat: () => void;
  /** The conversation open right now, or null for a fresh one that nothing has been written to. */
  activeChatId: string | null;
  /** Everything this account has said and the agent has done, newest first. */
  chats: StoredChat[];
  openChat: (id: string) => void;
  saveChat: (id: string, patch: Partial<Pick<StoredChat, "messages" | "label" | "projectPath" | "projectName" | "memory">>) => void;
}

const ProjectContext = createContext<ProjectContextValue>({
  projects: [],
  recents: [],
  activeProject: null,
  setActiveProject: () => {},
  addProject: () => {},
  addRecent: () => {},
  deleteRecent: () => {},
  deleteProject: () => {},
  renameRecent: () => {},
  renameProject: () => {},
  triggerNewChat: () => {},
  activeChatId: null,
  chats: [],
  openChat: () => {},
  saveChat: () => {},
});

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [recents, setRecents] = useState<RecentChat[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [chats, setChats] = useState<Record<string, StoredChat>>({});
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const storedProjects = readScoped<Project[]>("projects", []);
    const storedRecents = readScoped<RecentChat[]>("recents", []);
    const storedActive = readScoped<Project | null>("activeProject", null);
    setProjects(storedProjects);
    setRecents(storedRecents);
    if (storedActive) setActiveProject(storedActive);
    const stored = readChats();
    setChats(stored);
    const openest = Object.values(stored).sort((a, b) => b.savedAt - a.savedAt)[0];
    if (openest) setActiveChatId(openest.id);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    writeScoped("projects", projects);
  }, [projects, mounted]);

  useEffect(() => {
    if (!mounted) return;
    writeScoped("recents", recents);
  }, [recents, mounted]);

  useEffect(() => {
    if (!mounted) return;
    writeChats(chats);
  }, [chats, mounted]);

  useEffect(() => {
    if (!mounted) return;
    if (activeProject) writeScoped("activeProject", activeProject);
    else clearScoped("activeProject");
  }, [activeProject, mounted]);

  const addProject = (p: Project) => {
    setProjects((prev) => {
      const filtered = prev.filter((x) => x.path !== p.path);
      return [p, ...filtered];
    });
    setActiveProject(p);
  };

  const addRecent = (r: RecentChat) => {
    setRecents((prev) => {
      const filtered = prev.filter((x) => x.id !== r.id && x.label !== r.label);
      return [r, ...filtered].slice(0, 30);
    });
    // The conversation gets its place in the store beside its History entry, so opening it
    // later finds the transcript that was written under the same id.
    setChats((prev) => ({
      ...prev,
      [r.id]: {
        ...(prev[r.id] || { id: r.id, label: r.label, messages: [] }),
        id: r.id,
        label: r.label,
        ...(r.projectPath ? { projectPath: r.projectPath } : {}),
        ...(r.projectName ? { projectName: r.projectName } : {}),
        savedAt: Date.now(),
      },
    }));
    setActiveChatId(r.id);

    // Also register task / sub-recent under its project
    if (r.projectPath) {
      setProjects((prev) =>
        prev.map((proj) => {
          if (proj.path === r.projectPath) {
            const currentTasks = proj.tasks || [];
            if (!currentTasks.includes(r.label)) {
              return {
                ...proj,
                tasks: [r.label, ...currentTasks].slice(0, 10),
              };
            }
          }
          return proj;
        })
      );
    }
  };

  const triggerNewChat = () => setActiveChatId(null);

  const openChat = (id: string) => {
    if (!chats[id]) return;
    setActiveChatId(id);
    const chat = chats[id]!;
    if (chat.projectPath && chat.projectName) setActiveProject({ name: chat.projectName, path: chat.projectPath });
  };

  const saveChat = (id: string, patch: Partial<Pick<StoredChat, "messages" | "label" | "projectPath" | "projectName" | "memory">>) => {
    setChats((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || { id, label: patch.label || "Conversation", messages: [], savedAt: 0 }), ...patch, savedAt: Date.now() },
    }));
  };

  const deleteRecent = (idOrLabel: string) => {
    setRecents((prev) => prev.filter((r) => r.id !== idOrLabel && r.label !== idOrLabel));
    setProjects((prev) =>
      prev.map((proj) => ({
        ...proj,
        ...(proj.tasks ? { tasks: proj.tasks.filter((t) => t !== idOrLabel) } : {}),
      }))
    );
    const gone = Object.values(chats).find((chat) => chat.id === idOrLabel || chat.label === idOrLabel);
    if (!gone) return;
    const { [gone.id]: _removed, ...rest } = chats;
    setChats(rest);
    if (activeChatId === gone.id) setActiveChatId(null);
  };

  const deleteProject = (path: string) => {
    setProjects((prev) => prev.filter((p) => p.path !== path));
    setActiveProject((prev) => (prev?.path === path ? null : prev));
  };

  const renameRecent = (idOrLabel: string, newLabel: string) => {
    setRecents((prev) =>
      prev.map((r) => (r.id === idOrLabel || r.label === idOrLabel ? { ...r, label: newLabel } : r))
    );
    setProjects((prev) =>
      prev.map((proj) => ({
        ...proj,
        ...(proj.tasks ? { tasks: proj.tasks.map((t) => (t === idOrLabel ? newLabel : t)) } : {}),
      }))
    );
    const match = Object.values(chats).find((chat) => chat.id === idOrLabel || chat.label === idOrLabel);
    if (match) saveChat(match.id, { label: newLabel });
  };

  const renameProject = (path: string, newName: string) => {
    setProjects((prev) => prev.map((p) => (p.path === path ? { ...p, name: newName } : p)));
    setActiveProject((prev) => (prev?.path === path ? { ...prev, name: newName } : prev));
  };

  return (
    <ProjectContext.Provider
      value={{
        projects,
        recents,
        activeProject,
        setActiveProject,
        addProject,
        addRecent,
        deleteRecent,
        deleteProject,
        renameRecent,
        renameProject,
        triggerNewChat,
        activeChatId,
        chats: Object.values(chats).sort((a, b) => b.savedAt - a.savedAt),
        openChat,
        saveChat,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProjects() {
  return useContext(ProjectContext);
}
