import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalDock } from "../components/TerminalDock";
import { PluginsPanel } from "../components/PluginsPanel";
import { TasksPanel } from "../components/TasksPanel";
import { createPlugin, loadPlugins } from "../lib/plugins";

const shellChunks: string[] = [];

// A real shell session never finishes on its own — it idles at its prompt until the process exits.
// The stub has to idle the same way or the panel would flip to "stopped" between assertions.
function shellStream(chunks: string[]) {
  let pending = [...chunks];
  let waiter: ((result: ReadableStreamReadResult<Uint8Array>) => void) | null = null;
  return {
    getReader: () => ({
      read: () => {
        if (pending.length) return Promise.resolve({ done: false, value: new TextEncoder().encode(pending.shift()!) });
        return new Promise((resolve) => { waiter = resolve; });
      },
      cancel: () => { waiter?.({ done: true, value: undefined }); return Promise.resolve(); },
    }),
    push: (chunk: string) => {
      if (waiter) { const done = waiter; waiter = null; done({ done: false, value: new TextEncoder().encode(chunk) }); }
      else pending.push(chunk);
    },
  };
}

let shell: ReturnType<typeof shellStream> | null = null;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === "/api/terminal/open") {
    shell = shellStream(["C:\\work\\demo>", ...shellChunks.splice(0)]);
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === "x-calvras-terminal" ? "session-1" : null) },
      body: shell,
      json: async () => ({}),
    } as unknown as Response;
  }
  const body = JSON.parse(String(init?.body || "{}"));
  if (url === "/api/terminal/write" && body.data === "dir\r\n") shell?.push("dir\r\nVolume in drive C has no label.\r\nC:\\work\\demo>");
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, output: body.command === "cd" ? "" : "calvras says hi\n", exitCode: 0, cwd: body.cwd || "." }),
  } as unknown as Response;
});

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockClear();
  shell = null;
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("terminal dock", () => {
  const open = async () => {
    render(<TerminalDock projectPath={"C:\\work\\demo"} projectName="demo" onClose={() => {}} />);
    const input = await waitFor(() => {
      const field = screen.getByLabelText("Terminal command");
      if (!field.matches(":not([disabled])")) throw new Error("still connecting");
      return field;
    });
    return input;
  };

  it("joins the folder's live shell and paints what it writes", async () => {
    shellChunks.push("dir\r\nVolume in drive C has no label.\r\n");
    const input = await open();
    expect(input).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledWith("/api/terminal/open", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ projectPath: "C:\\work\\demo" });
    await waitFor(() => expect(screen.getByRole("log")).toHaveTextContent("Volume in drive C has no label."));
    // The prompt is the shell's own, not one the panel invented beside a fake command line.
    expect(screen.getByRole("log")).toHaveTextContent("C:\\work\\demo>");
    expect(screen.getByText("live")).toBeInTheDocument();
  });

  it("hands a typed command to the shell instead of running one process per line", async () => {
    const input = await open();
    fetchMock.mockClear();
    fireEvent.change(input, { target: { value: "dir" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock).toHaveBeenCalledWith("/api/terminal/write", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ sessionId: "session-1", data: "dir\r\n" });
    expect(input).toHaveValue("");
    // The reply arrives on the same stream: nothing here re-ran the command to build a result box.
    await waitFor(() => expect(screen.getByRole("log")).toHaveTextContent("Volume in drive C has no label."));
  });

  it("sends Ctrl+C to the shell so a running command can be stopped", async () => {
    const input = await open();
    fetchMock.mockClear();
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ sessionId: "session-1", data: "\x03" });
  });

  it("stays disabled until a folder is chosen", () => {
    render(<TerminalDock projectPath={null} projectName={null} onClose={() => {}} />);
    expect(screen.getByLabelText("Terminal command")).toBeDisabled();
    expect(screen.getByRole("log")).toHaveTextContent("Open a folder to use the terminal.");
  });

  it("closes the panel through its own control", async () => {
    const onClose = vi.fn();
    render(<TerminalDock projectPath={"C:\\work\\demo"} projectName="demo" onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close terminal" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("plugins panel", () => {
  it("creates a plugin and reports it to the app", () => {
    const onChanged = vi.fn();
    render(<PluginsPanel onClose={() => {}} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "New plugin" }));
    fireEvent.change(screen.getByPlaceholderText("Use pnpm"), { target: { value: "Use pnpm" } });
    fireEvent.change(screen.getByPlaceholderText(/Write the rules/), { target: { value: "Always use pnpm and run the typecheck." } });
    fireEvent.click(screen.getByRole("button", { name: "Save plugin" }));

    expect(screen.getByText("Use pnpm")).toBeInTheDocument();
    expect(screen.getByText("Always use pnpm and run the typecheck.")).toBeInTheDocument();
    expect(loadPlugins()).toHaveLength(1);
    expect(onChanged).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ name: "Use pnpm", enabled: true })]));
  });

  it("refuses to save an empty plugin", () => {
    render(<PluginsPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "New plugin" }));
    fireEvent.click(screen.getByRole("button", { name: "Save plugin" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give the plugin a name.");
  });

  it("toggles a plugin on and off", () => {
    createPlugin({ name: "House rules", instructions: "Use pnpm." });
    render(<PluginsPanel onClose={() => {}} />);
    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(loadPlugins()[0]?.enabled).toBe(false);
  });

  it("requires a second click to delete", () => {
    createPlugin({ name: "Temporary", instructions: "Remove me." });
    render(<PluginsPanel onClose={() => {}} />);
    const remove = screen.getByRole("button", { name: "Delete Temporary" });
    fireEvent.click(remove);
    expect(screen.getByText("Sure?")).toBeInTheDocument();
    expect(loadPlugins()).toHaveLength(1);
    fireEvent.click(remove);
    expect(screen.queryByText("Temporary")).not.toBeInTheDocument();
    expect(loadPlugins()).toHaveLength(0);
  });

  it("opens the plugin guide from the slash menu action", () => {
    render(<PluginsPanel initialView="guide" onClose={() => {}} />);
    expect(screen.getByText("How to manage plugins")).toBeInTheDocument();
    expect(screen.getByText(/Turn it on or off/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to plugins" }));
    expect(screen.getByRole("button", { name: "New plugin" })).toBeInTheDocument();
  });
});

describe("tasks panel", () => {
  it("shows environment details, live steps, and workers", async () => {
    const execute = vi.fn(async (action: { type: string }) => action.type === "git_branch"
      ? { ok: true, output: "* feature/tasks\n  main" }
      : { ok: true, output: " M src/app.ts" });
    render(
      <TasksPanel
        projectPath={"C:\\work\\demo"}
        projectName="demo"
        accessMode="automatic"
        tasks={[]}
        agents={[{
          role: "builder",
          active: { id: "job-1", role: "builder", task: "Wire the settings route", status: "running", updates: [] },
          queued: 1,
          jobs: [
            { id: "job-1", role: "builder", task: "Wire the settings route", status: "running", updates: [] },
          ],
        }]}
        steps={[{ id: "read", label: "Read the entry point", detail: "src/app.ts", status: "completed" }]}
        previewUrl="http://localhost:5173"
        execute={execute}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText("feature/tasks")).toBeInTheDocument();
    expect(screen.getByText("1 changed file")).toBeInTheDocument();
    expect(screen.getByText("Work automatically")).toBeInTheDocument();
    expect(screen.getByText("http://localhost:5173/")).toBeInTheDocument();
    expect(screen.getByText("Read the entry point")).toBeInTheDocument();
    expect(screen.getByText("running · 1 queued")).toBeInTheDocument();
    // The pool reports a group per role, so the other two are idle rather than absent, and each
    // row carries the avatar generated from its own role name.
    expect(screen.getAllByText("available")).toHaveLength(2);
    expect(screen.getByText(/1 queued/)).toBeInTheDocument();
    expect(document.querySelectorAll("canvas")).toHaveLength(3);
    expect(execute).toHaveBeenCalledWith({ type: "git_branch" });
    expect(execute).toHaveBeenCalledWith({ type: "git_status" });
  });

  it("names the engine each role is routed onto", () => {
    render(
      <TasksPanel
        projectPath={null}
        projectName={null}
        accessMode="automatic"
        tasks={[]}
        agents={[]}
        steps={[]}
        routing={{ builder: { profile: "thorough", model: "gemini-3.8-flash" }, verifier: { profile: "balanced" }, researcher: {} }}
        execute={vi.fn()}
        onClose={() => {}}
      />,
    );
    const group = (label: string) => (screen.getByText(label).parentElement as HTMLElement);
    expect(within(group("Implementation")).getByText("thorough · gemini-3.8-flash")).toBeInTheDocument();
    expect(within(group("Verification")).getByText("balanced")).toBeInTheDocument();
    // A role whose session reported no engine shows nothing rather than an invented name.
    expect(within(group("Research & review")).queryByText(/quick|balanced|thorough/)).not.toBeInTheDocument();
  });

  it("explains how to add a folder when none is selected", () => {
    render(
      <TasksPanel projectPath={null} projectName={null} accessMode="automatic" tasks={[]} agents={[]} steps={[]} execute={vi.fn()} onClose={() => {}} />,
    );
    expect(screen.getByText("No folder yet")).toBeInTheDocument();
    expect(screen.getByText("Use the folder chip below the composer to add one.")).toBeInTheDocument();
    expect(screen.getByText("Nothing is running right now. Ask Calvras for something and its steps show up here.")).toBeInTheDocument();
  });
});

describe("scheduled work in the tasks panel", () => {
  const HOUR = 3_600_000;
  const render_ = (scheduled: any[], onChange = vi.fn(async () => {})) => {
    render(
      <TasksPanel projectPath={null} projectName={null} accessMode="automatic" tasks={[]} agents={[]} steps={[]} scheduled={scheduled} onScheduleChange={onChange} execute={vi.fn()} onClose={() => {}} />,
    );
    return onChange;
  };

  it("says what an appointment is and when it next fires", () => {
    render_([
      { id: "d1", prompt: "Tidy the screenshots", kind: "daily", timeOfDay: "07:00", mode: "automatic", enabled: true, nextRunAt: Date.now() + 3 * HOUR },
      { id: "e1", prompt: "Check the build", kind: "every", everyMs: 30 * 60_000, mode: "automatic", enabled: true, nextRunAt: Date.now() + 12 * 60_000 },
    ]);
    expect(screen.getByText(/Every day at 07:00 · In 3 hours/)).toBeInTheDocument();
    expect(screen.getByText("Tidy the screenshots")).toBeInTheDocument();
    expect(screen.getByText(/Every 30 minutes · In 12 minutes/)).toBeInTheDocument();
    // Nothing is invented about a run that has not happened yet.
    expect(screen.queryByText(/Last fired/)).not.toBeInTheDocument();
  });

  it("reports how the last firing actually ended", () => {
    render_([{ id: "d1", prompt: "Nightly tidy", kind: "daily", timeOfDay: "23:30", mode: "automatic", enabled: true, nextRunAt: Date.now() + HOUR, lastRunAt: Date.now() - HOUR, lastStatus: "blocked", lastNote: "The test command exits 1." }]);
    expect(screen.getByText(/Last fired .* · blocked — The test command exits 1\./)).toBeInTheDocument();
  });

  it("calls a one-off whose moment has gone by overdue instead of pretending", () => {
    render_([{ id: "a1", prompt: "Open the conference", kind: "at", at: Date.now() - 60_000, mode: "automatic", enabled: true, nextRunAt: Date.now() - 60_000 }]);
    expect(screen.getByText(/Once, at .* · Overdue/)).toBeInTheDocument();
  });

  it("pauses and cancels through the same ledger the agent writes", async () => {
    const onChange = render_([{ id: "d1", prompt: "Every morning brief", kind: "daily", timeOfDay: "07:00", mode: "automatic", enabled: true, nextRunAt: Date.now() + HOUR }]);
    fireEvent.click(screen.getByRole("button", { name: /Pause Every day at 07:00/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("d1", "pause"));
    fireEvent.click(screen.getByRole("button", { name: /Cancel Every day at 07:00/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("d1", "cancel"));
  });

  it("shows a paused appointment as paused and offers to resume it", () => {
    render_([{ id: "d1", prompt: "Paused run", kind: "daily", timeOfDay: "07:00", mode: "automatic", enabled: false, nextRunAt: Date.now() + HOUR }]);
    expect(screen.getByText(/Paused run/)).toBeInTheDocument();
    expect(screen.getByText(/Every day at 07:00 · Paused/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Resume Every day at 07:00/ })).toBeInTheDocument();
  });

  it("surfaces the reason a change was refused rather than failing silently", async () => {
    const onChange = vi.fn(async () => { throw new Error("That one-off time has already passed. Schedule it again."); });
    render_([{ id: "a1", prompt: "Stand-up", kind: "at", at: Date.now() - 1000, mode: "automatic", enabled: false, nextRunAt: Date.now() - 1000 }], onChange);
    fireEvent.click(screen.getByRole("button", { name: /Resume Once, at/ }));
    expect(await screen.findByText("That one-off time has already passed. Schedule it again.")).toBeInTheDocument();
  });

  it("says plainly when nothing is appointed", () => {
    render_([]);
    expect(screen.getByText("Nothing is set to start on its own. Ask Calvras to run something later and it appears here, and it still fires after the app closes and reopens.")).toBeInTheDocument();
  });
});
