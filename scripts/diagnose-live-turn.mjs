// Diagnoses one real turn inside the packaged app: what the composer sends, what the renderer
// logs, and what the assistant bubble actually renders. Reads only, prints no credentials.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const out = ".agents/artifacts/live-diagnostic";
await fs.mkdir(out, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
const page = await app.firstWindow();
const logs = [];
page.on("console", (message) => logs.push(`[${message.type()}] ${message.text().slice(0, 300)}`));
page.on("pageerror", (error) => logs.push(`[pageerror] ${String(error).slice(0, 300)}`));
await page.waitForLoadState("domcontentloaded");

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-live-"));
await fs.writeFile(path.join(workspace, "notes.md"), "# Fixture notes\n\nThree tools are listed: read_file, write_file, run_command.\n");
const saved = {
  chat: await page.evaluate(() => localStorage.getItem("calvras_chat_messages")),
  projects: await page.evaluate(() => localStorage.getItem("calvras_projects")),
  active: await page.evaluate(() => localStorage.getItem("calvras_active_project")),
  mode: await page.evaluate(() => localStorage.getItem("calvras_access_mode")),
};
await page.evaluate(([dir]) => {
  const project = { name: "live-diagnostic", path: dir };
  localStorage.setItem("calvras_projects", JSON.stringify([project]));
  // The app stores the active project as a JSON object, not a bare path.
  localStorage.setItem("calvras_active_project", JSON.stringify(project));
  // readPreferences() compares this key verbatim, so it must be the bare word.
  localStorage.setItem("calvras_access_mode", "full");
  localStorage.setItem("calvras_chat_messages", "[]");
}, [workspace]);
await page.reload({ waitUntil: "domcontentloaded" });

const composer = page.getByRole("textbox", { name: "Prompt" });
await composer.waitFor({ timeout: 30_000 });
// Pass --subagent to ask for delegation only, so the worker's own log lines are the thing under test.
const SUBAGENT = process.argv.includes("--subagent");
await composer.fill(SUBAGENT
  ? "Call delegate_task once with role \"researcher\" and task \"read notes.md in this workspace and report how many tool names it lists\". Then wait for that job with read_agent using its id and tell me exactly what it reported, including any error it hit."
  : "Use web_search once for \"electron release notes\", then list the titles it returned.");
await page.keyboard.press("Enter");
console.log("submitted the prompt");

const turn = page.locator('[id^="msg-"]').last();
for (let attempt = 0; attempt < 60; attempt++) {
  await page.waitForTimeout(2_000);
  const text = (await turn.innerText({ timeout: 1_500 }).catch(() => "")).replace(/\s+/g, " ");
  const messages = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("calvras_chat_messages") || "[]").map((m) => ({ role: m.role, done: m.done, status: m.status, phases: m.phases?.length ?? 0, models: m.answeredBy, subagents: m.subagents })); } catch { return "unreadable"; }
  });
  if (attempt % 5 === 0) console.log(`attempt ${attempt} :: ${text.slice(-260)}`);
  if (attempt === 20) { console.log(`stored turns at 40s: ${JSON.stringify(messages).slice(0, 400)}`); await page.screenshot({ path: path.join(out, "mid-turn.png"), animations: "disabled" }); }
  if (/Answered by /.test(text)) {
    console.log(`FINISHED at attempt ${attempt} :: ${text.slice(-700)}`);
    // The worker's own record is what proves whether its failure was real and why.
    const jobs = messages.filter((m) => m.role === "assistant").at(-1)?.subagents;
    console.log(`subagent jobs: ${JSON.stringify(jobs, null, 1)?.slice(0, 3000) || "none"}`);
    break;
  }
}
await page.screenshot({ path: path.join(out, "final.png"), animations: "disabled" });
const finalText = (await turn.innerText({ timeout: 3_000 }).catch(() => "")).replace(/\s+/g, " ");
console.log(`final bubble: ${finalText.slice(0, 1200)}`);
console.log(`renderer log (${logs.length} lines):\n${logs.slice(-40).join("\n")}`);

await page.evaluate((values) => {
  for (const [key, value] of Object.entries(values)) {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  }
}, { calvras_chat_messages: saved.chat, calvras_projects: saved.projects, calvras_active_project: saved.active, calvras_access_mode: saved.mode });
await app.close().catch(() => {});
await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
