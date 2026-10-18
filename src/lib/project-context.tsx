import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

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

interface ProjectContextValue {
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
  newChatSignal: number;
  triggerNewChat: () => void;
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
  newChatSignal: 0,
  triggerNewChat: () => {},
});

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [recents, setRecents] = useState<RecentChat[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [newChatSignal, setNewChatSignal] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const storedP = localStorage.getItem("calvras_projects");
      if (storedP) setProjects(JSON.parse(storedP));
      const storedR = localStorage.getItem("calvras_recents");
      if (storedR) setRecents(JSON.parse(storedR));
      const storedActive = localStorage.getItem("calvras_active_project");
      if (storedActive) setActiveProject(JSON.parse(storedActive));
    } catch {}
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    try {
      localStorage.setItem("calvras_projects", JSON.stringify(projects));
    } catch {}
  }, [projects, mounted]);

  useEffect(() => {
    if (!mounted) return;
    try {
      localStorage.setItem("calvras_recents", JSON.stringify(recents));
    } catch {}
  }, [recents, mounted]);

  useEffect(() => {
    if (!mounted) return;
    try {
      if (activeProject) {
        localStorage.setItem("calvras_active_project", JSON.stringify(activeProject));
      } else {
        localStorage.removeItem("calvras_active_project");
      }
    } catch {}
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

  const triggerNewChat = () => {
    setNewChatSignal((s) => s + 1);
  };

  const deleteRecent = (idOrLabel: string) => {
    setRecents((prev) => prev.filter((r) => r.id !== idOrLabel && r.label !== idOrLabel));
    setProjects((prev) =>
      prev.map((proj) => ({
        ...proj,
        ...(proj.tasks ? { tasks: proj.tasks.filter((t) => t !== idOrLabel) } : {}),
      }))
    );
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
        newChatSignal,
        triggerNewChat,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProjects() {
  return useContext(ProjectContext);
}
