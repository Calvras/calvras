import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { agentIntent, asksAboutTheAgent, asksForCapabilities, asksToReproduce } from "../lib/agent-intent";
import { CALVRAS_SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, workerSystemPrompt } from "../lib/system-prompt";
import { ApprovalNeeded, PermissionScope } from "../lib/runtime/permissions";
import { DEFAULT_POLICIES } from "../lib/policy-rules";

describe("automatic task continuation", () => {
  it.each(["launch it", "start the app", "can you check if it launches?", "run this project"])("inspects the selected project for %s", (text) => {
    expect(agentIntent(text, [], true)).toMatchObject({ requiresTools: true, initialActions: [{ type: "list_dir", path: "." }] });
  });
  it.each(["do it", "continue", "go ahead", "next step"])("resolves %s against the earlier request", (text) => {
    expect(agentIntent(text, ["hey", "launch the app"], true)).toMatchObject({ requiresTools: true, initialActions: [{ type: "list_dir", path: "." }], request: "launch the app" });
  });
  it("opens the page the user named before it thinks, instead of surveying the folder", () => {
    // The stakeout run spent its first two rounds on directory_tree and read_package_json for a
    // task that said "open http://127.0.0.1:59592/roles in the browser panel".
    const text = "Open http://127.0.0.1:59592/roles in the browser panel. It lists every open role at Acme, then apply to each one.";
    expect(agentIntent(text, [], true)).toMatchObject({ webFirst: true, initialActions: [{ type: "open_browser", url: "http://127.0.0.1:59592/roles" }] });
  });
  it("opens the page named without a scheme, not the folder", () => {
    // The user typed this and got "Reading the setup" for 53 seconds instead of a browser.
    const text = "search for calvras.com and help be go to thier partner page and tell them i want o be their partner";
    expect(agentIntent(text, [], true)).toMatchObject({ webFirst: true, initialActions: [{ type: "open_browser", url: "https://calvras.com" }] });
    expect(agentIntent("visit acme-hire.dev/roles and apply", [], true).initialActions[0]).toMatchObject({ type: "open_browser", url: "https://acme-hire.dev/roles" });
  });
  it("never reads a filename as a website", () => {
    for (const text of ["fix the build in package.json", "update the README.md and config.dev.ts", "rename main.tsx"]) {
      expect(agentIntent(text, [], true).webFirst).toBe(false);
    }
  });
  it("searches the web for a page named without an address", () => {
    expect(agentIntent("go to their partner page and tell them i want to be their partner", [], true)).toMatchObject({ webFirst: true, initialActions: [{ type: "web_search" }] });
    // The same words aimed at the workspace are code work, not browsing.
    expect(agentIntent("open the pricing page and change the layout", [], true).webFirst).toBe(false);
  });
  it("leaves a question about a link as a question", () => {
    expect(agentIntent("what does https://example.com/pricing say about seats?", [], true).webFirst).toBe(false);
    expect(agentIntent("launch it", [], true).webFirst).toBe(false);
  });
  it("does not inspect files for greetings or explanations", () => {
    expect(agentIntent("hey", [], true).requiresTools).toBe(false);
    expect(agentIntent("how does the server run?", [], true).initialActions).toEqual([]);
  });
  it.each(["run tests", "run lint", "run the electron app", "build the app and start the server"])("keeps %s in the full task loop", (text) => {
    expect(agentIntent(text, [], true).finishOnServerReady).toBe(false);
  });
  it("keeps the server shortcut and does not invent a workspace", () => {
    expect(agentIntent("run the server", [], true).initialActions).toEqual([{ type: "read_file", path: "package.json" }]);
    expect(agentIntent("launch it", [], false).initialActions).toEqual([]);
  });
  it.each(["remove the hero section", "delete the sidebar", "add a footer", "change the button color", "fix the build", "help me search for jobs and apply"])("requires a real side effect for %s", (text) => {
    expect(agentIntent(text, [], true)).toMatchObject({ requiresTools: true, requiresWork: true });
  });
  it.each(["how do I remove a section?", "what does this error mean?", "take a screenshot", "check the logs"])("does not require a side effect for %s", (text) => {
    expect(agentIntent(text, [], true).requiresWork).toBe(false);
  });
  it("carries the side-effect requirement through a follow-up", () => {
    expect(agentIntent("do it", ["please remove that section"], true)).toMatchObject({ requiresWork: true, request: "please remove that section" });
  });
  it.each([
    'Use web_search once for "electron release notes"',
    "call delegate_task with role researcher",
    "read_file package.json and tell me the version",
  ])("keeps %s in the task loop because it names a real tool", (text) => {
    expect(agentIntent(text, [], true).requiresTools).toBe(true);
  });
  it("does not turn a greeting into work because a word looks like a tool", () => {
    expect(agentIntent("hey there", [], true).requiresTools).toBe(false);
    expect(agentIntent("what is a file?", [], true).requiresTools).toBe(false);
  });
  it("forbids the refusal the model invented once: that it may not use tools", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/never say you are restricted from using tools/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/names one of your tools, or asks you to look something up, is work/i);
  });
  it("gives a worker no delegation tools to reach for", () => {
    // The live researcher died on its own delegate_task call because the shared prompt
    // advertised one, so the worker prompt must not name those tools at all.
    const worker = workerSystemPrompt("researcher");
    for (const name of ["delegate_task", "ask_subagent", "read_agent", "list_agents", "cancel_agent"]) {
      expect(CALVRAS_SYSTEM_PROMPT).toContain(name);
      expect(worker).not.toContain(name);
    }
    expect(worker).toMatch(/you have no subagents of your own/i);
    // Everything else the worker needs is still there.
    expect(worker).toContain("read_file");
    expect(worker).toMatch(/web_search/);
  });
});

describe("screenshot as a build target", () => {
  it.each([
    "duplicate this screen",
    "recreate this exactly",
    "make it look like the image",
    "rebuild this ui from the screenshot",
    "same page as shown here",
  ])("arms the pixel comparison for %s", (text) => {
    expect(asksToReproduce(text)).toBe(true);
  });
  it.each([
    "what does this error say?",
    "why is this broken?",
    "explain this dashboard",
    "the app is slow, fix the query",
  ])("leaves %s as context, not a target", (text) => {
    expect(asksToReproduce(text)).toBe(false);
  });
});

/** Each rule here exists because a real build of the user's got it wrong. */
describe("the rules a real build taught it", () => {
  it("knows the company behind it", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/made by Calvras Lab, the company/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/never claim to be nameless/i);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/made by Calvras Lab/);
  });
  it("deletes its own scratch file in full access but still asks before discarding the user's work", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/deleting a file inside the project[\s\S]*?go through without a confirmation/);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/cannot clean up its own scratch file/);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/discarding work the user did not name/);
  });
  it("works a long build brief as inspect, phase plan, build, verify, report", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/is a specification to execute, not a discussion to react to/);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/inspect before writing/);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/implemented, implemented with limits, not implemented/);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/never a confident fake/);
  });
  it("builds a mobile ask as a mobile app at phone size", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/means a mobile app, not a web page/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/390x844/);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/never downgrades a mobile request/i);
  });
  it("reproduces vectors and real 3d, and researches a technique it cannot see", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/real inline SVG paths/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/three\.js/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/a research step rather than a guess/i);
  });
  it("breaks out of a failing install instead of looping on it", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/two failed attempts on the same package is the limit/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/never spend a run reinstalling/i);
  });
  it("keeps the narration human and spends thinking where it pays", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/banned as an update/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/never re-open a file you just read/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/calm, precise software engineer/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/never insulting/i);
  });
  // The reply to "what can you do" used to be three vague lines, because the chat prompt banned
  // menus outright and carried no list to be specific from.
  it("answers a capabilities question with the whole list and one question after it", () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/when the message asks what you can do/i);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/give the whole list, not a summary/i);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/close with exactly one follow-up question/i);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/never a generic "what would you like to work on\?"/i);
    // "Which of these would you like to try?" is a menu wearing a question mark.
    expect(CHAT_SYSTEM_PROMPT).toMatch(/never "which of these interests you\?"/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/never "which of these interests you\?"/i);
    // The ban on menus survives, but only for ordinary replies.
    expect(CHAT_SYSTEM_PROMPT).toMatch(/never pad an ordinary reply with a menu/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/every capability as its own markdown bullet/i);
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/then exactly one specific follow-up question/i);
    // Every bullet is something the shipped code does, so the list must stay substantial.
    const bullets = CHAT_SYSTEM_PROMPT.match(/^- [A-Z].*/gm) || [];
    expect(bullets.length).toBeGreaterThanOrEqual(13);
    expect(bullets.join("\n")).toMatch(/browser panel it drives like a person/i);
    expect(bullets.join("\n")).toMatch(/Honest reporting/);
  });
  it.each([
    "what can you do",
    "show me what you can do",
    "tell me everything you can do",
    "what are your full functions",
    "your capabilities",
    "what are you capable of?",
    "list your features",
    "what features do you have",
  ])("reads %s as a request for the whole list", (text) => {
    expect(asksForCapabilities(text)).toBe(true);
    // ...and it stays a chat turn: no tool may run just to say what the agent is.
    expect(agentIntent(text, [], true).requiresTools).toBe(false);
  });
  // The chat turn has no tool catalog, and until now it had no formatting rule either: "just list 20"
  // came back as one comma-separated sentence, because the note said "respond in 1-4 sentences".
  it("shapes any multi-item chat answer as a list, not a comma run", () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/two or more items[\s\S]*own markdown bullet/i);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/comma-separated run[\s\S]*is never the right shape/i);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/Keep a one-item answer as one sentence/i);
  });
  // "…languages you can write code in" carries the verb "write", which made an answer about the
  // agent a build task: the loop refused it five times and the list landed five times.
  it.each([
    "just list 20 languages you can write code in",
    "which frameworks do you know",
    "name the sites you can open without logging in",
  ])("reads %s as a question about the agent, not the workspace", (text) => {
    expect(asksAboutTheAgent(text)).toBe(true);
    expect(agentIntent(text, [], true)).toMatchObject({ requiresTools: false, requiresWork: false });
  });
  it.each([
    "list the files you can see in the folder",
    "can you write a script that deploys this?",
    "fix the login page you can see here",
  ])("still sends %s to the work path", (text) => {
    expect(asksAboutTheAgent(text)).toBe(false);
  });
  it.each([
    "what can you do about this failing test?",
    "what can you do for me tomorrow?",
    "fix the login page",
    "hey",
  ])("leaves %s as an ordinary message", (text) => {
    expect(asksForCapabilities(text)).toBe(false);
  });
  // The conversation note is what the model reads last, and its 1-4 sentence cap is what actually
  // clipped this answer — so the branch has to exist in the route, not only in the system prompt.
  it("splits the conversation note between an ordinary message and a capabilities question", async () => {
    const source = await readFile("src/routes/index.tsx", "utf8");
    const start = source.indexOf("[CONVERSATION MODE]");
    const note = source.slice(start - 200, source.indexOf("if (workspaceJournal", start));
    expect(note).toContain("asksForCapabilities(text)");
    expect(note).toContain("every capability as its own markdown bullet");
    expect(note).toContain("exactly one follow-up question");
    expect(note).toContain('which of these interests you');
    expect(note).toContain("in 1-4 sentences, then stop");
    // ...but the sentence cap must not be what stops an ordinary answer being a list.
    expect(note).toContain("That length is about padding, never about shape");
    expect(note).toContain("each item on its own markdown bullet");
  });
  it("grants full access over the workspace but not over discarded work", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/Full access buys the WORKSPACE AND THE TERMINAL/);
    const scope = new PermissionScope("full");
    expect(() => scope.require({ type: "write_file", path: "a.ts", content: "x" })).not.toThrow();
    expect(() => scope.require({ type: "search_replace", path: "a.ts", search: "x", replace: "y" })).not.toThrow();
    expect(() => scope.require({ type: "delete_file", path: "a.ts" })).not.toThrow();
    expect(() => scope.require({ type: "undo_edit", checkpointId: "cp-1" })).toThrow(ApprovalNeeded);
    expect(() => scope.require({ type: "rollback_changes" })).toThrow(ApprovalNeeded);
    expect(() => scope.require({ type: "resolve_worker", id: "job-1", action: "apply" })).toThrow(ApprovalNeeded);
  });
  it("takes the running task over when the user sends during it", async () => {
    expect(DEFAULT_POLICIES.queuedDelivery).toBe("interrupt");
    const source = await readFile("src/routes/index.tsx", "utf8");
    const start = source.indexOf("if (isLoading) {");
    const branch = source.slice(start, source.indexOf("if (runtimeRef.current &&", start));
    expect(branch).toContain('delivery === "immediate"');
    expect(branch).toContain('delivery === "queue"');
    expect(/handleStop\(\);\s*\}\s*$/.test(branch)).toBe(true);
    expect(branch.indexOf("writeQueue")).toBeGreaterThan(branch.indexOf('delivery === "queue"'));
  });
});
