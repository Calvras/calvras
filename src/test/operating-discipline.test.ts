import { describe, it, expect } from "vitest";
import { CALVRAS_SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, workerSystemPrompt } from "@/lib/system-prompt";

// Pins the operating-discipline block: it has to reach every work turn, stay out of the
// tool-less chat turn, and reach verifier workers in their adversarial form. It cannot prove
// the model obeys it — only that the rules are actually in the prompt the model receives.
describe("operating discipline", () => {
  const rules = [
    "say which step you are on",
    "The original message is the specification",
    "pattern-matching from somewhere else",
    "rules of the room",
    ".calvras/journal.md",
    "say the contradiction out loud",
    "two honest approaches have already failed",
    "five or more files",
    "re-read the original request word for word",
    "where you have a verifier subagent",
  ];

  it("carries every rule into the work prompt", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toContain("Operating discipline.");
    for (const rule of rules) expect(CALVRAS_SYSTEM_PROMPT).toContain(rule);
  });

  it("keeps the work discipline out of the tool-less chat turn", () => {
    for (const rule of rules) expect(CHAT_SYSTEM_PROMPT).not.toContain(rule);
    expect(CHAT_SYSTEM_PROMPT).not.toContain("Operating discipline");
    expect(CHAT_SYSTEM_PROMPT).not.toContain(".calvras/journal.md");
  });

  it("writes verifier jobs as attempts to break the work", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toContain("A verifier job is written as an attempt to break the work");
  });

  it("tells a verifier worker to break it and a builder not to", () => {
    const verifier = workerSystemPrompt("verifier");
    expect(verifier).toContain("Your job is to break it");
    expect(verifier).toContain("A finding without a reproduction is an opinion");
    expect(workerSystemPrompt("builder")).not.toContain("Your job is to break it");
  });

  it("never hands a worker a subagent it does not have", () => {
    const worker = workerSystemPrompt("verifier");
    expect(worker).not.toContain("delegate_task");
    expect(worker).toContain("where you have a verifier subagent");
    expect(worker).toContain("attack it yourself");
  });

  it("keeps the natural-writing rule in both prompts", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toContain("Write like you talk to someone who is listening");
    expect(CHAT_SYSTEM_PROMPT).toContain("Write like you talk to someone who is listening");
  });
});
