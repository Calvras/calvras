import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AccessSelector, ComposerApproval } from "../components/ui/composer-access";
import { PromptInput } from "../components/ui/ai-chat-input";

describe("composer permissions", () => {
  it("selects full access with an original permission menu", () => {
    const onChange = vi.fn(); render(<AccessSelector value="automatic" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace permissions" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Full access/ }));
    expect(onChange).toHaveBeenCalledWith("full");
  });
  it("requires an explicit decision and supports denying the operation", () => {
    const onDecision = vi.fn(); render(<ComposerApproval request={{ id: "a", question: "Can I delete the old build folder?" }} onDecision={onDecision} />);
    expect(onDecision).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Don't allow")); fireEvent.click(screen.getByRole("button", { name: "Confirm choice" }));
    expect(onDecision).toHaveBeenCalledWith("deny");
    expect(screen.queryByText("Approval required")).not.toBeInTheDocument();
    expect(screen.queryByText("View details")).not.toBeInTheDocument();
  });
  it("morphs the same composer into a decision and restores the draft afterwards", () => {
    const onDecision = vi.fn();
    const { rerender } = render(<PromptInput defaultValue="Keep this draft" />);
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("Keep this draft");
    rerender(<PromptInput defaultValue="Keep this draft" approval={{ id: "a", question: "Can I run the tests?" }} onApprovalDecision={onDecision} />);
    expect(screen.queryByRole("textbox", { name: "Prompt" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm choice" })); expect(onDecision).toHaveBeenCalledWith("once");
    rerender(<PromptInput defaultValue="Keep this draft" />);
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("Keep this draft");
    expect(screen.queryByText(/Gemini|GPT|Opus/)).not.toBeInTheDocument();
  });
  it("accepts a necessary answer rather than replacing it with an approval token", () => {
    const onDecision = vi.fn(); render(<ComposerApproval request={{ id: "q", kind: "question", question: "Which deployment environment?", choices: ["Staging", "Production"] }} onDecision={onDecision} />);
    fireEvent.click(screen.getByLabelText("Production")); fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onDecision).toHaveBeenCalledWith("Production");
  });
  it("stacks a message sent mid-task above the composer instead of interrupting", () => {
    const onSendNow = vi.fn(); const onRemove = vi.fn();
    render(<PromptInput isThinking queued={[{ id: "q1", text: "also add a dark mode toggle" }]} onSendQueuedNow={onSendNow} onRemoveQueued={onRemove} />);
    expect(screen.getByRole("list", { name: "Waiting to send" })).toBeInTheDocument();
    expect(screen.getByText("also add a dark mode toggle")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(onSendNow).toHaveBeenCalledWith("q1");
    fireEvent.click(screen.getByRole("button", { name: /Discard queued message/ }));
    expect(onRemove).toHaveBeenCalledWith("q1");
  });
  it("keeps a running chat's folder fixed, with a new chat as the only way out", () => {
    const pick = vi.fn(); const reset = vi.fn(); const clear = vi.fn();
    render(<PromptInput projectName="calvras-app" projectPath="/tmp/calvras-app" folderLocked onFolderFiles={vi.fn()} onPickFolder={pick} onNewChatWithFolder={reset} onClearFolder={clear} />);
    expect(screen.queryByRole("button", { name: "Add a folder" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /calvras-app/ }));
    expect(screen.queryByRole("menuitem", { name: /Choose a new folder/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Work with no folder/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /Start a new chat in another folder/ }));
    expect(reset).toHaveBeenCalledOnce();
    expect(pick).toHaveBeenCalledOnce();
    expect(clear).not.toHaveBeenCalled();
  });
  it("still lets a new chat pick or clear its folder", () => {
    render(<PromptInput projectName="calvras-app" projectPath="/tmp/calvras-app" onFolderFiles={vi.fn()} onClearFolder={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /calvras-app/ }));
    expect(screen.getByRole("menuitem", { name: /Choose a new folder/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Work with no folder/ })).toBeInTheDocument();
  });
  it("adds a folder to a chat that never got one only by starting a new chat", () => {
    const pick = vi.fn(); const reset = vi.fn();
    render(<PromptInput folderLocked onFolderFiles={vi.fn()} onPickFolder={pick} onNewChatWithFolder={reset} />);
    expect(screen.queryByRole("button", { name: "Add a folder" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add a folder in a new chat" }));
    expect(reset).toHaveBeenCalledOnce();
    expect(pick).toHaveBeenCalledOnce();
  });
  it("passes an empty folder on so the app can say why nothing happened", () => {
    const onFolderFiles = vi.fn();
    const { container } = render(<PromptInput onFolderFiles={onFolderFiles} />);
    fireEvent.change(container.querySelector("input[webkitdirectory]")!, { target: { files: [] } });
    expect(onFolderFiles).toHaveBeenCalledWith([]);
  });
  it("shows a pasted address in the input as an underlined link with an icon", () => {
    const { container } = render(<PromptInput defaultValue="read https://calvras.com/terms first" />);
    fireEvent.click(screen.getByRole("button", { name: "Open prompt input" }));
    const anchor = screen.getByRole("link", { name: /calvras\.com\/terms/ });
    expect(anchor).toHaveAttribute("href", "https://calvras.com/terms");
    expect(anchor).toHaveAttribute("target", "_blank");
    expect(container.querySelector("a svg")).toBeInTheDocument();
    expect(screen.getByText("https://calvras.com/terms").className).toMatch(/underline/);
  });
});
