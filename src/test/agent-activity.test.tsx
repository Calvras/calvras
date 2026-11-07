import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentActivity, MIN_ROWS_PER_ROUND, roundIsFull } from "../components/AgentActivity";

/** A reply paragraph reveals word by word only while it is being written, so its sentence lives
 *  either in one span per word (animated, with the full line as the container's accessible label)
 *  or as one static paragraph. Both shapes are what these queries look for. */
const byReplyLabel = (text: string) => (_content: string, element: Element | null) =>
  element?.getAttribute?.("aria-label") === text
  || (element?.tagName === "P" && !element.hasAttribute("aria-label") && element.textContent?.trim() === text);
const replyParagraph = (text: string) => screen.getByText(byReplyLabel(text));
const queryReplyParagraph = (text: string) => screen.queryByText(byReplyLabel(text));
const replyParagraphs = (text: string) => screen.queryAllByText(byReplyLabel(text));

/** A finished turn folds its whole log behind one line and shows only the closing summary, so a
 *  test that wants to look at the rounds has to open that line first. */
const openHistory = () => {
  const fold = screen.getByRole("button", { name: /^Worked for / });
  expect(fold).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(fold);
  return fold;
};

/** The reply style is a collapsible group whose header says what its rows add up to, a rail of one
 *  chip per tool call, and the agent's own sentence under the round that wrote it. A collapsed fold
 *  keeps its rows in the document (the fold is a grid-row animation), so these tests read the
 *  disclosure state rather than the presence of text. */
describe("group header derived from the rows", () => {
  const readRow = { id: "read", type: "tool", toolName: "read_file", primary: "Read file", args: { path: "src/app.tsx" }, status: "completed" as const };
  it("prints the summary the rows add up to", () => {
    render(<AgentActivity done phases={[{ trace: [readRow, { ...readRow, id: "read2", args: { path: "src/main.tsx" } }] }]} />);
    openHistory();
    expect(screen.getByRole("button", { name: "read 2 files" })).toHaveAttribute("aria-expanded", "false");
  });
  it("counts a command that failed in the same line", () => {
    render(<AgentActivity done phases={[{ trace: [{ id: "cmd", type: "terminal", primary: "Run build", command: "npm run build", status: "failed", exitCode: 1, output: "Missing build script" }] }]} />);
    openHistory();
    expect(screen.getByRole("button", { name: "ran 1 command · 1 failed" })).toBeInTheDocument();
  });
  it("says what the round is doing while it is still in flight", () => {
    // A row the registry knows nothing about adds no count to the summary, so the header names the
    // state instead of going blank mid-action.
    render(<AgentActivity done={false} phases={[{ trace: [{ id: "fill", type: "tool", primary: "Typing into the page", secondary: "#time", status: "running" as const }] }]} />);
    expect(screen.getByRole("button", { name: "Working…" })).toHaveAttribute("aria-expanded", "true");
  });
  it("shows thinking before the model has produced a row", () => {
    render(<AgentActivity done={false} phases={[]} />);
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });
  it("says thinking once when the round that is thinking has no rows yet", () => {
    // The app opens a turn by creating the phase before the model has written anything, and that
    // empty live round is itself the header: the placeholder used to stand next to it.
    render(<AgentActivity done={false} phases={[{ trace: [] }]} />);
    expect(screen.getAllByText("Thinking…")).toHaveLength(1);
  });
  it("folds a settled round and opens it on demand", () => {
    render(<AgentActivity done phases={[{ trace: [readRow], message: "The grid fills the window now." }]} />);
    openHistory();
    const header = screen.getByRole("button", { name: "read 1 file" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
  });
  it("keeps the round open while it works and folds it when the turn ends", () => {
    const phases = [{ trace: [readRow], startedAt: 1000 }];
    const { rerender } = render(<AgentActivity done={false} phases={phases} />);
    expect(screen.getByRole("button", { name: "read 1 file" })).toHaveAttribute("aria-expanded", "true");
    rerender(<AgentActivity done phases={[{ ...phases[0]!, message: "Read it.", endedAt: 5000 }]} />);
    openHistory();
    expect(screen.getByRole("button", { name: "read 1 file" })).toHaveAttribute("aria-expanded", "false");
  });
  it("folds a thought to its own duration and reveals the sentences on click", () => {
    render(<AgentActivity done phases={[{ trace: [{ id: "t", type: "reasoning", sentences: ["Reading the setup first"], durationSeconds: 3.2, status: "completed" as const }], message: "Done." }]} />);
    const thought = screen.getByRole("button", { name: /Thought process 3.2s/ });
    expect(thought).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(thought);
    expect(thought).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Reading the setup first")).toBeInTheDocument();
  });
});

describe("the agent's own words", () => {
  it("renders the round's sentence as markdown", () => {
    render(<AgentActivity done phases={[{ trace: [], message: "Start with:\n- Python\n- Go" }]} />);
    expect(screen.getByText("Start with:")).toBeInTheDocument();
    expect(screen.getByText("Python")).toBeInTheDocument();
    expect(screen.getByText("Go")).toBeInTheDocument();
  });
  it("keeps one copy when the agent restates its own ask", () => {
    // The reply the user saw: a clarification landed once as a fragment and again inside a longer
    // paragraph, so the same ask appeared twice.
    const fragment = "For example: do you want to schedule multiple subjects, or integrate with a calendar?";
    const fuller = `I see you have a basic scheduler already. Could you tell me what you need? ${fragment}`;
    render(<AgentActivity done phases={[{ trace: [], message: fragment }, { trace: [], message: fuller }]} />);
    expect(replyParagraph(fuller)).toBeInTheDocument();
    expect(queryReplyParagraph(fragment)).not.toBeInTheDocument();
  });
  it("keeps the newest copy when a round repeats the closing summary", () => {
    render(<AgentActivity done phases={[{ trace: [], message: "Both steps are in." }, { trace: [], message: "Both steps are in." }]} />);
    expect(replyParagraphs("Both steps are in.")).toHaveLength(1);
  });
  it("shows a greeting as prose with no work header at all", () => {
    const { container } = render(<AgentActivity done phases={[{ trace: [], message: "Hello there." }]} />);
    const paragraph = replyParagraph("Hello there.");
    expect(paragraph).toBeInTheDocument();
    expect(container.querySelectorAll("[aria-expanded]").length).toBe(0);
  });
  it("reveals a closing sentence word by word while the reply is still arriving", () => {
    render(<AgentActivity done={false} phases={[{ trace: [], message: "Hello there." }]} />);
    // The sentence is not painted in one go: each word is its own animated segment, and the
    // whole line stays readable through the paragraph's accessible label.
    expect(replyParagraph("Hello there.").querySelectorAll("span[aria-hidden='true']")).toHaveLength(3);
  });
  it("prints a restored reply as it stands, with nothing left to animate", () => {
    // Opening the app re-reads every past turn, and each one replayed its reveal at once, so the
    // conversation arrived as a wall of typing animations. Only the reply being written moves.
    render(<AgentActivity done phases={[{ trace: [], message: "Hello there." }]} />);
    expect(replyParagraph("Hello there.").querySelectorAll("span[aria-hidden='true']")).toHaveLength(0);
  });
  it("puts the round's sentence above the work it announces", () => {
    // The run says what it is about to do, then does it. Rendering the rail first made every
    // paragraph read as a caption to work that had already finished.
    const readRow = { id: "read", type: "tool", toolName: "read_file", primary: "Read file", args: { path: "src/app.tsx" }, status: "completed" as const };
    render(<AgentActivity done={false} phases={[{ trace: [readRow], message: "Reading the setup first." }]} />);
    const paragraph = replyParagraph("Reading the setup first.");
    const rail = screen.getByRole("button", { name: "read 1 file" });
    expect(paragraph.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("filters a step that no tool call produced out of the rail", () => {
    render(<AgentActivity done phases={[{ trace: [{ type: "step", primary: "Invented step" }], message: "Done." }]} />);
    expect(screen.queryByText("Invented step")).not.toBeInTheDocument();
  });
});

describe("agent activity", () => {
  const toolPhase = { trace: [{ id: "read", type: "tool", toolName: "read_file", primary: "Read file", args: { path: "a.ts" }, status: "completed" as const }] };
  it("offers resume beside an interrupted response", () => {
    const resume = vi.fn();
    render(<AgentActivity done phases={[{ ...toolPhase, startedAt: 1000 }]} status="stopped" onResume={resume} />);
    fireEvent.click(screen.getByRole("button", { name: "Pick it back up" }));
    expect(resume).toHaveBeenCalledOnce();
  });
  it("says why the turn stopped instead of one sentence for every case", () => {
    render(<AgentActivity done phases={[{ ...toolPhase, startedAt: 1000, endedAt: 2000 }]} status="stopped" stopReason="replaced" />);
    expect(screen.getByText(/You sent another message/)).toBeInTheDocument();
    render(<AgentActivity done phases={[{ ...toolPhase, startedAt: 1000, endedAt: 2000 }]} status="stopped" stopReason="user" />);
    expect(screen.getByText(/You stopped this one/)).toBeInTheDocument();
    // No reason means nothing in the app asked for the stop, and that is a bug worth naming
    // rather than dressing up as a choice the user made.
    render(<AgentActivity done phases={[{ ...toolPhase, startedAt: 1000, endedAt: 2000 }]} status="stopped" />);
    expect(screen.getByText(/ended on its own with the work unfinished/)).toBeInTheDocument();
    expect(screen.queryByText(/Stopped right here/)).not.toBeInTheDocument();
  });
  it("does not offer to pick back up an answer that never reached a tool", () => {
    // A conversation turn interrupted before any action has no unfinished work. The resume card
    // turned "list 20 languages" into a task brief the app sent itself, and the list printed twice.
    const resume = vi.fn();
    render(<AgentActivity done phases={[{ trace: [{ id: "think", type: "reasoning", sentences: ["Choosing the languages."], status: "completed" as const }], message: "1. Python\n2. Go", startedAt: 1000, endedAt: 2000 }]} status="stopped" onResume={resume} />);
    expect(screen.queryByRole("button", { name: "Pick it back up" })).not.toBeInTheDocument();
    expect(screen.queryByText(/work unfinished/)).not.toBeInTheDocument();
    expect(screen.getByText("Python")).toBeInTheDocument();
  });
  it("names the steps a short run never reached instead of a stock limit notice", () => {
    const resume = vi.fn();
    render(<AgentActivity done phases={[{ ...toolPhase, message: "Read the whole folder, then it stopped.", startedAt: 1000, endedAt: 2000 }]} status="blocked" unfinished={["Wire the settings route", "Run the build"]} onResume={resume} />);
    expect(screen.getByText("Wire the settings route")).toBeInTheDocument();
    expect(screen.getByText("Run the build")).toBeInTheDocument();
    expect(screen.queryByText(/Action limit reached|task is not complete/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pick it back up" }));
    expect(resume).toHaveBeenCalledOnce();
  });
  it("shows the carry-on pill for a run that hit its action ceiling", () => {
    render(<AgentActivity done phases={[{ trace: [{ id: "cmd", type: "terminal", primary: "Run tests", command: "npm test", status: "running" as const }], message: "Still going.", startedAt: 1000, endedAt: 2000 }]} status="limit" />);
    expect(screen.getByText(/hit its action ceiling/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pick it back up" })).not.toBeInTheDocument();
  });
  it("offers nothing when the turn finished", () => {
    render(<AgentActivity done phases={[{ trace: [], message: "Done.", startedAt: 1000, endedAt: 2000 }]} status="finished" />);
    expect(screen.queryByRole("button", { name: "Pick it back up" })).not.toBeInTheDocument();
  });
  it("does not render an empty assistant response below a steering message", () => {
    const { container } = render(<AgentActivity done phases={[]} status="finished" />);
    expect(container).toBeEmptyDOMElement();
  });
  it("keeps one header per round while the next round works", () => {
    const closed = { trace: [{ id: "w", type: "write", toolName: "write_file", primary: "Write file", args: { path: "src/App.tsx" }, status: "completed" as const }], message: "Step 1 done — the week grid renders from real dates.", startedAt: 1000, endedAt: 9000 };
    const running = { trace: [{ id: "f", type: "write", toolName: "write_file", primary: "Write file", args: { path: "src/Form.tsx" }, status: "running" as const }], startedAt: 9000 };
    const finished = { trace: [{ ...running.trace[0]!, status: "completed" as const }], startedAt: 9000, endedAt: 12_000 };
    const { rerender } = render(<AgentActivity done={false} phases={[closed, running]} />);
    expect(replyParagraph("Step 1 done — the week grid renders from real dates.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "edited 1 file" })).toHaveLength(2);
    rerender(<AgentActivity done phases={[closed, finished, { trace: [], message: "Both steps are in: the grid is built from real dates and the form persists across a reload.", startedAt: 9000, endedAt: 20_000 }]} />);
    // The turn closed, so only the summary stands; the round sentences are one click away.
    expect(replyParagraph("Both steps are in: the grid is built from real dates and the form persists across a reload.")).toBeInTheDocument();
    expect(queryReplyParagraph("Step 1 done — the week grid renders from real dates.")).not.toBeInTheDocument();
    openHistory();
    expect(replyParagraph("Step 1 done — the week grid renders from real dates.")).toBeInTheDocument();
  });
  it("reveals the command and its real output only when the row is opened", () => {
    render(<AgentActivity done phases={[{ trace: [{ id: "command", type: "terminal", primary: "Run tests", command: "npm test", status: "completed" as const, exitCode: 0, output: "first test passed" }] }, ]} />);
    openHistory();
    fireEvent.click(screen.getByRole("button", { name: "ran 1 command" }));
    const row = screen.getByRole("button", { name: /Run tests/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("first test passed")).toBeInTheDocument();
  });
  it("renders compression dividers", () => {
    render(<AgentActivity done={false} phases={[{ trace: [], divider: { state: "compressing" }, startedAt: 1000 }]} />);
    expect(screen.getByText("Compressing…")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Compressing context" })).toBeInTheDocument();
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
  it("never names the models behind a reply", () => {
    // The user asked for the provenance line gone: a finished reply shows its actions, not a model list.
    const phases = [{ trace: [], message: "Done.", startedAt: 1000, endedAt: 2000 }];
    const { rerender } = render(<AgentActivity done phases={phases} />);
    expect(screen.queryByText(/Answered by/)).not.toBeInTheDocument();
    rerender(<AgentActivity done={false} phases={phases} />);
    expect(screen.queryByText(/Answered by/)).not.toBeInTheDocument();
  });
});

describe("subagent rows", () => {
  it("reports a finished subagent from the job's own stamps", () => {
    render(<AgentActivity done phases={[]} subagents={[{ id: "w1", role: "builder", task: "Wire the settings route", status: "finished", startedAt: 1_000, endedAt: 41_000, updates: ["edited src/routes/settings.tsx"], result: "Route added and type-checked." }]} />);
    const row = screen.getByRole("button", { name: "Subagent builder: Wire the settings route" });
    expect(row).toHaveTextContent("Subagent finished in 40s");
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
    expect(screen.getByRole("button", { name: "Subagent builder on thorough · gemini-3.8-flash: Reword the header" })).toHaveTextContent("thorough · gemini-3.8-flash");
  });
  it("shows no engine for a worker whose session reported none", () => {
    render(<AgentActivity done phases={[]} subagents={[{ id: "w1", role: "builder", task: "Reword the footer", status: "finished", startedAt: 1_000, endedAt: 21_000 }]} />);
    expect(screen.getByRole("button", { name: "Subagent builder: Reword the footer" })).not.toHaveTextContent(/quick|balanced|thorough/);
  });
  it("says a worker hit its step limit rather than calling it blocked", () => {
    render(<AgentActivity done phases={[]} subagents={[{ id: "w1", role: "builder", task: "Migrate the routes", status: "limit", startedAt: 1_000, endedAt: 61_000 }]} />);
    const row = screen.getByRole("button", { name: "Subagent builder: Migrate the routes" });
    expect(row).toHaveTextContent("Subagent stopped at its step limit after 1m 0s");
    expect(row).not.toHaveTextContent(/blocked/);
  });
  it("ticks a running subagent and never claims it finished", () => {
    render(<AgentActivity done={false} phases={[{ trace: [], startedAt: Date.now() }]} subagents={[{ id: "w1", role: "researcher", task: "Audit the tool list", status: "running", startedAt: Date.now() - 15_000 }]} />);
    const row = screen.getByRole("button", { name: "Subagent researcher: Audit the tool list" });
    expect(row).toHaveTextContent(/Subagent running for 1[45]s/);
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
});

/** The route folds a working block when the round hands back its sentence; the fold rule itself is
 *  this count, so a retry loop cannot re-open the test's premise by accident. */
describe("when a round of work is worth its own header", () => {
  const tool = (id: string) => ({ id, type: "tool", primary: "Write file", status: "completed" as const });
  it("folds after a stretch of files and commands", () => {
    expect(roundIsFull(["a", "b", "c", "d", "e"].map(tool))).toBe(true);
  });
  it("keeps working under the same header for a few commands", () => {
    expect(roundIsFull([tool("a"), tool("b"), tool("c"), tool("d")])).toBe(false);
    // A failed command is still a row of work; the fold is about how much the block holds.
    expect(roundIsFull([tool("a"), tool("b"), tool("c"), tool("d"), { ...tool("e"), status: "failed" as const }])).toBe(true);
  });
  it("does not count thinking or a plan tick as work", () => {
    expect(roundIsFull([{ id: "t", type: "reasoning", status: "completed" as const, sentences: ["Thinking"] }, { id: "s", type: "step", primary: "Plan step", status: "completed" as const }])).toBe(false);
  });
  it("pins the threshold the timeline is judged against", () => {
    expect(MIN_ROWS_PER_ROUND).toBe(5);
    expect(roundIsFull(Array.from({ length: MIN_ROWS_PER_ROUND - 1 }, (_, i) => tool(String(i))))).toBe(false);
  });
});
/** What the user asked for on the 17-minute run: the turn ended with a wall of one sentence per
 *  round still standing. A closed turn is a summary; the steps are behind the chevron. */
describe("a finished turn folds its log to one summary", () => {
  const write = (id: string, path: string) => ({ id, type: "write", toolName: "write_file", primary: "Write file", args: { path }, status: "completed" as const });
  it("leaves only the closing summary on screen", () => {
    render(<AgentActivity done phases={[
      { trace: [write("w1", "src/a.tsx")], message: "I'm updating the CSS to use the v4 import.", startedAt: 1000, endedAt: 9000 },
      { trace: [write("w2", "src/b.tsx")], message: "I'm clearing the legacy PostCSS config.", startedAt: 9000, endedAt: 15_000 },
      { trace: [], message: "The build fails on the same PostCSS error, so the page is not fixed.", startedAt: 15_000, endedAt: 20_000 },
    ]} />);
    expect(replyParagraph("The build fails on the same PostCSS error, so the page is not fixed.")).toBeInTheDocument();
    expect(queryReplyParagraph("I'm updating the CSS to use the v4 import.")).not.toBeInTheDocument();
    expect(queryReplyParagraph("I'm clearing the legacy PostCSS config.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Worked for / })).toBeInTheDocument();
    openHistory();
    expect(replyParagraph("I'm updating the CSS to use the v4 import.")).toBeInTheDocument();
    expect(replyParagraph("I'm clearing the legacy PostCSS config.")).toBeInTheDocument();
  });
  it("keeps every round standing while the run is still working", () => {
    render(<AgentActivity done={false} phases={[
      { trace: [write("w1", "src/a.tsx")], message: "I'm updating the CSS to use the v4 import.", startedAt: 1000 },
      { trace: [write("w2", "src/b.tsx")], startedAt: 9000 },
    ]} />);
    expect(replyParagraph("I'm updating the CSS to use the v4 import.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Worked for / })).not.toBeInTheDocument();
  });
  it("does not fold an answer that never touched the workspace", () => {
    render(<AgentActivity done phases={[{ trace: [], message: "Python, Go and Rust are the three to start with.", startedAt: 1000, endedAt: 4000 }]} />);
    expect(replyParagraph("Python, Go and Rust are the three to start with.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Worked for / })).not.toBeInTheDocument();
  });
});
