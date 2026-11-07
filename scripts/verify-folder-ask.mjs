// Proves the one thing asked for: with no folder open and Full access on, a build request stops
// at a question instead of making a project folder on the Desktop. Denying it must create nothing.
// This runs the real app against the real configured model, so it costs one live turn.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DESKTOP = path.join(os.homedir(), "Desktop");
const KEYS = ["calvras_projects", "calvras_active_project", "calvras_access_mode", "calvras_chat_messages"];
const BUDGET_MS = Number(process.env.RUN_TIMEOUT || 5 * 60_000);
const checks = [];
const say = (label, pass) => { checks.push([label, pass === true]); return pass === true; };

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const desktopBefore = new Set(await fs.readdir(DESKTOP));
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
const page = await app.firstWindow();
const saved = {};
let denied = false;
let asked = null;
let conversationTail = "";

try {
  await page.waitForLoadState("domcontentloaded");
  for (const key of KEYS) saved[key] = await page.evaluate((name) => localStorage.getItem(name), key);
  // Nothing open, everything allowed: exactly the setting that used to build silently.
  await page.evaluate(() => {
    localStorage.removeItem("calvras_projects");
    localStorage.removeItem("calvras_active_project");
    localStorage.removeItem("calvras_chat_messages");
    localStorage.setItem("calvras_access_mode", "full");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });
  await page.getByRole("textbox", { name: "Prompt" }).fill("Make me a single-page todo website in its own new folder right now: index.html plus style.css, milky white background, dark header, add/complete/delete tasks. Do not ask me anything, just build it and tell me where it is.");
  const started = Date.now();
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();

  const folderCard = page.locator('section[aria-label="Calvras needs your decision"]').filter({ hasText: /Create a new project folder/i });
  const anyCard = page.locator('section[aria-label="Calvras needs your decision"]');
  while (Date.now() - started < BUDGET_MS && !denied) {
    if (await folderCard.count()) {
      asked = (await folderCard.innerText()).replace(/\s+/g, " ").trim();
      await folderCard.locator('input[value="deny"]').check();
      await page.getByRole("button", { name: "Confirm choice" }).click();
      denied = true;
      break;
    }
    if (await anyCard.count()) {
      const text = (await anyCard.first().innerText()).replace(/\s+/g, " ").trim();
      if (await anyCard.first().locator('input[value="deny"]').count()) {
        // Something other than the folder question interrupted with a permission request. It still
        // asked, but the folder decision had to come first, so record what actually appeared.
        asked = asked || `unexpected permission card: ${text}`;
        await anyCard.first().locator('input[value="deny"]').check();
        await page.getByRole("button", { name: "Confirm choice" }).click();
        continue;
      }
      asked = asked || `asked a question first: ${text}`;
      await anyCard.first().getByRole("textbox", { name: "Your answer" }).fill("Up to you. Just tell me first where you will put the files.");
      await page.getByRole("button", { name: "Send answer" }).click();
      continue;
    }
    if (!(await page.getByRole("button", { name: "Stop task", exact: true }).count())) break;
    await page.waitForTimeout(1_000);
  }

  const conversation = await page.getByLabel("Conversation", { exact: true }).innerText().catch(() => "");
  conversationTail = conversation.slice(-2_500);
  await page.waitForTimeout(4_000);
  const added = (await fs.readdir(DESKTOP)).filter((name) => !desktopBefore.has(name));

  say(`with no folder open it stopped and asked instead of building (${(asked || conversation).slice(0, 160)})`, Boolean(denied));
  say(`the ask named the folder it wanted to make (${String(asked).slice(0, 90)})`, /Create a new project folder ".+" and build there\?/.test(String(asked)));
  say(`denying it created nothing on the Desktop (${JSON.stringify(added)})`, added.length === 0);
  const silent = conversation.match(/Project created|workspace created|I created the folder/i);
  say(`the reply reports no folder of its own (${String(silent).slice(0, 80)})`, !silent);
  await fs.mkdir(path.join(".agents", "artifacts"), { recursive: true });
  await page.screenshot({ path: path.join(".agents", "artifacts", "folder-ask.png") }).catch(() => {});
} finally {
  await page.evaluate((entries) => {
    for (const [key, value] of entries) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
  }, Object.entries(saved)).catch(() => {});
  await app.close().catch(() => {});
}

const failed = checks.filter(([, pass]) => !pass);
console.log(JSON.stringify({ ok: failed.length === 0, asked, conversationTail, checks }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
