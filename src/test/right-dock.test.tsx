import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RightDock, { buildTree, highlightFile, type DockTab } from "../components/RightDock";
import { safePreviewUrl } from "../lib/preview-url";
import type { SubagentJob } from "../components/AgentActivity";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const listResult = { ok: true, entries: [
  { path: "package.json", type: "file" },
  { path: "src", type: "directory" },
  { path: "src\\main.ts", type: "file" },
  { path: "src/components", type: "directory" },
  { path: "src/components/App.tsx", type: "file" },
] };

function dock(overrides: Partial<{ tab: DockTab; execute: any; previewUrl: string; showBrowser: boolean; showAgents: boolean; agents: any[]; jobs: SubagentJob[]; onClose: any; onPickFolder: any; projectPath: string | null }> = {}) {
  const execute = overrides.execute || vi.fn(async (action: any) => (action.type === "list_files" ? listResult : { ok: true, content: "export const actual = 42;" }));
  return render(
    <RightDock
      open
      tab={overrides.tab || "files"}
      onTabChange={vi.fn()}
      onClose={overrides.onClose || vi.fn()}
      projectPath={"projectPath" in overrides ? overrides.projectPath : "C:/project"}
      projectName="fixture"
      previewUrl={overrides.previewUrl || ""}
      onPickFolder={overrides.onPickFolder}
      showBrowser={Boolean(overrides.showBrowser)}
      showAgents={Boolean(overrides.showAgents)}
      browserActive={false}
      agents={overrides.agents || []}
      jobs={overrides.jobs || []}
      execute={execute}
    />,
  );
}

describe("workspace dock", () => {
  it("groups the runtime's flat listing into folders, whatever separator it used", () => {
    const tree = buildTree(listResult.entries);
    expect(tree.files.map((file) => file.path)).toEqual(["package.json"]);
    expect(tree.dirs.map((dir) => dir.name)).toEqual(["src"]);
    const src = tree.dirs[0]!;
    expect(src.files.map((file) => file.path)).toEqual(["src/main.ts"]);
    expect(src.dirs.map((dir) => dir.name)).toEqual(["components"]);
  });

  it("shows the folder's real files and reads the one the user clicks", async () => {
    const execute = vi.fn(async (action: any) => (action.type === "list_files" ? listResult : { ok: true, content: "export const actual = 42;", totalLines: 1 }));
    dock({ execute });
    fireEvent.click(await screen.findByRole("button", { name: /src/ }));
    fireEvent.click(await screen.findByRole("button", { name: /main\.ts/ }));
    await waitFor(() => expect(screen.getByLabelText("File contents")).toHaveTextContent("actual = 42"));
    expect(execute).toHaveBeenLastCalledWith({ type: "read_file", path: "src/main.ts" });
    expect(screen.getByLabelText("File contents").querySelector(".hljs-keyword")).toBeTruthy();
    expect(screen.getByText("Source").nextElementSibling).toHaveTextContent("TypeScript");
    expect(screen.getByText(/Updated at|Reading the folder|Not read yet/)).not.toHaveTextContent(/AM|PM/);
    fireEvent.click(screen.getByRole("button", { name: "All files" }));
    expect(screen.getByRole("button", { name: /package\.json/ })).toBeInTheDocument();
  });

  it("escapes markup in a file it is only showing", () => {
    const html = highlightFile("notes.txt", "<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("offers the browser tab only once the agent has opened a page", () => {
    dock({ showBrowser: false });
    expect(screen.queryByRole("tab", { name: "Browser" })).not.toBeInTheDocument();
    cleanup();
    dock({ showBrowser: true });
    expect(screen.getByRole("tab", { name: "Browser" })).toBeInTheDocument();
  });

  it("embeds only a verified local server in the preview tab", async () => {
    const execute = vi.fn(async (action: any) => (action.type === "list_files" ? listResult : { ok: true, ready: true, url: "http://localhost:3000" }));
    dock({ tab: "preview", execute, previewUrl: "http://localhost:3000" });
    await waitFor(() => expect(screen.getByTitle("Local project preview")).toHaveAttribute("src", "http://localhost:3000/"));
    cleanup();
    dock({ tab: "preview", execute, previewUrl: "https://example.com" });
    expect(screen.queryByTitle("Local project preview")).not.toBeInTheDocument();
    expect(screen.getByText(/No local server preview is open/)).toBeInTheDocument();
    for (const input of ["javascript:alert(1)", "file:///secret", "https://localhost.evil.com", "http://localhost@evil.com", "http://user:pass@localhost:3000"]) expect(safePreviewUrl(input)).toBeNull();
  });

  it("finds a running server when the preview tab has nothing to show yet", async () => {
    const execute = vi.fn(async (action: any) => (action.type === "check_server" ? { ok: true, ready: true, url: "http://127.0.0.1:4173" } : { ok: true, entries: [] }));
    dock({ tab: "preview", execute, previewUrl: "" });
    fireEvent.click(await screen.findByRole("button", { name: /Look for a running server/ }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith({ type: "check_server" }));
  });

  it("reports the subagents the session actually ran, and can stop one", async () => {
    const job: SubagentJob = { id: "job-1", role: "builder", task: "Rewrite the sidebar", status: "running", startedAt: Date.now() - 5_000, updates: ["Editing App.tsx"] };
    const execute = vi.fn(async () => ({ ok: true }));
    dock({ tab: "agents", execute, showAgents: true, jobs: [job], agents: [{ role: "builder", active: job, queued: 0, jobs: [job] }] });
    await waitFor(() => expect(screen.getAllByText("Rewrite the sidebar").length).toBeGreaterThan(0));
    expect(screen.getAllByText("Implementation").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Editing App.tsx").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Stop Rewrite the sidebar" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith({ type: "cancel_agent", id: "job-1" }));
  });

  it("does not print the worker's last line twice when it is also its report", async () => {
    const line = "The web search failed and notes.md lists three tools.";
    const job: SubagentJob = { id: "job-2", role: "researcher", task: "read notes.md", status: "finished", startedAt: Date.now() - 9_000, endedAt: Date.now(), updates: [line], result: line };
    dock({ tab: "agents", showAgents: true, jobs: [job], agents: [{ role: "researcher", active: null, queued: 0, jobs: [job] }] });
    await waitFor(() => expect(screen.getAllByText("read notes.md").length).toBeGreaterThan(0));
    expect(screen.getAllByText(line)).toHaveLength(1);
  });

  it("says so when no subagent has run", async () => {
    dock({ tab: "agents", showAgents: true });
    await waitFor(() => expect(screen.getByText(/No subagent has run in this session/)).toBeInTheDocument());
  });

  it("closes on Escape and offers the folder picker when nothing is open", async () => {
    const onClose = vi.fn();
    const onPickFolder = vi.fn();
    dock({ onClose, projectPath: null, onPickFolder });
    await waitFor(() => expect(screen.getByText(/Nothing is open yet/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add a project folder" }));
    expect(onPickFolder).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not offer a picker the desktop shell cannot answer", async () => {
    dock({ projectPath: null });
    await waitFor(() => expect(screen.getByText(/Nothing is open yet/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Add a project folder" })).not.toBeInTheDocument();
  });
});
