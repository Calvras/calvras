// jsdom has no canvas backend (see src/test/setup.ts), so these tests cover the element contract
// the chat relies on: one labelled image per agent, sized as asked, silent when decorative.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AgentAvatar from "../components/ui/agent-avatar";

describe("agent avatar", () => {
  it("renders one labelled image at the requested size", () => {
    render(<AgentAvatar seed="researcher" size={18} />);
    const canvas = screen.getByRole("img", { name: "Avatar for researcher" });
    expect(canvas.tagName).toBe("CANVAS");
    expect(canvas).toHaveStyle({ height: "18px", width: "18px" });
  });
  it("is decorative inside a row that already names the agent", () => {
    render(<AgentAvatar seed="builder" size={18} aria-hidden="true" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
