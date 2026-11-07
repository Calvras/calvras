// Watches a real build in the running app and answers the question the user raised: does the agent
// write the whole site before it looks at it, and does the conversation read as
// thinking → working → a line per finished step → one final summary?
// Every poll dumps the conversation, so the ordering can be read from the log rather than trusted.
//   node scripts/verify-build-then-preview.mjs
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TASK = process.env.LIVE_TASK || "Build a scheduling website with a week view and a form that adds an appointment to it. Make it a real working page, not a mockup.";
const TURN_MS = Number(process.env.LIVE_TURN_MS || 22 * 60_000);
const OUT = ".agents/artifacts/build-then-preview";
await fs.mkdir(OUT, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-build-live-"));
const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: [".", `--user-data-dir=${profile}`],
  env,
  timeout: 60000,
});
const page = await app.firstWindow();
await page.waitForLoadState("domcontentloaded");
await page.addInitScript(() => {
  localStorage.setItem("calvras_access_mode", "full");
  localStorage.setItem("calvras_user", JSON.stringify({ provider: "google", email: "harness@calvras.com", name: "Build proof", joinedAt: Date.now() }));
  localStorage.removeItem("calvras_chat_messages");
});
await page.reload();

const prompt = page.getByRole("textbox", { name: "Prompt" });
await prompt.waitFor({ timeout: 60000 });
const conversation = () => page.getByLabel("Conversation", { exact: true }).innerText();
// One line per working round. A collapsed fold still holds its text in the DOM, so reading every
// aria-expanded button would dump the hidden reasoning too; the round header is the direct child.
const railLines = async () => (await page.locator(".reply-round > button[aria-expanded]").allInnerTexts()).join("\n");
const running = async () => (await page.getByRole("button", { name: "Stop task", exact: true }).count()) > 0;

await prompt.fill(TASK);
await page.getByRole("button", { name: "Send prompt", exact: true }).click();

const frames = [];
let approvals = 0;
const started = Date.now();
await page.getByRole("button", { name: "Stop task", exact: true }).waitFor({ timeout: 90_000 }).catch(() => {});
while (Date.now() - started < TURN_MS) {
  await page.waitForTimeout(10_000);
  const card = page.getByRole("radio", { name: "Allow once" }).first();
  if (await page.getByRole("region", { name: "Calvras needs your decision" }).count()) {
    const question = await page.getByLabel("Calvras needs your decision").first().innerText().catch(() => "");
    if (await card.count()) {
      // The new-project-folder card is the one that would otherwise be answered again and again;
      // "Always allow" settles it for the rest of this throwaway profile's run.
      const folderCard = /project folder/i.test(question);
      await (folderCard ? page.getByRole("radio", { name: "Always allow" }).first() : card).check();
      await page.getByRole("button", { name: "Confirm choice" }).click();
    } else {
      // An ask_user card: answer with its own first choice, or tell it to pick a default.
      const firstChoice = page.getByRole("radio").first();
      if (await firstChoice.count()) await firstChoice.check();
      else await page.getByRole("textbox", { name: "Your answer" }).fill("Pick the obvious default and keep going.");
      await page.getByRole("button", { name: /Send answer|Send your answer/ }).click();
    }
    approvals += 1;
    console.log(`[${Math.round((Date.now() - started) / 1000)}s] answered card ${approvals} :: ${question.replace(/\s+/g, " ").slice(0, 90)}`);
    continue;
  }
  const text = await conversation();
  const lines = await railLines();
  const stillRunning = await running();
  frames.push({ seconds: Math.round((Date.now() - started) / 1000), running: stillRunning, lines, text });
  await fs.writeFile(path.join(OUT, "conversation.txt"), text);
  await page.screenshot({ path: path.join(OUT, `t${frames.length}.png`), animations: "disabled" });
  console.log(`[${frames.length * 10}s] running=${stillRunning} rail-lines=${lines ? lines.split("\n").length : 0} preview-mentions=${(text.match(/preview/gi) || []).length}`);
  if (!stillRunning) break;
}

const last = frames[frames.length - 1] || { text: "(the run never produced a frame)", lines: "" };
await page.screenshot({ path: path.join(OUT, "final.png"), animations: "disabled" });
console.log("\n=== rail lines at the end ===\n" + (last.lines || "(none)"));
console.log("\n=== conversation at the end ===\n" + last.text.slice(-6000));
await fs.writeFile(path.join(OUT, "frames.json"), JSON.stringify(frames.map(({ text, ...rest }) => rest), null, 2));
await app.close();
await fs.rm(profile, { recursive: true, force: true });
