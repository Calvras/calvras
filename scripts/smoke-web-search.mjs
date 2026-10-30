// Proves the exact message from the bug report on the built app with no project open:
// it must search the live web and answer with what the engine returned, never claim it cannot.
import { _electron as electron } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-web-profile-"));
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: [".", `--user-data-dir=${profile}`], env, timeout: 60_000 });
try {
  const page = await app.firstWindow();
  const calls = [];
  page.on("request", (request) => { if (request.url().includes("/api/agent/web/")) calls.push(`${request.method()} ${request.url().split("/api")[1]}`); });
  await page.waitForLoadState("domcontentloaded");
  await page.addInitScript(() => {
    localStorage.setItem("calvras_access_mode", "full");
    localStorage.setItem("calvras_user", JSON.stringify({ provider: "google", email: "harness@calvras.com", name: "Harness", joinedAt: Date.now() }));
    localStorage.removeItem("calvras_chat_messages");
    localStorage.removeItem("calvras_projects");
    localStorage.removeItem("calvras_active_project");
  });
  await page.reload();
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.waitFor({ timeout: 45_000 });
  await prompt.fill(process.argv[2] || "browse through the web and tell me about examglow");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  const stop = page.getByRole("button", { name: "Stop task", exact: true });
  await stop.waitFor({ timeout: 20_000 });
  const seen = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.waitForTimeout(6_000);
    const text = (await page.getByLabel("Conversation", { exact: true }).innerText().catch(() => "")).replace(/\s+/g, " ");
    seen.push(text.slice(-400));
    console.log(`[${attempt * 6}s] ${text.slice(-400)}`);
    const done = await stop.isVisible().catch(() => false);
    if (!done && attempt > 2) break;
    if (!done) continue;
  }
  const conversation = await page.getByLabel("Conversation", { exact: true }).innerText();
  console.log(conversation.slice(-2500));
  const summary = page.getByRole("button", { name: /(?:Worked|Thought) for/ }).last();
  if (await summary.isVisible().catch(() => false)) {
    await summary.click();
    await page.waitForTimeout(300);
    console.log(`\nEXPANDED:\n${(await page.getByLabel("Conversation", { exact: true }).innerText()).slice(-900)}`);
  }
  console.log(`\nCALLS: ${calls.join(" | ") || "(none)"}`);
  const refused = /do not have the ability to browse|cannot browse|can't browse|unable to browse/i.test(conversation);
  const looked = /examglow/i.test(conversation);
  console.log(`\nREFUSED=${refused} MENTIONED_EXAMGLOW=${looked}`);
  await fs.mkdir(".agents/artifacts", { recursive: true });
  await page.screenshot({ path: ".agents/artifacts/web-search-turn.png", animations: "disabled" });
  process.exitCode = refused || !looked ? 1 : 0;
} finally {
  await app.close();
}
