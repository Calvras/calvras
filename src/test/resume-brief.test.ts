import { describe, expect, it } from "vitest";
import { resumeBrief } from "@/lib/resume-brief";

const stopped = {
  text: "",
  openSteps: ["Wire the settings route", "Run the build and report the exit code"],
  phases: [
    { trace: [{ id: "read" }], message: "Read the whole folder and wrote the shell." },
    { trace: [{ id: "write" }], message: undefined },
    { trace: [], message: undefined },
  ],
};
const history = [
  { role: "user" as const, text: "build the settings page end to end" },
  { role: "assistant" as const, text: "Working on it." },
];

describe("the resume brief", () => {
  it("continues the same run instead of restarting it", () => {
    const brief = resumeBrief(stopped, history);
    expect(brief).toMatch(/^Continue the task below inside this same run\./);
    expect(brief).toMatch(/do not greet, do not restate the request/);
    expect(brief).toMatch(/2 round\(s\) of real work/);
    // The empty thinking row the abort left behind does not count as work already done.
    expect(brief).not.toMatch(/3 round/);
  });
  it("carries the open steps and asks for them back as a plan", () => {
    const brief = resumeBrief(stopped, history);
    expect(brief).toContain("- Wire the settings route");
    expect(brief).toContain("- Run the build and report the exit code");
    expect(brief).toContain("plan_tasks");
    expect(brief).toContain("track_progress");
  });
  it("quotes the ask that led to the stopped turn", () => {
    expect(resumeBrief(stopped, history)).toMatch(/Original request:\nbuild the settings page end to end/);
  });
  it("reads the project when the run stopped with no plan recorded", () => {
    const brief = resumeBrief({ text: "add dark mode", phases: [{ trace: [], message: undefined }] }, []);
    expect(brief).toMatch(/no steps recorded/);
    expect(brief).toMatch(/Original request:\nadd dark mode/);
  });
});
