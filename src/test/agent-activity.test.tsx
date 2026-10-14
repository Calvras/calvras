import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentActivity } from "../components/AgentActivity";

describe("agent activity", () => {
  it("shows feedback and actual tools without legacy thought or completion badges", () => {
    render(<AgentActivity done phases={[
      { trace: [{ type: "reasoning", sentences: ["The user wants a folder inspection."] }, { type: "step", primary: "Completed" }], message: "I'll inspect the folder." },
      { trace: [{ type: "terminal", primary: "Run command", command: "npm run build", status: "failed", exitCode: 1, output: "Missing build script" }] },
      { trace: [], message: "The build needs a script before I can continue." },
    ]} />);
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    expect(screen.queryByText("The user wants a folder inspection.")).not.toBeInTheDocument();
    expect(screen.getByText("Command failed")).toBeInTheDocument();
    expect(screen.getByText("The build needs a script before I can continue.")).toBeInTheDocument();
  });
});
