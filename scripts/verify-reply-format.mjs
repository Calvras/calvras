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

  const live = await page.locator("body").evaluate((body) => {
    const headers = [...body.querySelectorAll(".reply-round > button[aria-expanded]")];
    const chips = [...body.querySelectorAll(".reply-round button[aria-expanded]")].filter((b) => !headers.includes(b));
    return {
      headers: headers.map((b) => `${b.innerText.replace(/\s+/g, " ").trim()}=${b.getAttribute("aria-expanded")}`),
      openChips: chips.filter((b) => b.getAttribute("aria-expanded") === "true").length,
      chipLabels: chips.map((b) => b.innerText.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8),
    };
  });
  check(`the round in flight is open (${JSON.stringify(live.headers)})`, live.headers.some((line) => line.endsWith("=true")));
  check(`every tool row inside it is still folded (open chips=${live.openChips})`, live.openChips === 0);
  const narr = await page.locator("body").evaluate((b) => b.innerText);
  check(`narration names no files (${narr.match(/checking \S+\.(mjs|ts|tsx|json|md)|reading \S+\.(mjs|ts|tsx|json|md)/gi)?.join(",") || "clean"})`,
    !/checking\s+\S*\.(mjs|ts|tsx|json|md)|reading\s+\S*\.(mjs|ts|tsx|json|md)/i.test(narr));
  check(`trace labels read as human work (${live.chipLabels.join(", ")})`,
    live.chipLabels.length > 0 && live.chipLabels.every((label) => !/^[a-z]+_[a-z_]+$/i.test(label)));
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

  // A finished turn leaves one folded header per round; each fold opens on click.
  const folded = await page.locator("body").evaluate((body) => [...body.querySelectorAll(".reply-round > button[aria-expanded]")]
    .map((b) => `${b.innerText.replace(/\s+/g, " ").trim()}=${b.getAttribute("aria-expanded")}`));
  check(`every round of the finished turn folded away (${JSON.stringify(folded)})`, folded.length > 0 && folded.every((line) => line.endsWith("=false")));
  const firstHeader = page.locator(".reply-round > button[aria-expanded]").first();
  await firstHeader.click();
  await page.waitForTimeout(400);
  check("opening a round brings its rail back", (await firstHeader.getAttribute("aria-expanded")) === "true");

  const commandRow = page.locator('.reply-round > div button[aria-expanded]').filter({ hasNotText: /Thought process/ }).first();
  await commandRow.waitFor({ timeout: 10_000 });
  check(`a rail row is folded until clicked (${(await commandRow.innerText()).replace(/\s+/g, " ").trim()})`, (await commandRow.getAttribute("aria-expanded")) === "false");
  await commandRow.click();
  await page.waitForTimeout(400);
  check("clicking a rail row opens its body", (await commandRow.getAttribute("aria-expanded")) === "true");
  await snap("expanded-row");

  // The Thought row is the model's own commentary, opened on click like any other row.
  const thoughtRow = page.locator(".reply-round > div button[aria-expanded]").filter({ hasText: /Thought process/ }).first();
  if (await thoughtRow.count()) {
    await thoughtRow.click();
    await page.waitForTimeout(400);
    check(`opening the Thought row shows its sentences (${(await thoughtRow.innerText()).replace(/\s+/g, " ").trim()})`, (await thoughtRow.getAttribute("aria-expanded")) === "true");
    await snap("expanded-thought");
  } else {
    check("opening the Thought row shows its sentences", false);
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
