// Proves the approval card in the rendered app answers four ways, and that the two answers with
// consequences really have them:
//   Always allow  — the tool runs, the rule is stored where Settings can revoke it, and the next
//                   time the same tool is asked for, no card appears at all.
//   Your answer   — the action is refused, nothing is written, and the user's own words go into the
//                   conversation and on to the agent instead of an approval token.
// Runs against a dev server in a throwaway browser profile so the installed app can stay open;
// the project folder is a temp directory this script creates and deletes. Every turn is a real one
// against the configured provider.
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const BASE = process.env.CALVRAS_HARNESS_URL || "http://127.0.0.1:4179/";
const EMAIL = "approval-proof@calvras.test";
const SCOPE = `calvras/account/${EMAIL.toLowerCase()}`;
const TURN_MS = Number(process.env.TURN_TIMEOUT || 4 * 60_000);
const out = ".agents/artifacts/approval-answers";
await fs.mkdir(out, { recursive: true });
const results = [];
const report = (label, ok, detail = "") => {
  results.push([label, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}${detail ? ` :: ${String(detail).slice(0, 400).replace(/\s+/g, " ")}` : ""}`);
};

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-approval-"));
await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "approval-fixture" }), "utf8");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await context.addInitScript(([dir, email, scope]) => {
  localStorage.setItem("calvras_user", JSON.stringify({ provider: "google", email, name: "Approval proof", joinedAt: Date.now() }));
  sessionStorage.setItem("calvras_session_started", "1");
  const project = { name: "approval-fixture", path: dir };
  localStorage.setItem(`${scope}/projects`, JSON.stringify([project]));
  localStorage.setItem(`${scope}/activeProject`, JSON.stringify(project));
  localStorage.setItem(`${scope}/chats`, JSON.stringify([]));
  localStorage.setItem("calvras_access_mode", "ask");
  localStorage.removeItem("calvras_policies");
}, [workspace, EMAIL, SCOPE]);
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error.message || error)));
const card = () => page.getByRole("region", { name: "Calvras needs your decision" });
const promptBox = () => page.getByRole("textbox", { name: "Prompt" });
const probe = async (name) => fs.readFile(path.join(workspace, name), "utf8").catch(() => null);
const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`), animations: "disabled", timeout: 10_000 }).catch(() => {});
const ask = async (text) => {
  await promptBox().fill(text);
  const send = page.getByRole("button", { name: "Send prompt", exact: true });
  if (await send.count()) await send.first().click();
  else await page.keyboard.press("Enter");
};
const settle = async () => {
  for (let attempt = 0; attempt < Math.ceil(TURN_MS / 2_000); attempt++) {
    await page.waitForTimeout(2_000);
    if (!(await page.getByRole("button", { name: "Stop task" }).count())) return true;
  }
  return false;
};

let failed = false;
try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await promptBox().waitFor({ timeout: 60_000 });
  const mode = await page.getByRole("button", { name: "Workspace permissions" }).innerText();
  report(`the app opens in Ask first, where a file write must be answered (${mode.trim()})`, /ask/i.test(mode), mode);

  // --- The four answers on one card ----------------------------------------------------------
  await ask("Create exactly one file named refuse-probe.txt in the project containing the word hello. Do nothing else.");
  await card().first().waitFor({ timeout: TURN_MS });
  const labels = await card().first().locator("label").allInnerTexts();
  report(`the card offers Allow once, Always allow and Don't allow (${labels.join(" / ")})`,
    labels.some((l) => /Allow once/i.test(l)) && labels.some((l) => /^Always allow/i.test(l)) && labels.some((l) => /Don't allow/i.test(l)) && !labels.some((l) => /for this task/i.test(l)));
  const answer = card().first().getByLabel("Your answer");
  report("the card carries a field for the user's own fourth answer", await answer.count() === 1);
  await shot("card-four-answers");

  // --- Answer 4: type instead of choosing ----------------------------------------------------
  const words = "do not create any file at all. Just say the word acknowledged and stop.";
  await answer.fill(words);
  const sendAnswer = card().first().getByRole("button", { name: "Send your answer" });
  report("typing moves the button off the radios and onto the typed answer", await sendAnswer.count() === 1);
  report("a typed answer takes the radios out of play", await card().first().getByLabel("Allow once").isDisabled() === true);
  await shot("card-typed-answer");
  await sendAnswer.click();
  await card().first().waitFor({ state: "detached", timeout: 30_000 });
  const echoed = await page.getByText("do not create any file at all", { exact: false }).count();
  report("the typed answer shows in the conversation as the user's own message", echoed > 0, `${echoed} bubble(s)`);
  report("the turn finished after the typed answer", await settle());
  report("the refused action really did not write its file", (await probe("refuse-probe.txt")) === null);
  await shot("card-after-typed-answer");

  // --- Answer 2: Always allow ----------------------------------------------------------------
  await ask("Create exactly one file named always-probe.txt in the project containing the word ok. Do nothing else.");
  await card().first().waitFor({ timeout: TURN_MS });
  await card().first().getByLabel("Always allow").check();
  await card().first().getByRole("button", { name: "Confirm choice" }).click();
  let created = null;
  for (let attempt = 0; attempt < 60 && !created; attempt++) {
    await page.waitForTimeout(2_000);
    created = await probe("always-probe.txt");
  }
  report("Always allow runs the tool it was asked about", created !== null, String(created).slice(0, 40));
  const rules = (await page.evaluate(() => JSON.parse(localStorage.getItem("calvras_policies") || "{}"))).toolRules || {};
  const allowed = Object.entries(rules).filter(([, effect]) => effect === "allow").map(([name]) => name);
  report(`Always allow stores the rule where Settings shows it (${allowed.join(", ") || "none"})`, allowed.length > 0, JSON.stringify(rules));

  // --- The rule holds: the same tool next time asks nobody -----------------------------------
  await ask("Create exactly one file named silent-probe.txt in the project containing the word quiet. Do nothing else.");
  await page.waitForTimeout(6_000);
  const cardCount = await card().count();
  let silent = null;
  for (let attempt = 0; attempt < Math.ceil(TURN_MS / 2_000) && !silent; attempt++) {
    await page.waitForTimeout(2_000);
    silent = await probe("silent-probe.txt");
  }
  report("the next run of that tool needs no card at all", cardCount === 0 && silent !== null, `cards=${cardCount}, file=${silent === null ? "missing" : "written"}`);
  await shot("card-always-allow");
} catch (error) {
  failed = true;
  console.log(`HARNESS ERROR: ${error?.message || error}`);
  await shot("failure");
} finally {
  await browser.close().catch(() => {});
  await fs.rm(workspace, { recursive: true, force: true });
}

const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} checks passed${pageErrors.length ? ` :: page errors: ${pageErrors.slice(0, 4).join(" | ")}` : ""}`);
process.exit(failed || results.some(([, ok]) => !ok) ? 1 : 0);
