import { act, render } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectProvider, useProjects, type ProjectContextValue } from "../lib/project-context";
import { readChats, readScoped, scopedKey, writeStoredUser } from "../lib/account";

beforeEach(() => {
  localStorage.clear();
});

let current: ProjectContextValue | null = null;
function Probe() {
  current = useProjects();
  return null;
}

function mount() {
  const view = render(<ProjectProvider><Probe /></ProjectProvider>);
  return { ...view, state: () => current as ProjectContextValue };
}

const signIn = (email: string) => writeStoredUser({ provider: "google", email, joinedAt: 1 });

describe("conversation history", () => {
  it("keeps every conversation the account started, each with its own transcript", () => {
    signIn("shikari@calvras.com");
    const { unmount, state } = mount();

    act(() => state().addRecent({ id: "chat-1", label: "Fix the sidebar" }));
    act(() => state().saveChat("chat-1", { messages: [{ role: "user", text: "Fix the sidebar" }] }));

    act(() => state().triggerNewChat());
    act(() => state().addRecent({ id: "chat-2", label: "Build the dock", projectPath: "C:/repo/dock", projectName: "Dock" }));
    act(() => state().saveChat("chat-2", { messages: [{ role: "user", text: "Build the dock" }] }));

    expect(state().recents.map((recent) => recent.id)).toEqual(["chat-2", "chat-1"]);
    expect(state().activeChatId).toBe("chat-2");

    act(() => state().openChat("chat-1"));
    expect(state().activeChatId).toBe("chat-1");
    expect(state().chats.find((chat) => chat.id === "chat-1")?.messages).toHaveLength(1);
    expect(readChats()["chat-2"]!.messages).toEqual([{ role: "user", text: "Build the dock" }]);
    unmount();
  });

  it("stores one history entry per conversation, not one per message", () => {
    signIn("shikari@calvras.com");
    const { state } = mount();
    act(() => state().addRecent({ id: "chat-1", label: "First turn" }));
    act(() => state().addRecent({ id: "chat-1", label: "First turn" }));
    expect(state().recents).toHaveLength(1);
    expect(state().chats).toHaveLength(1);
  });

  it("moves an old flat transcript into the account that opens the app", () => {
    localStorage.setItem("calvras_chat_messages", JSON.stringify([{ role: "user", text: "Earlier work" }]));
    localStorage.setItem("calvras_recents", JSON.stringify([{ id: "chat-old", label: "Earlier work" }]));
    signIn("shikari@calvras.com");
    const { state } = mount();
    expect(state().activeChatId).toBe("chat-old");
    expect(state().chats[0]?.messages).toEqual([{ role: "user", text: "Earlier work" }]);
    expect(localStorage.getItem("calvras_chat_messages")).toBeNull();
    expect(localStorage.getItem(scopedKey("chats"))).not.toBeNull();
    expect(localStorage.getItem(scopedKey("recents"))).not.toBeNull();
  });

  it("gives the next person to sign in a shelf of their own", () => {
    signIn("shikari@calvras.com");
    const first = mount();
    act(() => first.state().addProject({ name: "Calvras", path: "C:/repo/calvras" }));
    act(() => first.state().addRecent({ id: "chat-1", label: "Mine" }));
    act(() => first.state().saveChat("chat-1", { messages: [{ role: "user", text: "Mine" }] }));
    first.unmount();

    signIn("someone.else@calvras.com");
    const second = mount();
    expect(second.state().projects).toEqual([]);
    expect(second.state().recents).toEqual([]);
    expect(second.state().chats).toEqual([]);
    expect(second.state().activeChatId).toBeNull();
    expect(readScoped("projects", [{ name: "leaked" }])).toEqual([]);
  });

  it("drops the transcript when the conversation is removed from the sidebar", () => {
    signIn("shikari@calvras.com");
    const { state } = mount();
    act(() => state().addRecent({ id: "chat-1", label: "Throwaway" }));
    act(() => state().saveChat("chat-1", { messages: [{ role: "user", text: "Throwaway" }] }));
    act(() => state().deleteRecent("chat-1"));
    expect(state().chats).toEqual([]);
    expect(state().activeChatId).toBeNull();
    expect(readChats()["chat-1"]).toBeUndefined();
  });

  it("renames the conversation in History and in the store together", () => {
    signIn("shikari@calvras.com");
    const { state } = mount();
    act(() => state().addRecent({ id: "chat-1", label: "Old name" }));
    act(() => state().renameRecent("chat-1", "New name"));
    expect(state().recents[0]?.label).toBe("New name");
    expect(readChats()["chat-1"]!.label).toBe("New name");
  });

  it("opens a conversation from the sidebar and writes it back per chat", async () => {
    const root = await readFile("src/routes/__root.tsx", "utf8");
    expect(root).toContain("openChat(recent.id)");
    const app = await readFile("src/routes/index.tsx", "utf8");
    expect(app).not.toContain('localStorage.setItem("calvras_chat_messages"');
    expect(app).not.toContain('localStorage.getItem(CHAT_STORAGE_KEY');
    expect(app).toContain("saveChat(chatId,");
    expect(app).toContain("if (chatIdRef.current === null)");
  });
});
