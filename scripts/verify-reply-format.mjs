// Verifies this release's reply format inside the real desktop app: tool rows open
// collapsed, the Thought block only shows its sentences on click, narration never names
// files, the folder chip is inert mid-session, and a message sent during a task interrupts it.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OUT = ".agents/artifacts/reply-format";
const RUN_TIMEOUT = Number(process.env.RUN_TIMEOUT || 5 * 60_000);
const checks = [];
const check = (label, ok) => checks.push([label, Boolean(ok)]);
const say = (...args) => console.log(...args);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-reply-"));
await fs.writeFile(path.join(root, "README.md"), "# Proof\n\nA scratch project for UI verification.\n");

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
let page, shot = 0;
const snap = async (name) => page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, "0")}-${name}.png`), animations: "disabled" }).catch(() => {});

try {
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate((dir) => {
    localStorage.setItem("calvras_projects", JSON.stringify([{ name: "Reply Proof", path: dir }]));
    localStorage.setItem("calvras_active_project", JSON.stringify({ name: "Reply Proof", path: dir }));
    localStorage.setItem("calvras_access_mode", "full");
    localStorage.removeItem("calvras_chat_messages");
  }, root);
  await page.reload();
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });

  const marker = "echo";
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.click({ force: true });
  await prompt.fill("In the project terminal, run a shell command that prints the number 4173, then save a file named proof.txt containing that number. Keep your updates short and don't mention file names in them.");
  await prompt.press("Enter");
  await page.getByRole("button", { name: "Stop task" }).waitFor({ timeout: 60_000 });
  say("task accepted, waiting for the first tool row");

  // A tool row must exist before any of the collapse assertions mean anything.
  const rows = page.locator('button[aria-expanded]');
  await rows.first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(4_000);

  const collapsed = await page.locator("body").evaluate((body, text) => {
    const all = [...body.querySelectorAll("button[aria-expanded]")];
    const open = all.filter((b) => b.getAttribute("aria-expanded") === "true");
    return { open: open.length, hits: body.innerText.match(new RegExp(`\\b${text}\\b[^\\n]*`, "gi"))?.slice(0, 3) ?? [],
      labels: all.map((b) => b.innerText.replace(/\s+/g, " ").trim()).filter((l) => l && !/Full access|Conversation|Settings/i.test(l)).slice(0, 8) };
  }, marker);
  check(`tool rows start collapsed (expanded=${collapsed.open}, rows=[${collapsed.labels.join(" | ")}])`, collapsed.open === 0);
  check(`a collapsed row hides its command (${collapsed.hits.join(" / ") || "no command text on screen"})`, collapsed.hits.length === 0);
  const narr = await page.locator("body").evaluate((b) => b.innerText);
  check(`narration names no files (${narr.match(/checking \S+\.(mjs|ts|tsx|json|md)|reading \S+\.(mjs|ts|tsx|json|md)/gi)?.join(",") || "clean"})`,
    !/checking\s+\S*\.(mjs|ts|tsx|json|md)|reading\s+\S*\.(mjs|ts|tsx|json|md)/i.test(narr));
  check(`trace labels read as human work (${collapsed.labels.join(", ")})`,
    collapsed.labels.length > 0 && collapsed.labels.every((l) => !/^[a-z]+_[a-z_]+$/i.test(l) && !/\.(mjs|ts|tsx|json|md|txt)\b/i.test(l)));
  await snap("live-collapsed");

  // Interrupt: a message sent while the agent works takes over — the live turn stops and
  // this one starts, instead of sitting in a strip above the input.
  await prompt.click({ force: true });
  await prompt.fill("In the project terminal, run a shell command that prints the word takeover, then add it to proof.txt. Keep your updates short.");
  await page.getByRole("button", { name: "Stop this task and send" }).click();
  await page.getByLabel("Conversation").getByText(/prints the word takeover/).first().waitFor({ timeout: 10_000 });
  check("a mid-task send goes out at once", true);
  check("nothing is held above the input", (await page.getByRole("list", { name: "Waiting to send" }).count()) === 0);
  const interrupted = await page.getByLabel("Conversation").innerText();
  check(`the interrupted turn says so (${/Task stopped/i.test(interrupted) ? "yes" : "no"})`, /Task stopped/i.test(interrupted));
  await snap("interrupted");

  // The folder chip must do nothing once the chat has started.
  const folderState = await page.evaluate(() => {
    const chip = [...document.querySelectorAll("button")].find((b) => /Reply Proof|calvras-reply/.test(b.innerText || ""));
    return { found: Boolean(chip), tag: chip?.tagName, disabled: Boolean(chip?.disabled) };
  });
  check(`folder chip is inert mid-session (${folderState.found ? `found as <${folderState.tag}>` : "not a button at all"})`, !folderState.found || folderState.tag !== "BUTTON");
  const menu = await page.getByRole("menuitem", { name: /Choose a new folder|Work with no folder/ }).count();
  check("no folder menu opens mid-session", menu === 0);

  // A second send interrupts again: the composer never turns into a queue.
  await page.getByRole("button", { name: "Stop task" }).waitFor({ timeout: 30_000 });
  await prompt.click({ force: true });
  await prompt.fill("In the project terminal, run a shell command that prints the word takeover-again, then stop. Keep your updates short.");
  await page.getByRole("button", { name: "Stop this task and send" }).click();
  await page.getByLabel("Conversation").getByText(/prints the word takeover-again/).first().waitFor({ timeout: 10_000 });
  check("a second mid-task send interrupts again", true);
  await snap("interrupted-again");

  await page.getByRole("button", { name: "Stop task" }).waitFor({ state: "detached", timeout: RUN_TIMEOUT });
  const finished = await page.getByLabel("Conversation").innerText();
  check("the last task finished", !/Running…|Working…|Thinking…/.test(finished));
  await snap("finished");

  // The header collapses to a measured label and the row reveals code on click.
  const header = await page.getByRole("button", { name: /(Thought for|Worked for)/ }).first().innerText();
  check(`turn reports a measured header (${header.replace(/\s+/g, " ").trim().slice(0, 60)})`, /(Thought for|Worked for)/.test(header));
  // Opening the turn reveals the timeline; opening a row reveals its command.
  await page.getByRole("button", { name: /(Thought for|Worked for)/ }).first().click();
  await page.waitForTimeout(500);
  const commandRow = page.getByRole("button", { name: /Running a command|Saving a file|Writing a file/ }).last();
  await commandRow.scrollIntoViewIfNeeded();
  await commandRow.waitFor({ state: "visible", timeout: 10_000 });
  const beforeRow = (await page.getByLabel("Conversation").innerText()).length;
  await commandRow.click({ timeout: 10_000 });
  await page.waitForTimeout(400);
  const afterRow = (await page.getByLabel("Conversation").innerText()).length;
  check(`clicking a row reveals its command (+${afterRow - beforeRow} chars)`, afterRow > beforeRow);
  await snap("expanded-row");

  // The Thought row is the model's own commentary, mounted only when opened.
  const thoughtRow = page.getByRole("button", { name: /Thought for \d/ }).first();
  if (await thoughtRow.count()) {
    const before = (await page.getByLabel("Conversation").innerText()).length;
    await thoughtRow.click();
    await page.waitForTimeout(500);
    const after = (await page.getByLabel("Conversation").innerText()).length;
    check(`opening the Thought row reveals its sentences (+${after - before} chars)`, after > before);
    await snap("expanded-thought");
  } else {
    check("opening the Thought row reveals its sentences", false);
  }

  const alert = await page.locator('[role="alert"]').innerText().catch(() => "");
  check(`no provider banner leaked (${alert.slice(0, 90) || "none"})`, !/quota|rate limit|insufficient balance|HTTP 4|stopped streaming|Every configured model/i.test(alert));
} catch (error) {
  check(`stopped at: ${String(error.message).split("\n")[0].slice(0, 180)}`, false);
  if (page) await snap("failure");
} finally {
  await app.close();
  await fs.rm(root, { recursive: true, force: true });
}
const failed = checks.filter(([, ok]) => !ok);
say(JSON.stringify({ ok: failed.length === 0, checks, screenshots: await fs.readdir(OUT) }, null, 2));
process.exit(failed.length ? 1 : 0);
