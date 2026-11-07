// Proves, in the running app, how a turn that stopped short presents itself: the steps the run
// never reached are named, a milky "Pick it back up" control appears, and pressing it resumes from
// those steps instead of restarting the task. Also proves none of the old canned stop sentences
// reach the screen. The transcript is seeded, so this does not depend on what the agent last did.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const out = ".agents/artifacts/short-run";
await fs.mkdir(out, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
const checks = [];
const report = (label, ok, detail = "") => { checks.push([label, ok]); console.log(`${ok ? "PASS" : "FAIL"} — ${label}${detail ? ` :: ${detail.slice(0, 600)}` : ""}`); };

const STEPS = ["Wire the settings route", "Run the build and report the exit code"];
const REPLY = "Read the whole folder and wrote the shell. The round ended before the rest.";
const CANNED = ["I stopped with this still open", "Missing file contents", "could not reach the model", "Action limit reached", "Task stopped. Resume when you're ready"];

let page;
let accountKey = null;
let savedAccount = null;
try {
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });
  // Chats live on the signed-in account's shelf, one entry per conversation id, so the seeded
  // turn is written there — and the account's own list is put back at the end.
  accountKey = await page.evaluate(() => {
    const user = JSON.parse(localStorage.getItem("calvras_user") || "null");
    return user?.email ? `calvras/account/${user.email.toLowerCase()}` : null;
  });
  if (!accountKey) throw new Error("the app is not signed in, so there is no account shelf to seed");
  savedAccount = await page.evaluate((prefix) => ({
    chats: localStorage.getItem(`${prefix}/chats`),
    recents: localStorage.getItem(`${prefix}/recents`),
  }), accountKey);

  const base = Date.now();
  const STOPPED_ID = base - 1;
  await page.evaluate(([prefix, reply, steps, replyId, at]) => {
    const store = JSON.parse(localStorage.getItem(`${prefix}/chats`) || "{}");
    const id = `chat-harness-${at}`;
    store[id] = {
      id, label: "Harness short run", savedAt: at,
      messages: [
        { id: at - 4, text: "build the settings page end to end", role: "user", done: true, status: "finished", phases: [] },
        { id: replyId, text: "", role: "assistant", done: true, status: "blocked", startedAt: at - 90_000, endedAt: at - 20_000, openSteps: steps, phases: [{ trace: [{ id: "read", type: "tool", primary: "Read file", secondary: "src/routes/settings.tsx", status: "completed" }], message: reply, startedAt: at - 90_000, endedAt: at - 20_000 }] },
      ],
    };
    localStorage.setItem(`${prefix}/chats`, JSON.stringify(store));
    const recents = JSON.parse(localStorage.getItem(`${prefix}/recents`) || "[]");
    localStorage.setItem(`${prefix}/recents`, JSON.stringify([{ id, label: "Harness short run" }, ...recents]));
  }, [accountKey, REPLY, STEPS, STOPPED_ID, base]);
  await page.reload({ waitUntil: "domcontentloaded" });

  const turn = page.locator(`[id="msg-${STOPPED_ID}"]`);
  await turn.getByText(REPLY, { exact: true }).waitFor({ timeout: 30_000 });
  const body = await page.evaluate(() => document.body.innerText);
  for (const phrase of CANNED) report(`no canned sentence on screen (${phrase})`, !body.includes(phrase));

  report("the reply names each step the run never reached",
    (await turn.getByText(STEPS[0]).count()) === 1 && (await turn.getByText(STEPS[1]).count()) === 1,
    await turn.innerText().catch(() => ""));

  const pill = turn.getByRole("button", { name: "Pick it back up" });
  report("a control offers to carry the work on", (await pill.count()) === 1);
  const styles = await pill.evaluate((node) => { const c = getComputedStyle(node); return { background: c.backgroundColor, color: c.color, radius: c.borderRadius }; }).catch(() => null);
  report(`the control is the milky pressable style (${JSON.stringify(styles)})`,
    styles?.background === "rgb(245, 240, 232)" && styles?.color === "rgb(26, 21, 18)");

  await page.screenshot({ path: path.join(out, "stopped-short.png"), animations: "disabled" });

  const beforeIds = await page.evaluate(() => [...document.querySelectorAll('[id^="msg-"]')].map((node) => node.id));
  await pill.click();
  await turn.getByRole("button", { name: "Pick it back up" }).waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1_000);
  // Reading the bubbles by id is the whole point of this half: a press that starts a NEW user
  // message is exactly what the user said must not happen — the run carries on where it stopped.
  const bubbles = await page.evaluate(() => [...document.querySelectorAll('[id^="msg-"]')].map((node) => ({ id: node.id, text: node.innerText })));
  await fs.writeFile(path.join(out, "after-resume.json"), JSON.stringify(bubbles, null, 2));
  const afterIds = bubbles.map((bubble) => bubble.id);
  report(`no new message appeared when it was picked back up (${beforeIds.length} before, ${afterIds.length} after)`,
    beforeIds.length === afterIds.length && beforeIds.every((id, position) => afterIds[position] === id));
  report("the resume brief never reaches the screen as a bubble",
    !bubbles.some((bubble) => /Continue the task below inside this same run/.test(bubble.text)));
  const resumed = bubbles.find((bubble) => bubble.id === `msg-${STOPPED_ID}`)?.text ?? "";
  report(`the stopped turn is working again and kept its earlier round (${resumed.slice(0, 120).replace(/\s+/g, " ")})`,
    resumed.includes(REPLY) && /Thinking|working|ran |read |Read/i.test(resumed) && !/Pick it back up/.test(resumed));

  const stop = page.getByRole("button", { name: "Stop task" });
  report("the restarted run is stoppable like any turn", (await stop.count()) === 1);
  if (await stop.count()) await stop.click().catch(() => {});
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: path.join(out, "resumed-in-place.png"), animations: "disabled" }).catch(() => {});
} catch (error) {
  report(`harness stopped: ${String(error.message).split("\n")[0].slice(0, 160)}`, false);
  if (page) await page.screenshot({ path: path.join(out, "failure.png"), animations: "disabled" }).catch(() => {});
} finally {
  if (page && accountKey) await page.evaluate(([prefix, saved]) => {
    for (const [name, value] of Object.entries(saved)) { if (value === null) localStorage.removeItem(`${prefix}/${name}`); else localStorage.setItem(`${prefix}/${name}`, value); }
  }, [accountKey, savedAccount]).catch(() => {});
  await app.close();
}

const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks: checks.map(([label, ok]) => [label, Boolean(ok)]) }, null, 2));
process.exit(failed.length ? 1 : 0);
