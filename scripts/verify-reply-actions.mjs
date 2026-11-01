// Verifies how a finished turn presents itself on the real app: hovering the reply reveals
// copy / thumbs-up / thumbs-down and the mark survives a reload, a turn with no rows is plain
// prose with nothing to fold, and a turn with a real round still expands to its rail.
// The transcript is seeded so none of this depends on a provider answering.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const out = ".agents/artifacts/reply-actions";
await fs.mkdir(out, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// A throwaway profile: the seeded turns and the sign-in stub stay out of the owner's real account.
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-reply-actions-"));
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: [".", `--user-data-dir=${profile}`], env, timeout: 60_000 });
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
  await page.evaluate(() => {
    localStorage.setItem("calvras_user", JSON.stringify({ provider: "google", email: "harness@calvras.com", name: "Reply proof", joinedAt: Date.now() }));
    localStorage.setItem("calvras_access_mode", "full");
  });
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });

  // The throwaway profile starts empty, so the clipboard and transcript round-trips below are the
  // seeded turns' own.
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
  // The transcript the app writes lives under the account's own `…/chats` key, and the seeded flat
  // `calvras_chat_messages` array is carried into it on load — so both shapes are checked, and the
  // debounced write is waited for rather than raced.
  const ratingOf = async (id) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const found = await page.evaluate((messageId) => {
        const find = (messages) => (Array.isArray(messages) ? messages : []).find((message) => message.id === messageId);
        for (const key of Object.keys(localStorage)) {
          if (!/(^|\/)(chats|calvras_chat_messages)$/.test(key)) continue;
          const stored = JSON.parse(localStorage.getItem(key) || "null");
          const direct = find(stored);
          if (direct) return direct.rating ?? "none";
          for (const chat of Object.values(stored && typeof stored === "object" ? stored : {})) {
            const found = find(chat?.messages);
            if (found) return found.rating ?? "none";
          }
        }
        return null;
      }, id);
      if (found !== null) return found;
      await page.waitForTimeout(250);
    }
    return "no transcript on disk";
  };
  const stored = await ratingOf(REPLY_ID);
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
  const cleared = await ratingOf(REPLY_ID);
  report(`a second click on the same thumb clears the mark (${String(cleared)})`, cleared === "none");

  // A turn whose round recorded no rows has nothing to fold: its sentence is the reply.
  report("a rowless turn shows no round header", (await turn.locator(".reply-round").count()) === 0);

  // The turn that did run a tool keeps its expandable round, folded once the turn is over.
  const workHeader = workTurn.locator(".reply-round > button[aria-expanded]");
  report(`a turn with real work keeps its dropdown (${(await workHeader.first().innerText().catch(() => "")).replace(/\s+/g, " ").trim()})`, (await workHeader.count()) === 1 && (await workHeader.getAttribute("aria-expanded")) === "false");
  await workHeader.click();
  await page.waitForTimeout(250);
  report("opening it reveals the step it took", (await workTurn.getByRole("button", { name: /Run build/ }).count()) === 1);
  await workTurn.getByRole("button", { name: /Run build/ }).click();
  await page.waitForTimeout(250);
  report("and the step carries its real command output", (await workTurn.getByText("bundle written").count()) > 0);
  await page.screenshot({ path: path.join(out, "headers.png"), animations: "disabled" });
} finally {
  await page?.evaluate((value) => {
    if (value === null) localStorage.removeItem("calvras_chat_messages");
    else localStorage.setItem("calvras_chat_messages", value);
  }, savedChat).catch(() => {});
  if (typeof savedClipboard === "string") await app.evaluate(({ clipboard }) => clipboard.writeText(savedClipboard)).catch(() => {});
  await app.close().catch(() => {});
  await fs.rm(profile, { recursive: true, force: true });
}

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
