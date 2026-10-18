import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentActivity } from "../components/AgentActivity";

describe("agent activity", () => {
  it("offers resume beside an interrupted response", () => {
    const resume=vi.fn();render(<AgentActivity done phases={[]} status="stopped" onResume={resume} />);
    fireEvent.click(screen.getByRole("button",{name:"Resume task"}));expect(resume).toHaveBeenCalledOnce();
  });
  it("does not count time while the app was closed as work", () => {
    render(<AgentActivity done startedAt={1000} phases={[{trace:[],message:"Saved reply",startedAt:1000,endedAt:4000}]} />);
    expect(screen.getByText("Thought for")).toHaveTextContent("Thought for 3 seconds");
  });
  it("does not render an empty assistant response below a steering message", () => {
    const {container}=render(<AgentActivity done phases={[]} status="finished" />);
    expect(container).toBeEmptyDOMElement();
  });
  it("merges a multi-phase turn into one measured thinking header", () => {
    render(<AgentActivity done startedAt={1000} endedAt={9000} error="Provider timed out" phases={[{trace:[],message:"Checking the project.",startedAt:1000,endedAt:3000},{trace:[],message:"Provider timed out",startedAt:3000,endedAt:9000}]} />);
    expect(screen.getAllByText("Thought for")).toHaveLength(1);
    expect(screen.getByText("Thought for")).toHaveTextContent("Thought for 8 seconds");
    expect(screen.getAllByText("Provider timed out")).toHaveLength(1);
  });
  it("keeps a running command collapsed to its label and a spinner", () => {
    const trace = [{ id: "command", type: "terminal", primary: "Run tests", command: "npm test", status: "running" as const, output: "first test passed" }];
    const { rerender } = render(<AgentActivity done={false} phases={[{ trace }]} />);
    const header = screen.getByRole("button", { name: /Working/ });
    fireEvent.click(header);
    const row = screen.getByRole("button", { name: "Run tests" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("npm test")).not.toBeInTheDocument();
    rerender(<AgentActivity done={false} phases={[{ trace: [{ ...trace[0]!, output: "first test passed\nsecond test passed" }] }]} />);
    expect(screen.getByRole("button", { name: "Run tests" })).toHaveAttribute("aria-expanded", "false");
  });
  it("reveals the command and its real output only when the row is clicked", () => {
    render(<AgentActivity done={false} phases={[{ trace: [{ id: "command", type: "terminal", primary: "Run tests", command: "npm test", status: "completed", exitCode: 0, output: "first test passed" }], activity: "working" }]} />);
    fireEvent.click(screen.getByRole("button", { name: /Working/ }));
    const row = screen.getByRole("button", { name: "Run tests" });
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("npm test").length).toBeGreaterThan(0);
    expect(screen.getByText("first test passed")).toBeInTheDocument();
  });
  it("keeps the command timeline collapsed while working and expands on demand", () => {
    render(<AgentActivity done={false} phases={[{ trace: [{ id: "run", type: "terminal", primary: "Run tests", command: "npm test", status: "running" }], message: "Running tests." }]} />);
    const header = screen.getByRole("button", { name: /Working/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
  });
  it("keeps saying Working while the model composes the next step of a task it is running", () => {
    const trace = [{ id: "fill", type: "tool", primary: "Typing into the page", secondary: "#time", status: "completed" as const }];
    render(<AgentActivity done={false} phases={[{ trace, activity: "thinking" }]} />);
    expect(screen.getByText("Working…")).toBeInTheDocument();
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    expect(screen.getByText("Typing into the page")).toBeInTheDocument();
  });
  it("names the step in progress while the timeline stays collapsed", () => {
    render(<AgentActivity done={false} phases={[{ trace: [{ id: "open", type: "tool", primary: "Opening the page", secondary: "http://localhost:5173", status: "running" as const }], activity: "working" }]} />);
    expect(screen.getByText("Opening the page")).toBeInTheDocument();
    expect(screen.getByText("http://localhost:5173")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Working/ })).toHaveAttribute("aria-expanded", "false");
  });
  it("shows thinking before inference produces a phase", () => {
    render(<AgentActivity done={false} phases={[]} />);
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });
  it("shows live tools and public updates before the run finishes", () => {
    const { rerender } = render(<AgentActivity done={false} phases={[{ trace: [{ id: "read", type: "tool", primary: "Read file", secondary: "app.ts", status: "running" }], message: "Checking the entry point." }]} />);
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(screen.getByText("Checking the entry point.")).toBeInTheDocument();
    rerender(<AgentActivity done={false} phases={[
      { trace: [{ id: "read", type: "tool", primary: "Read file", secondary: "app.ts", status: "completed" }], message: "Read the entry point.", startedAt: 1000, endedAt: 3000 },
      { trace: [{ id: "test", type: "terminal", primary: "Run tests", command: "npm test", status: "running" }] },
    ]} />);
    expect(screen.getByText("Read the entry point.")).toBeInTheDocument();
    // The collapsed timeline keeps its rows out of the DOM until it is opened, so the live
    // step line is what the user sees while work runs; expand to reach the row itself.
    fireEvent.click(screen.getByRole("button", { name: /Working/ }));
    expect(screen.getByRole("button", { name: "Run tests" })).toBeInTheDocument();
    expect(screen.getByText("Working…")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Working/ })).toHaveLength(1);
  });
  it("uses the supplied elapsed header and expandable terminal output", () => {
    render(<AgentActivity done startedAt={1000} endedAt={16000} phases={[{ trace: [{ type: "terminal", primary: "Run command", command: "npm run build", status: "failed", exitCode: 1, output: "Missing build script" }], message: "The build needs a script." }]} />);
    const header = screen.getByRole("button", { name: /Worked for 15 seconds/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(header);
    fireEvent.click(screen.getByRole("button", { name: /Run command/ }));
    expect(screen.getByText("exit 1")).toBeInTheDocument();
    expect(screen.getByText("Missing build script")).toBeInTheDocument();
    expect(screen.getByText("The build needs a script.")).toBeInTheDocument();
  });
  it("shows greeting replies as thinking rather than work", () => {
    render(<AgentActivity done startedAt={1000} endedAt={16000} phases={[{ trace: [], message: "Hello there." }]} />);
    expect(screen.getByText("Hello there.")).toBeInTheDocument();
    expect(screen.getByText("Thought for")).toHaveTextContent("Thought for 15 seconds");
    expect(screen.queryByRole("button", { name: /Thought for/ })).not.toBeInTheDocument();
  });
  it("alternates Thinking and Working while live, then reports Worked for", () => {
    const trace = [{ id: "read", type: "tool", primary: "Read file", secondary: "app.ts", status: "completed" as const }];
    const { rerender } = render(<AgentActivity done={false} phases={[{ trace: [], activity: "thinking", startedAt: 1000 }]} />);
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    rerender(<AgentActivity done={false} phases={[{ trace, activity: "working", startedAt: 1000 }]} />);
    expect(screen.getByText("Working…")).toBeInTheDocument();
    rerender(<AgentActivity done phases={[{ trace, activity: "thinking", message: "Read it.", startedAt: 1000, endedAt: 5000 }]} />);
    expect(screen.getByRole("button", { name: /Worked for 4 seconds/ })).toBeInTheDocument();
  });
  it("renders compression dividers", () => {
    render(<AgentActivity done={false} phases={[{ trace: [], divider: { state: "compressing" }, startedAt: 1000 }]} />);
    expect(screen.getByText("Compressing…")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Compressing context" })).toBeInTheDocument();
  });
  it("does not expose internal reasoning or invent execution steps", () => {
    render(<AgentActivity done phases={[{ trace: [{ type: "reasoning", sentences: ["Internal deliberation"] }, { type: "step", primary: "Invented step" }], message: "Done." }]} />);
    expect(screen.queryByText("Internal deliberation")).not.toBeInTheDocument();
    expect(screen.queryByText("Invented step")).not.toBeInTheDocument();
  });
  it("reveals the thought sentences only when its row is opened", () => {
    render(<AgentActivity done startedAt={1000} phases={[{ trace: [{ type: "reasoning", sentences: ["Reading the setup first"], durationSeconds: 3.2, status: "completed" }], message: "Done." }]} />);
    fireEvent.click(screen.getByRole("button", { name: /Thought for 1 second/ }));
    const thought = screen.getByRole("button", { name: /Thought for 3.2s/ });
    expect(thought).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Reading the setup first")).not.toBeInTheDocument();
    fireEvent.click(thought);
    expect(thought).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Reading the setup first")).toBeInTheDocument();
  });
  it("leaves a thought with nothing recorded as plain prose", () => {
    render(<AgentActivity done startedAt={1000} phases={[{ trace: [{ type: "reasoning", sentences: ["   "], durationSeconds: 3.2, status: "completed" }], message: "Done." }]} />);
    expect(screen.getByText("Thought for")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Thought for/ })).not.toBeInTheDocument();
  });
  it("surfaces inference failures", () => {
    render(<AgentActivity done phases={[]} status="blocked" error="HTTP 503" />);
    expect(screen.getByText(/HTTP 503/)).toBeInTheDocument();
  });
  it("hides the reply actions until the turn is finished", () => {
    render(<AgentActivity done={false} phases={[{ trace: [], message: "Still working." }]} />);
    expect(screen.queryByRole("button", { name: /Copy reply|Good reply|Bad reply/ })).not.toBeInTheDocument();
  });
  it("copies the reply and keeps only the newest rating", () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const rate = vi.fn();
    const phases = [{ trace: [], message: "I moved the sidebar.", startedAt: 1000, endedAt: 2000 }];
    const { rerender } = render(<AgentActivity done phases={phases} onRate={rate} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy reply" }));
    expect(writeText).toHaveBeenCalledWith("I moved the sidebar.");
    fireEvent.click(screen.getByRole("button", { name: "Bad reply" }));
    expect(rate).toHaveBeenLastCalledWith("down");
    rerender(<AgentActivity done rating="down" phases={phases} onRate={rate} />);
    expect(screen.getByRole("button", { name: "Bad reply" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Good reply" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Bad reply" }));
    expect(rate).toHaveBeenLastCalledWith(null);
  });
  it("shows the rating already given without hovering", () => {
    render(<AgentActivity done rating="up" phases={[{ trace: [], message: "Done.", startedAt: 1000, endedAt: 2000 }]} />);
    const actions = screen.getByRole("button", { name: "Good reply" }).parentElement!;
    expect(actions).toHaveClass("opacity-100");
    expect(screen.getByRole("button", { name: "Good reply" })).toHaveAttribute("aria-pressed", "true");
  });
  it("reports a finished subagent from the job's own stamps", () => {
    render(<AgentActivity done phases={[]} subagents={[{ id: "w1", role: "builder", task: "Wire the settings route", status: "finished", startedAt: 1_000, endedAt: 41_000, updates: ["edited src/routes/settings.tsx"], result: "Route added and type-checked." }]} />);
    const row = screen.getByRole("button", { name: "Subagent builder: Wire the settings route" });
    expect(row).toHaveTextContent("Subagent finished in 40 seconds");
    // The row's identity is the generated avatar seeded from the role, not an icon font.
    expect(row.querySelector("canvas")).not.toBeNull();
    // Nothing is revealed until the row is opened, and what opens is the job's own log line.
    expect(screen.queryByText("edited src/routes/settings.tsx")).not.toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.getByText("edited src/routes/settings.tsx")).toBeInTheDocument();
    // The worker's own closing sentence, not a paraphrase of it.
    expect(screen.getByText("Route added and type-checked.")).toBeInTheDocument();
  });
  it("names the engine the session routed this worker onto", () => {
    render(<AgentActivity done phases={[]} subagents={[{ id: "w1", role: "builder", task: "Reword the header", status: "finished", startedAt: 1_000, endedAt: 21_000, engine: { profile: "thorough", model: "gemini-3.8-flash" } }]} />);
    const row = screen.getByRole("button", { name: "Subagent builder on thorough · gemini-3.8-flash: Reword the header" });
    expect(row).toHaveTextContent("thorough · gemini-3.8-flash");
  });
  it("shows no engine for a worker whose session reported none", () => {
    render(<AgentActivity done phases={[]} subagents={[{ id: "w1", role: "builder", task: "Reword the footer", status: "finished", startedAt: 1_000, endedAt: 21_000 }]} />);
    const row = screen.getByRole("button", { name: "Subagent builder: Reword the footer" });
    expect(row).not.toHaveTextContent(/quick|balanced|thorough/);
  });
  it("says a worker hit its step limit rather than calling it blocked", () => {
    render(<AgentActivity done phases={[]} subagents={[{ id: "w1", role: "builder", task: "Migrate the routes", status: "limit", startedAt: 1_000, endedAt: 61_000 }]} />);
    const row = screen.getByRole("button", { name: "Subagent builder: Migrate the routes" });
    expect(row).toHaveTextContent("Subagent stopped at its step limit after 1 minute");
    expect(row).not.toHaveTextContent(/blocked/);
  });
  it("ticks a running subagent and never claims it finished", () => {
    render(<AgentActivity done={false} phases={[{ trace: [], startedAt: Date.now() }]} subagents={[{ id: "w1", role: "researcher", task: "Audit the tool list", status: "running", startedAt: Date.now() - 15_000 }]} />);
    const row = screen.getByRole("button", { name: "Subagent researcher: Audit the tool list" });
    expect(row).toHaveTextContent(/Subagent running for 1[45] seconds/);
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Subagent finished/)).not.toBeInTheDocument();
  });
  it("marks a job that has not started as queued rather than running", () => {
    render(<AgentActivity done={false} phases={[]} subagents={[{ id: "w1", role: "verifier", task: "Run the tests", status: "queued" }]} />);
    expect(screen.getByRole("button", { name: "Subagent verifier: Run the tests" })).toHaveTextContent("Queued");
  });
  it("offers to bring back or discard an isolated worker's checkout", async () => {
    const onResolve = vi.fn(async () => undefined);
    render(<AgentActivity done phases={[]} onResolve={onResolve} subagents={[{ id: "w1", role: "builder", task: "Rewrite the sidebar", status: "finished", startedAt: 1_000, endedAt: 21_000, worktree: { branch: "calvras/w1abc234", path: "/tmp/w1abc234", files: 3 } }]} />);
    const row = screen.getByRole("button", { name: "Subagent builder: Rewrite the sidebar" });
    // Nothing about the isolated checkout is shown until the row is opened.
    expect(screen.queryByText(/calvras\/w1abc234/)).not.toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.getByText(/Own checkout on/)).toHaveTextContent("calvras/w1abc234 · 3 files changed");
    fireEvent.click(screen.getByRole("button", { name: "Bring it back" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("w1", "apply"));
    expect(screen.getByText("Changes brought back")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument();
  });
  it("reports why an isolated worker had to share the folder instead of hiding it", () => {
    render(<AgentActivity done phases={[]} subagents={[{ id: "w1", role: "builder", task: "Rewrite the sidebar", status: "finished", startedAt: 1_000, endedAt: 21_000, worktree: { error: "This folder is not a git repository, so a worker cannot be isolated in a branch of it." } }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Subagent builder: Rewrite the sidebar" }));
    expect(screen.getByText(/not a git repository/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bring it back" })).not.toBeInTheDocument();
  });
  it("gives a shared-folder worker no checkout to resolve", () => {
    render(<AgentActivity done phases={[]} onResolve={() => Promise.resolve()} subagents={[{ id: "w1", role: "builder", task: "Rewrite the sidebar", status: "finished", startedAt: 1_000, endedAt: 21_000, updates: ["edited src/a.tsx"] }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Subagent builder: Rewrite the sidebar" }));
    expect(screen.getByText("edited src/a.tsx")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bring it back" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument();
  });
  it("renders no subagent row when the pool ran none", () => {
    const { container } = render(<AgentActivity done phases={[{ trace: [], message: "Done.", startedAt: 1000, endedAt: 2000 }]} />);
    expect(container.textContent).toContain("Done.");
    expect(screen.queryByRole("button", { name: /^Subagent / })).not.toBeInTheDocument();
  });
  it("never names the models behind a reply", () => {
    // The user asked for the provenance line gone: a finished reply shows its actions, not a model list.
    const phases = [{ trace: [], message: "Done.", startedAt: 1000, endedAt: 2000 }];
    const { rerender } = render(<AgentActivity done phases={phases} />);
    expect(screen.queryByText(/Answered by/)).not.toBeInTheDocument();
    rerender(<AgentActivity done={false} phases={phases} />);
    expect(screen.queryByText(/Answered by/)).not.toBeInTheDocument();
  });
});
