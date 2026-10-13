import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { CalvrasSidebar } from "../components/CalvrasSidebar";
import { ProjectProvider, useProjects } from "../lib/project-context";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Calvras — Autonomous Coding Agent" },
      { name: "description", content: "Your autonomous coding agent that builds and edits code." },
      { property: "og:title", content: "Calvras" },
      { property: "og:description", content: "Your autonomous coding agent." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/calvras-logo.png", type: "image/png" },
      { rel: "shortcut icon", href: "/calvras-logo.png", type: "image/png" },
      { rel: "apple-touch-icon", href: "/calvras-logo.png" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function SidebarWithProjects() {
  const { projects, recents, triggerNewChat, setActiveProject, deleteRecent, deleteProject, renameRecent, renameProject } = useProjects();
  const router = useRouter();

  return (
    <CalvrasSidebar
      projects={projects.map((p) => ({ id: p.path, path: p.path, name: p.name, tasks: p.tasks }))}
      recents={recents}
      onNewChat={() => {
        triggerNewChat();
        if (router.state.location.pathname !== "/") {
          router.navigate({ to: "/" });
        }
      }}
      onSelectProject={(project) => {
        if (project.path) {
          setActiveProject({ name: project.name, path: project.path, tasks: project.tasks });
        }
        if (router.state.location.pathname !== "/") {
          router.navigate({ to: "/" });
        }
      }}
      onSelectRecent={(recent) => {
        if (recent.projectPath && recent.projectName) {
          setActiveProject({ name: recent.projectName, path: recent.projectPath });
        }
        if (router.state.location.pathname !== "/") {
          router.navigate({ to: "/" });
        }
      }}
      onDeleteRecent={(item) => {
        if (item.id) deleteRecent(item.id);
        if (item.label) deleteRecent(item.label);
      }}
      onDeleteProject={(project) => deleteProject(project.path || project.name)}
      onRenameRecent={(item, newLabel) => renameRecent(item.id || item.label, newLabel)}
      onRenameProject={(project, newName) => renameProject(project.path || project.name, newName)}
    />
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();
  const isExcludedPage = router.state.location.pathname === "/signin" || router.state.location.pathname === "/pricing";

  return (
    <QueryClientProvider client={queryClient}>
      <ProjectProvider>
        {!isExcludedPage && <SidebarWithProjects />}
        {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
        <Outlet />
      </ProjectProvider>
    </QueryClientProvider>
  );
}
