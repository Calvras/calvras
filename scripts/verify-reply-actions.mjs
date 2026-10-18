// Verifies how a finished turn presents itself on the real app: hovering the reply reveals
// copy / thumbs-up / thumbs-down and the mark survives a reload, a thought with nothing behind
// it is plain prose instead of a dead dropdown, and a turn with a real timeline still expands.
// The transcript is seeded so none of this depends on a provider answering.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const out = ".agents/artifacts/reply-actions";
await fs.mkdir(out, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
const checks = [];
const report = (label, ok, detail = "") => { checks.push([label, ok]); console.log(`${ok ? "PASS" : "FAIL"} — ${label}${detail ? ` :: ${detail}` : ""}`); };
const REPLY = "I moved the sidebar to the left and kept the header intact.";
const WORK_REPLY = "The build passes now.";

let page;
let savedChat = null;
let savedClipboard = null;
try {
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });

  // This app shares the user's real profile, so their transcript and clipboard go back
  // exactly as found once the seeded turns have been tested.
  savedChat = await page.evaluate(() => localStorage.getItem("calvras_chat_messages"));
  savedClipboard = await app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => null);

  const base = Date.now();
  const REPLY_ID = base - 1;
  const WORK_ID = base - 3;
  await page.evaluate(([reply, workReply, replyId, workId, at]) => {
    localStorage.setItem("calvras_chat_messages", JSON.stringify([
      { id: at - 4, text: "move the sidebar", role: "user", done: true, status: "finished", phases: [] },
      { id: replyId, text: "", role: "assistant", done: true, status: "finished", startedAt: at - 40_000, endedAt: at - 20_000, phases: [{ trace: [], message: reply, startedAt: at - 40_000, endedAt: at - 20_000 }] },
      { id: at - 5, text: "check the build", role: "user", done: true, status: "finished", phases: [] },
      { id: workId, text: "", role: "assistant", done: true, status: "finished", startedAt: at - 18_000, endedAt: at - 6_000, phases: [{ trace: [{ id: "build", type: "terminal", primary: "Run build", command: "npm run build", status: "completed", exitCode: 0, output: "bundle written" }], message: workReply, startedAt: at - 18_000, endedAt: at - 6_000 }] },
    ]));
  }, [REPLY, WORK_REPLY, REPLY_ID, WORK_ID, base]);
  await page.reload({ waitUntil: "domcontentloaded" });

  // The sidebar keeps a preview of these same sentences, so each turn is addressed by its id.
  const turn = page.locator(`[id="msg-${REPLY_ID}"]`);
  const replyText = turn.getByText(REPLY, { exact: true });
  await replyText.waitFor({ timeout: 30_000 });
  const workTurn = page.locator(`[id="msg-${WORK_ID}"]`);
  await workTurn.getByText(WORK_REPLY, { exact: true }).waitFor({ timeout: 30_000 });

  const bar = turn.locator('[aria-label="Copy reply"]').locator("xpath=..");
  const copy = turn.getByRole("button", { name: "Copy reply" });
  const up = turn.getByRole("button", { name: "Good reply" });
  const down = turn.getByRole("button", { name: "Bad reply" });
  report("the reply exposes copy, like and dislike controls", (await copy.count()) === 1 && (await up.count()) === 1 && (await down.count()) === 1);

  const idleOpacity = await bar.evaluate((node) => getComputedStyle(node).opacity).catch(() => "MISSING");
  report(`the row is invisible until hover (opacity ${idleOpacity})`, idleOpacity === "0");

  await replyText.hover();
  await page.waitForTimeout(300);
  const hoverOpacity = await bar.evaluate((node) => getComputedStyle(node).opacity).catch(() => "MISSING");
  report(`hovering the reply reveals the row (opacity ${hoverOpacity})`, hoverOpacity === "1");
  await page.screenshot({ path: path.join(out, "hover-actions.png"), animations: "disabled" });

  await copy.click();
  await page.waitForTimeout(150);
  const after = await app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => "UNAVAILABLE");
  report(`copy puts the reply itself on the clipboard (${savedClipboard === after ? "unchanged" : "changed"})`, after === REPLY);
  report("the copy control reports it worked", (await turn.getByRole("button", { name: "Copied reply" }).count()) === 1);

  await up.click();
  await page.waitForTimeout(200);
  report("thumbs up is pressed after one click", (await up.getAttribute("aria-pressed")) === "true");
  report("thumbs down stays unpressed", (await down.getAttribute("aria-pressed")) === "false");
  const stored = await page.evaluate((id) => JSON.parse(localStorage.getItem("calvras_chat_messages") || "[]").find((m) => m.id === id)?.rating ?? "none", REPLY_ID);
  report(`the mark is written to chat storage (${String(stored)})`, stored === "up");

  const unhoverOpacity = await (async () => { await page.mouse.move(5, 5); await page.waitForTimeout(300); return bar.evaluate((node) => getComputedStyle(node).opacity); })();
  report(`a rated reply keeps its row visible without hover (opacity ${unhoverOpacity})`, unhoverOpacity === "1");

  await page.reload({ waitUntil: "domcontentloaded" });
  await replyText.waitFor({ timeout: 30_000 });
  report("the rating is still there after a reload", (await turn.getByRole("button", { name: "Good reply" }).getAttribute("aria-pressed")) === "true");

  await replyText.hover();
  await turn.getByRole("button", { name: "Bad reply" }).click();
  await page.waitForTimeout(200);
  report("switching to thumbs down moves the mark", (await turn.getByRole("button", { name: "Bad reply" }).getAttribute("aria-pressed")) === "true" && (await turn.getByRole("button", { name: "Good reply" }).getAttribute("aria-pressed")) === "false");
  await turn.getByRole("button", { name: "Bad reply" }).click();
  await page.waitForTimeout(200);
  const cleared = await page.evaluate((id) => JSON.parse(localStorage.getItem("calvras_chat_messages") || "[]").find((m) => m.id === id)?.rating ?? "none", REPLY_ID);
  report(`a second click on the same thumb clears the mark (${String(cleared)})`, cleared === "none");

  // A thought that recorded nothing has no chevron to chase and nothing to expand into.
  const thoughtHeader = turn.getByText("Thought for");
  report(`a thought-only turn still says how long it thought (${JSON.stringify(await thoughtHeader.first().textContent().catch(() => null))})`, Boolean(await thoughtHeader.first().textContent().catch(() => null)));
  report("that header is not a dropdown", (await turn.getByRole("button", { name: /Thought for/ }).count()) === 0);
  const headerHasChevron = await thoughtHeader.evaluate((node) => Boolean(node.closest("p")?.querySelector("svg")));
  report("no chevron is drawn beside it", headerHasChevron === false);

  // The turn that did run a tool keeps its expandable timeline.
  const workHeader = workTurn.getByRole("button", { name: /Worked for/ });
  report("a turn with real work keeps its dropdown", (await workHeader.count()) === 1 && (await workHeader.getAttribute("aria-expanded")) === "false");
  await workHeader.click();
  await page.waitForTimeout(250);
  report("opening it reveals the step it took", (await workTurn.getByRole("button", { name: /Run build/ }).count()) === 1);
  await workTurn.getByRole("button", { name: /Run build/ }).click();
  await page.waitForTimeout(250);
  report("and the step carries its real command output", (await workTurn.getByText("npm run build").count()) > 0);
  await page.screenshot({ path: path.join(out, "headers.png"), animations: "disabled" });
} finally {
  await page?.evaluate((value) => {
    if (value === null) localStorage.removeItem("calvras_chat_messages");
    else localStorage.setItem("calvras_chat_messages", value);
  }, savedChat).catch(() => {});
  if (typeof savedClipboard === "string") await app.evaluate(({ clipboard }) => clipboard.writeText(savedClipboard)).catch(() => {});
  await app.close().catch(() => {});
}

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
