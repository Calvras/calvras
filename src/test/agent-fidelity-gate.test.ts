import { describe, expect, it, vi } from "vitest";
import { runAgent, type AgentAction, type ToolFeedback } from "../lib/agent-run";
import { summarizeFidelity } from "../lib/image-fidelity";

const reply = (message: string, actions: unknown[] = [], status = "complete") => JSON.stringify({ message, actions, status });
/** `similarity` is written as a percentage here; the page reports it as a 0-1 fraction. */
const measured = (similarity: number, hotspots: { region: string; diff: number }[] = [], shapeMismatch = false) => {
  const close = similarity >= 90;
  const fidelity = summarizeFidelity({
    similarity: similarity / 100,
    changedShare: close ? 0.02 : 0.45,
    paletteDiff: close ? 0.002 : 0.05,
    structureShare: close ? 0.01 : 0.35,
    referenceWidth: 1440, referenceHeight: 900,
    currentWidth: shapeMismatch ? 700 : 1440, currentHeight: shapeMismatch ? 900 : 900,
    hotspots,
  });
  return { ok: true, url: "http://localhost:5173", ...fidelity, fidelity };
};

/** Each compare_to_reference call pops the next scripted measurement (the last one repeats). */
function build(responses: string[], comparisons: Record<string, unknown>[], hasReferenceImage = true) {
  let compareIndex = 0;
  const execute = vi.fn(async (actions: AgentAction[]): Promise<ToolFeedback[]> => actions.map((action) => {
    const result: Record<string, unknown> = action.type === "compare_to_reference"
      ? comparisons[Math.min(compareIndex++, comparisons.length - 1)]!
      : { ok: true };
    return { action, ok: result["ok"] !== false, result };
  }));
  const infer = vi.fn(async (_prompt: string): Promise<string> => responses.shift() ?? reply("Done."));
  return { prompt: "Rebuild this screen from the screenshot", signal: new AbortController().signal, infer, execute, onFeedback: vi.fn(), onPhaseComplete: vi.fn(), maxSteps: 14, hasReferenceImage };
}

const buildSteps = [
  reply("Open it.", [{ type: "open_browser", url: "http://localhost:5173" }], "continue"),
  reply("Build it.", [{ type: "write_file", path: "src/ui.tsx", content: "x" }], "continue"),
];
const typecheck = { type: "run_typecheck" } as const;
const prompts = (config: ReturnType<typeof build>) => config.infer.mock.calls.map((call) => String(call[0]));

describe("screenshot fidelity gate", () => {
  it("measures the page instead of trusting a claimed match, then finishes once it passes", async () => {
    const config = build(
      [...buildSteps,
        reply("Done, it matches."),
        reply("Adjusting.", [typecheck], "continue"),
        reply("Matches now."),
        reply("Rebuilt to match.")],
      [measured(72, [{ region: "centre", diff: 28 }]), measured(97)],
    );
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("finished");
    expect(config.execute).toHaveBeenCalledWith([{ type: "compare_to_reference" }]);
    expect(prompts(config).some((prompt) => prompt.includes("does NOT match the user's screenshot"))).toBe(true);
    expect(prompts(config).at(-1)).toContain("matches the user's screenshot");
  });

  it("releases the pixel gate after repeated mismatches and makes the run say what differs", async () => {
    const config = build(
      [...buildSteps, reply("Done."), reply("Still done."), reply("Really done."), reply("Finished.")],
      [measured(61, [{ region: "top-left", diff: 40 }])],
    );
    const outcome = await runAgent(config);
    // Three fresh measurements is the budget. The disagreement then becomes something the
    // reply has to disclose, not a reason to stop the run — and never a canned error.
    expect(prompts(config).some((prompt) => prompt.includes("SCREENSHOT NOT VERIFIABLE"))).toBe(true);
    expect(prompts(config).at(-1)).toContain("61% similar");
    expect(outcome.error).toBeUndefined();
    expect(outcome.status).toBe("finished");
  });

  it("leaves the run alone when no screenshot was sent", async () => {
    const config = build([...buildSteps, reply("Type-checked.", [typecheck], "continue"), reply("Done.")], [], false);
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("finished");
    expect(config.execute.mock.calls.some((call) => (call[0] as AgentAction[]).some((action) => action.type === "compare_to_reference"))).toBe(false);
  });

  it("stays out of the way when the page cannot be measured at all", async () => {
    const config = build(
      [...buildSteps, reply("Done."), reply("Type-checked.", [typecheck], "continue"), reply("Done now.")],
      [{ ok: false, error: "No server preview is open yet." }],
    );
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("finished");
    expect(prompts(config).some((prompt) => prompt.includes("[NO PIXEL COMPARISON]"))).toBe(true);
  });

  it("releases the run when the only finding is that the panel has another shape", async () => {
    const config = build(
      [...buildSteps, reply("Done, colours match."), reply("Rebuilt; the panel could not be aligned to the screenshot shape.")],
      [measured(97, [], true)],
    );
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("finished");
    expect(prompts(config).some((prompt) => prompt.includes("different shape"))).toBe(true);
    expect(prompts(config).some((prompt) => prompt.includes("does NOT match the user's screenshot"))).toBe(false);
  });

  it("re-arms the comparison after an edit that follows a passing check", async () => {
    const config = build(
      [...buildSteps,
        reply("It matches now."),
        reply("Small tweak.", [{ type: "search_replace", path: "src/ui.tsx", search: "x", replace: "y" }], "continue"),
        reply("Matches again."),
        reply("Checking.", [typecheck], "continue"),
        reply("Done.")],
      [measured(97), measured(98)],
    );
    const outcome = await runAgent(config);
    expect(outcome.status).toBe("finished");
    const compared = config.execute.mock.calls.filter((call) => (call[0] as AgentAction[]).some((action) => action.type === "compare_to_reference"));
    expect(compared).toHaveLength(2);
  });
});
