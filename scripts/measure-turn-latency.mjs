// Times one real turn in the running app: every inference call the turn makes, how long each
// took, when the first character reached the screen, and when the bubble finished.
// Guessing at "it feels slow" fixes nothing; this is the measurement the fix has to move.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const OUT = ".agents/artifacts/turn-latency";
await fs.mkdir(OUT, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
const page = await app.firstWindow();
await page.waitForLoadState("domcontentloaded");

const calls = [];
const consoleLines = [];
let turnStart = 0;
page.on("console", (message) => { if (turnStart) consoleLines.push(`+${((Date.now() - turnStart) / 1000).toFixed(1)}s [${message.type()}] ${message.text().slice(0, 160)}`); });
page.on("request", (request) => { if (request.url().includes("/api/v1/chat/completions")) { request.__startedAt = Date.now(); calls.push({ url: request.url(), startedMs: turnStart ? Date.now() - turnStart : 0, body: request.postData()?.slice(0, 400) }); } });
page.on("response", async (response) => {
  if (!response.url().includes("/api/v1/chat/completions")) return;
  const entry = calls.find((item) => !item.ms && item.startedMs !== undefined);
  if (!entry) return;
  entry.status = response.status();
  entry.ms = Date.now() - (response.request().__startedAt ?? turnStart);
});

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-latency-"));
await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "pulse-app", scripts: { dev: "vite" }, dependencies: { react: "^19.0.0" } }));

const saved = {
  chat: await page.evaluate(() => localStorage.getItem("calvras_chat_messages")),
  projects: await page.evaluate(() => localStorage.getItem("calvras_projects")),
  active: await page.evaluate(() => localStorage.getItem("calvras_active_project")),
};
await page.evaluate(([dir]) => {
  const project = { name: "pulse-app", path: dir };
  localStorage.setItem("calvras_projects", JSON.stringify([project]));
  localStorage.setItem("calvras_active_project", JSON.stringify(project));
  localStorage.setItem("calvras_access_mode", "automatic");
  localStorage.removeItem("calvras_chat_messages");
}, [workspace]);
await page.reload({ waitUntil: "domcontentloaded" });

const prompt = page.getByRole("textbox", { name: "Prompt" });
await prompt.waitFor({ timeout: 60_000 });

const bubbles = () => page.evaluate(() => [...document.querySelectorAll('[aria-label="Conversation"] [id^="msg-"]')].map((node) => node.id));

const run = async (text) => {
  calls.length = 0;
  consoleLines.length = 0;
  const before = await bubbles();
  turnStart = Date.now();
  await prompt.fill(text);
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  const stop = page.getByRole("button", { name: "Stop task", exact: true });
  await stop.waitFor({ timeout: 40_000 });
  // The assistant turn is the node that appears after the user's own; text length alone cannot
  // tell them apart, which is what made an earlier run report an empty reply for a real answer.
  let firstCharMs = 0;
  let assistantId = "";
  while (Date.now() - turnStart < 240_000) {
    const ids = await bubbles();
    const added = ids.filter((id) => !before.includes(id));
    if (!assistantId && added.length > 1) assistantId = added.at(-1);
    if (assistantId && !firstCharMs) {
      const grown = await page.evaluate((id) => (document.getElementById(id)?.innerText ?? "").trim().length > 0, assistantId);
      if (grown) firstCharMs = Date.now() - turnStart;
    }
    if (firstCharMs && !(await stop.isVisible().catch(() => false))) break;
    await page.waitForTimeout(120);
  }
  await stop.waitFor({ state: "detached", timeout: 240_000 });
  const totalMs = Date.now() - turnStart;
  const reply = assistantId ? await page.evaluate((id) => {
    const node = document.getElementById(id);
    return node ? node.innerText.replace(/^.*?\n/, "").trim() : "";
  }, assistantId) : "";
  return { ask: text, firstCharMs, totalMs, reply, console: consoleLines.slice(-25), inferenceCalls: calls.map((call) => ({ status: call.status, startedMs: call.startedMs, ms: call.ms, profile: /"profile":"(\w+)"/.exec(call.body ?? "")?.[1] ?? "?" })) };
};

const samples = [];
for (const ask of ["hey", "what is your system prompt"]) samples.push(await run(ask));

await fs.writeFile(path.join(OUT, "samples.json"), JSON.stringify(samples, null, 2));
await page.evaluate((restore) => {
  for (const [key, value] of Object.entries(restore)) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
}, { calvras_chat_messages: saved.chat, calvras_projects: saved.projects, calvras_active_project: saved.active });

await app.close();
await fs.rm(workspace, { recursive: true, force: true });

const report = samples.map((sample) => `${sample.ask}: first characters at ${(sample.firstCharMs / 1000).toFixed(1)}s, done in ${(sample.totalMs / 1000).toFixed(1)}s, ${sample.inferenceCalls.length} inference call(s) [${sample.inferenceCalls.map((c) => `start ${((c.startedMs ?? 0) / 1000).toFixed(1)}s ${c.status} ${(c.ms / 1000).toFixed(1)}s`).join(" | ")}]`);
console.log(report.join("\n"));
console.log("\nlast console of each turn:\n" + samples.map((sample) => `--- ${sample.ask}\n${sample.console.join("\n")}`).join("\n"));
console.log("\nreplies:\n" + samples.map((sample) => `--- ${sample.ask}\n${sample.reply}`).join("\n"));
