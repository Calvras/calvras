import { fireEvent, render, screen } from "@testing-library/react";
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
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByText("Command failed")).toBeInTheDocument();
    expect(screen.getByText("The build needs a script before I can continue.")).toBeInTheDocument();
  });
  it("shows only the reply and its actions when no tools ran", () => {
    render(<AgentActivity done startedAt={1000} endedAt={16000} phases={[{ trace: [], message: "Hello there." }]} />);
    expect(screen.queryByText(/Worked/)).not.toBeInTheDocument();
    expect(screen.getByText("Hello there.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy to clipboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Good response" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bad response" })).toBeInTheDocument();
  });
  it("keeps finished work collapsed until the elapsed-time header is clicked", () => {
    render(<AgentActivity done startedAt={1000} endedAt={16000} phases={[{ trace: [{ type: "tool", primary: "Read file", secondary: "app.ts", status: "completed" }], message: "Read the file." }]} />);
    const header = screen.getByRole("button", { name: /Worked for 15s/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("app.ts")).not.toBeInTheDocument();
    fireEvent.click(header);
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(screen.getByText("Read the file.")).toBeInTheDocument();
  });
});
