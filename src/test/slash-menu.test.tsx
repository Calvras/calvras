import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PromptInput } from "../components/ui/ai-chat-input";

// Directive commands attach a removable chip and keep the textarea empty; the hidden
// directive is only sent on submit, never shown as a sentence.
const CHIP_COMMANDS: [string, string][] = [
  ["Goal", "goal"],
  ["Plan", "plan"],
  ["Review", "review"],
  ["Continue", "continue"],
];

const ACTION_COMMANDS: [string, string][] = [
  ["Start fresh", "new-chat"],
  ["Show what's happening", "tasks"],
  ["Open side chat", "sidechat"],
  ["Open the terminal", "terminal"],
  ["Open the browser panel", "browser"],
];

function setup(props: Partial<React.ComponentProps<typeof PromptInput>> = {}) {
  const onSlashAction = vi.fn();
  const view = render(<PromptInput onSlashAction={onSlashAction} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Open prompt input" }));
  const textarea = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
  return { ...view, onSlashAction, textarea };
}

async function openSlash(textarea: HTMLTextAreaElement, query = "/") {
  fireEvent.change(textarea, { target: { value: query } });
  return screen.findByRole("listbox", { name: "Slash commands" });
}

describe("composer slash menu", () => {
  it("lists every command above the input", async () => {
    const { textarea } = setup();
    await openSlash(textarea);
    expect(screen.getByText("What do you want to do?")).toBeInTheDocument();
    for (const [label] of [...CHIP_COMMANDS, ...ACTION_COMMANDS]) {
      expect(screen.getByRole("option", { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("option")).toHaveLength(9);
    expect(screen.queryByRole("option", { name: /plugins/i })).not.toBeInTheDocument();
    expect(screen.getByText("↑↓ to move · Enter to pick · Esc to close")).toBeInTheDocument();
  });

  it("attaches a removable chip for each directive without filling the textarea", async () => {
    for (const [label, id] of CHIP_COMMANDS) {
      const { textarea, container, onSlashAction } = setup();
      await openSlash(textarea);
      fireEvent.mouseDown(screen.getByRole("option", { name: new RegExp(label) }));
      expect(textarea.value).toBe("");
      expect(container.querySelector(`[data-slash-chip="${id}"]`)).not.toBeNull();
      expect(onSlashAction).not.toHaveBeenCalled();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("removes the chip from its close button", async () => {
    const { textarea, container } = setup();
    await openSlash(textarea);
    fireEvent.mouseDown(screen.getByRole("option", { name: /Goal/ }));
    expect(container.querySelector('[data-slash-chip="goal"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove Goal" }));
    expect(container.querySelector('[data-slash-chip="goal"]')).toBeNull();
  });

  it("runs every host action and clears the composer", async () => {
    for (const [label, id] of ACTION_COMMANDS) {
      const { textarea, onSlashAction } = setup();
      await openSlash(textarea);
      fireEvent.mouseDown(screen.getByRole("option", { name: new RegExp(label) }));
      expect(onSlashAction).toHaveBeenCalledWith(id);
      expect(textarea.value).toBe("");
      cleanup();
    }
  });

  it("filters as the user types", async () => {
    const { textarea } = setup();
    await openSlash(textarea, "/term");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /Open the terminal/ })).toBeInTheDocument();
  });

  it("navigates with the keyboard and picks with Enter", async () => {
    const { textarea, container, onSlashAction } = setup();
    await openSlash(textarea);
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(container.querySelector('[data-slash-chip="plan"]')).not.toBeNull();
    expect(onSlashAction).not.toHaveBeenCalled();
  });

  it("runs a host action chosen with Tab", async () => {
    const { textarea, onSlashAction } = setup();
    await openSlash(textarea, "/browser");
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(onSlashAction).toHaveBeenCalledWith("browser");
  });

  it("closes with Escape without touching the draft", async () => {
    const { textarea, onSlashAction } = setup();
    await openSlash(textarea);
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(textarea.value).toBe("/");
    expect(onSlashAction).not.toHaveBeenCalled();
  });

  it("wraps around to the last command when moving up from the first", async () => {
    const { textarea, onSlashAction } = setup();
    await openSlash(textarea);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSlashAction).toHaveBeenCalledWith("browser");
  });
});

describe("composer folder controls", () => {
  it("shows the active folder as a chip that opens change/clear options", () => {
    render(<PromptInput projectName="my-app" projectPath={"C:\\work\\my-app"} onClearFolder={() => {}} />);
    const chip = screen.getByRole("button", { name: /my-app/ });
    expect(chip).toBeInTheDocument();
    expect(screen.queryByText("ready")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Swap folder" })).not.toBeInTheDocument();
    fireEvent.click(chip);
    expect(screen.getByRole("menuitem", { name: /Choose a new folder/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Work with no folder/ })).toBeInTheDocument();
  });

  it("keeps the folder picker below the input and hands files to the host", () => {
    const onFolderFiles = vi.fn();
    const { container } = render(<PromptInput onFolderFiles={onFolderFiles} />);
    const folderInput = container.querySelector("input[webkitdirectory]") as HTMLInputElement;
    expect(folderInput).not.toBeNull();
    const files = [new File(["hello"], "demo/src/app.ts")];
    fireEvent.change(folderInput, { target: { files } });
    expect(onFolderFiles).toHaveBeenCalledWith(files);
    expect(screen.getByRole("button", { name: /Add a folder/ })).toBeInTheDocument();
  });

  it("reports import state and errors", () => {
    const { rerender } = render(<PromptInput folderBusy folderError="" />);
    expect(screen.getByRole("button", { name: /Add a folder/ })).toBeDisabled();
    expect(screen.getByText("Adding…")).toBeInTheDocument();
    rerender(<PromptInput folderBusy={false} folderError="Folder uploads are limited to 50 MB." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Folder uploads are limited to 50 MB.");
  });

  it("lets the user work with no folder from the chip menu", () => {
    const onClearFolder = vi.fn();
    render(<PromptInput projectName="my-app" onClearFolder={onClearFolder} />);
    fireEvent.click(screen.getByRole("button", { name: /my-app/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Work with no folder/ }));
    expect(onClearFolder).toHaveBeenCalledOnce();
  });
});
