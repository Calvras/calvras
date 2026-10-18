import { _electron as electron } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import assert from "node:assert/strict";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-chat-profile-"));
const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: [".", `--user-data-dir=${profile}`],
  env,
  timeout: 60000,
});
const results = {};
try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.addInitScript(() => {
    localStorage.setItem("calvras_access_mode", "full");
    localStorage.removeItem("calvras_chat_messages");
  });
  await page.reload();
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.waitFor({ timeout: 45000 });
  const send = async (text) => {
    await prompt.fill(text);
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    const stop = page.getByRole("button", { name: "Stop task", exact: true });
    await stop.waitFor({ timeout: 15000 });
    await stop.waitFor({ state: "detached", timeout: 180000 });
    return page.getByLabel("Conversation", { exact: true }).innerText();
  };

  const conversation = await send("hey");
  results.conversation = conversation;
  assert.ok(!/Select a project folder/i.test(conversation), "Chat must not end in a canned folder demand");
  assert.ok(!/Exploring workspace/i.test(conversation), "A greeting must not trigger workspace exploration");
  assert.ok(!/project folder|workspace|file access/i.test(conversation), "Casual chat must not mention projects or workspaces");
  await fs.mkdir(".agents/artifacts/runtime", { recursive: true });
  await page.screenshot({ path: ".agents/artifacts/runtime/chat-first.png", animations: "disabled" });

  const followUp = await send("What do you think makes a good minimal interface?");
  results.followUp = followUp.slice(conversation.length);
  assert.ok(results.followUp.length > 40, "A general question must get a real answer");
  assert.ok(!/project folder|workspace|select a folder/i.test(results.followUp), "General chat must not pivot back to project mode");

  results.style = await page.evaluate(() => {
    const bar = document.querySelector("div[style*='app-region']");
    const paragraph = document.querySelector(".markdown-body p");
    const header = Array.from(document.querySelectorAll("button")).find((el) => /Worked for|Thought for/i.test(el.textContent || ""));
    const style = bar ? getComputedStyle(bar) : null;
    return {
      titlebarFlat: style ? { image: style.backgroundImage, color: style.backgroundColor } : null,
      messageFont: paragraph ? getComputedStyle(paragraph).fontSize : null,
      headerFont: header ? getComputedStyle(header).fontSize : null,
    };
  });
  assert.equal(results.style.titlebarFlat?.image, "none", "Titlebar must be a flat strip with no gradient");
  assert.equal(results.style.titlebarFlat?.color, "rgb(20, 20, 21)", "Titlebar must be the flat charcoal strip");
  assert.equal(results.style.messageFont, "14.5px");
  assert.equal(results.style.headerFont, "13.5px");

  console.log(JSON.stringify({ ok: true, results }));
} finally {
  await app.close();
  await fs.rm(profile, { recursive: true, force: true });
}
