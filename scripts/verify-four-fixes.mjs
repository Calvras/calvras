// Proves the four reported fixes in the rendered desktop app:
//   1. no light Windows scrollbar gutter inside the sidebar,
//   2. Settings > Clear conversations survives leaving the page AND restarting the app,
//   3. clicking a History row loads that conversation's own transcript back,
//   4. the terminal is a real bottom-docked shell printing this machine's banner and live output.
// The account's stored chats are backed up first and written back at the end.
import { _electron as electron } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";

const OUT = ".agents/artifacts/four-fixes";
await fs.mkdir(OUT, { recursive: true });

const results = { passed: [], failed: [] };
const record = (label, ok, detail = "") => {
  results[ok ? "passed" : "failed"].push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const launch = () => electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: ["."],
  env,
  timeout: 60_000,
});

let app = await launch();
let page = await app.firstWindow();
const openWorkspace = async () => {
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 60_000 });
};
await openWorkspace();

const accountKey = await page.evaluate(() => {
  const user = JSON.parse(localStorage.getItem("calvras_user") || "null");
  return user?.email ? `calvras/account/${user.email.toLowerCase()}` : null;
});
if (!accountKey) {
  console.log("ABORT: the app is not signed in, so there is no account shelf to test.");
  await app.close();
  process.exit(1);
}
const readStorage = () => page.evaluate((prefix) => ({
  chats: localStorage.getItem(`${prefix}/chats`),
  recents: localStorage.getItem(`${prefix}/recents`),
  projects: localStorage.getItem(`${prefix}/projects`),
}), accountKey);
const before = await readStorage();
await fs.writeFile(path.join(OUT, "storage.before.json"), JSON.stringify(before, null, 2));

// Locators are bound to the page they came from and this harness restarts the app on purpose,
// so every relaunch has to re-point them.
let sidebar = page.getByRole("complementary", { name: "History sidebar" });
const attach = () => { sidebar = page.getByRole("complementary", { name: "History sidebar" }); };
const openHistory = async () => {
  await page.getByRole("button", { name: "Chat history", exact: true }).click();
  await sidebar.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(400);
};
const conversationText = () => page.evaluate(() => document.querySelector('[aria-label="Conversation"]')?.innerText ?? "");

// ---- seed the account's shelf so every phase below has something to act on ------------------
const needle = `HARNESS-RELOAD-${Date.now()}`;
const seedLabel = "Harness reload check";
await page.evaluate(([prefix, label, text]) => {
  const store = JSON.parse(localStorage.getItem(`${prefix}/chats`) || "{}");
  const now = Date.now();
  // Enough rows that the list genuinely scrolls, otherwise the gutter under test stays empty.
  for (let i = 0; i < 24; i++) {
    const id = `harness-filler-${i}`;
    store[id] = { id, label: `Harness filler ${i}`, savedAt: now - 10_000 * (i + 2), messages: [{ id: 1, role: "user", text: `filler ${i}`, done: true, phases: [] }] };
  }
  const id = `harness-${now}`;
  store[id] = {
    id,
    label,
    savedAt: now,
    messages: [
      { id: 1, role: "user", text, done: true, phases: [] },
      { id: 2, role: "assistant", text: "", done: true, phases: [{ message: "That is the conversation the harness stored.", trace: [], startedAt: now, endedAt: now }] },
    ],
  };
  localStorage.setItem(`${prefix}/chats`, JSON.stringify(store));
}, [accountKey, seedLabel, needle]);
await page.reload({ waitUntil: "domcontentloaded" });
await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 60_000 });

// ---- 1. the scrollbar gutter -------------------------------------------------------------
await openHistory();
const overflow = await sidebar.evaluate((panel) => {
  const scroller = panel.querySelector(".overflow-y-auto");
  return scroller ? { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : null;
});
record("the History list is long enough to need a scrollbar", overflow.scrollHeight > overflow.clientHeight + 40, `${overflow.scrollHeight} > ${overflow.clientHeight}`);
await sidebar.getByText(seedLabel).scrollIntoViewIfNeeded();
const scrollerStyle = await sidebar.evaluate((panel) => {
  const scroller = panel.querySelector(".overflow-y-auto");
  if (!scroller) return null;
  const cs = getComputedStyle(scroller);
  return {
    scrollbarWidth: cs.scrollbarWidth,
    scrollbarColor: cs.scrollbarColor,
    buttonDisplay: getComputedStyle(scroller, "::-webkit-scrollbar-button").display,
    trackBackground: getComputedStyle(scroller, "::-webkit-scrollbar-track").backgroundColor,
  };
});
record("sidebar scroller uses the thin dark rule", scrollerStyle?.scrollbarWidth === "thin" && !/rgb\(2[0-9]{2}/.test(scrollerStyle.scrollbarColor), JSON.stringify(scrollerStyle));
record("scrollbar arrow buttons are gone", scrollerStyle?.buttonDisplay === "none", scrollerStyle ? `display:${scrollerStyle.buttonDisplay} track:${scrollerStyle.trackBackground}` : "no scroller");

// The complaint was about the light gutter that gets painted, so the window itself is under test.
const gutter = await sidebar.evaluate((panel) => {
  const box = panel.getBoundingClientRect();
  return { x: box.x, y: box.y, width: box.width, height: box.height };
});
const shot = await app.evaluate(async ({ BrowserWindow }, wanted) => {
  const win = BrowserWindow.getAllWindows()[0];
  const [dipWidth] = win.getContentSize();
  const image = await win.webContents.capturePage();
  const size = image.getSize();
  const scale = size.width / dipWidth;
  const bitmap = new Uint8Array(image.getBitmap());
  let windowMax = 0;
  for (let i = 0; i < bitmap.length; i += 4 * 97) windowMax = Math.max(windowMax, bitmap[i + 2]);
  const columnStart = Math.round((wanted.x + wanted.width - 13 * scale) * scale);
  const columnEnd = Math.round((wanted.x + wanted.width) * scale);
  const rowStart = Math.round(wanted.y * scale);
  const rowEnd = Math.round((wanted.y + wanted.height) * scale);
  let light = 0, sampled = 0, brightest = 0;
  for (let y = rowStart; y < rowEnd; y++) {
    for (let x = columnStart; x < columnEnd; x++) {
      const i = (y * size.width + x) * 4;
      const max = Math.max(bitmap[i], bitmap[i + 1], bitmap[i + 2]);
      sampled++;
      if (max > brightest) brightest = max;
      if (bitmap[i] > 150 && bitmap[i + 1] > 150 && bitmap[i + 2] > 150) light++;
    }
  }
  return { light, sampled, brightest, windowMax, scale };
}, gutter);
await fs.writeFile(path.join(OUT, "sidebar.png"), await sidebar.screenshot());
record("the capture really shows the app", shot.windowMax > 150, `brightest channel ${shot.windowMax}`);
record("no light scrollbar gutter painted beside the sidebar", shot.light === 0, `brightest ${shot.brightest}/255, ${shot.light}/${shot.sampled} light px, scale ${shot.scale.toFixed(2)}`);
// Positive control: the scroller is there, it is just a quiet dark thumb instead of a white one.
record("the scrollbar that is painted is the quiet dark one", shot.brightest > 55 && shot.brightest < 135, `thumb peaks at ${shot.brightest}/255 over a ${40}/255 panel`);

// ---- 3. clicking a History row loads that transcript back ---------------------------------
await page.getByRole("button", { name: "Calvras home", exact: true }).click();
await page.waitForTimeout(800);
const emptied = await conversationText();
record("starting a new conversation clears the screen", !emptied.includes(needle), `${emptied.length} chars on screen`);

await openHistory();
const rows = await sidebar.locator(".sidebar-row").count();
record("History lists the conversations", rows > 0, `${rows} row(s)`);
await sidebar.locator(".sidebar-row", { hasText: seedLabel }).first().click();
await page.waitForTimeout(1_500);
const reloaded = await conversationText();
record("clicking a previous chat loads its transcript back", reloaded.includes(needle), needle);
await page.screenshot({ path: path.join(OUT, "loaded-chat.png") });

// ---- 2. Clear conversations really clears --------------------------------------------------
await page.getByRole("button", { name: "Settings", exact: true }).click();
await page.getByRole("button", { name: "History and memory" }).waitFor({ timeout: 10_000 });
await page.getByRole("button", { name: "History and memory" }).click();
const conversationRow = page.locator(".settings-row", { has: page.getByRole("heading", { name: "Conversations" }) });
await conversationRow.waitFor({ timeout: 10_000 });
const clearButton = conversationRow.locator("button.settings-danger");
record("the Conversations row offers an enabled Clear", await clearButton.count() === 1 && await clearButton.first().isEnabled(), `${await clearButton.count()} button(s)`);
await clearButton.first().click();
await page.getByText("Conversation list cleared.").waitFor({ timeout: 10_000 });
await page.waitForTimeout(1_000);

const afterClear = await readStorage();
record("Clear empties the stored transcript map", afterClear.chats === "{}" || afterClear.chats === null, `stored: ${String(afterClear.chats).slice(0, 90)}`);
await page.getByRole("button", { name: "Close settings" }).click();
await page.locator(".settings-screen").waitFor({ state: "detached", timeout: 10_000 });
await openHistory();
const rowsAfterClear = await sidebar.locator(".sidebar-row").count();
const emptyNote = await sidebar.getByText("Your conversations will appear here.").count();
record("the sidebar shows nothing after clearing", rowsAfterClear === 0 && emptyNote === 1, `${rowsAfterClear} row(s), empty note ${emptyNote}`);

// "I came back and still saw them" — so come back the way the user does: quit and reopen.
await fs.writeFile(path.join(OUT, "storage.after-clear.json"), JSON.stringify(afterClear, null, 2));
await app.close();
app = await launch();
page = await app.firstWindow();
attach();
await openWorkspace();
const onDisk = await readStorage();
record("the cleared history is still gone after a restart", onDisk.chats === "{}" || onDisk.chats === null, `stored: ${String(onDisk.chats).slice(0, 90)}`);
await page.getByRole("button", { name: "Chat history", exact: true }).click();
await sidebar.waitFor({ timeout: 10_000 });
const ghostRows = await sidebar.locator(".sidebar-row").count();
record("no ghost rows after restarting the app", ghostRows === 0, `${ghostRows} row(s)`);
await page.screenshot({ path: path.join(OUT, "after-restart.png") });
await page.getByRole("button", { name: "Close sidebar" }).click();

// ---- 4. the bottom terminal is a real shell -------------------------------------------------
const project = await page.evaluate((prefix) => JSON.parse(localStorage.getItem(`${prefix}/activeProject`) || "null"), accountKey);
if (!project?.path) console.log("NOTE: no folder is active, so the terminal has nowhere to start.");
await page.getByRole("button", { name: "Show terminal" }).click();
const panel = page.locator(".terminal-panel");
await panel.waitFor({ timeout: 20_000 });
const box = await panel.boundingBox();
// The shell is a card inset in the window chrome, so "bottom" means the card's bottom edge.
const card = await page.evaluate(() => { const r = document.querySelector(".chat-page").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
record("the terminal docks to the bottom of the conversation card", Boolean(box) && Math.abs(box.y + box.height - (card.y + card.height)) < 4 && Math.abs(box.x - card.x) < 4 && Math.abs(box.width - card.width) < 4 && box.height > 160, box ? `y=${Math.round(box.y)} h=${Math.round(box.height)} card=${Math.round(card.y + card.height)} viewport=${viewport.height}` : "no box");

const log = panel.getByRole("log");
let transcript = "";
for (let i = 0; i < 30; i++) {
  transcript = await log.innerText();
  if (/Microsoft Windows \[Version/.test(transcript)) break;
  await page.waitForTimeout(500);
}
record("the panel prints the machine's real shell banner", /Microsoft Windows \[Version \d+\.\d+\.\d+/.test(transcript), JSON.stringify(transcript.slice(0, 130)));
record("the panel reports the shell as live", await panel.getByText("live", { exact: true }).count() === 1, transcript.slice(0, 40));

const field = panel.getByLabel("Terminal command");
for (let i = 0; i < 50 && !(await field.isEnabled()); i++) await page.waitForTimeout(300);
record("the command line is open for typing", await field.isEnabled(), `placeholder "${await field.getAttribute("placeholder")}"`);
const marker = `CALVRAS-LIVE-${Date.now()}`;
await field.fill(`echo ${marker}`);
await field.press("Enter");
let sawLive = "";
for (let i = 0; i < 20; i++) {
  sawLive = await log.innerText();
  if (sawLive.includes(marker)) break;
  await page.waitForTimeout(500);
}
record("a typed command runs in that shell and its output streams back", sawLive.includes(marker), sawLive.includes(marker) ? marker : sawLive.slice(-160));

// A live shell keeps its own directory; a one-shot exec endpoint cannot.
await field.fill("echo %CD%");
await field.press("Enter");
await page.waitForTimeout(1_500);
const withCwd = await log.innerText();
record("the shell answers in a real working directory", /C:\\Users\\darka/i.test(withCwd), JSON.stringify(withCwd.split("\n").slice(-3)));

await field.fill("cd C:\\Users\\darka\\Desktop\\Calvras\\scripts");
await field.press("Enter");
await page.waitForTimeout(1_200);
await field.fill("echo %CD%");
await field.press("Enter");
await page.waitForTimeout(1_500);
const afterCd = await log.innerText();
record("cd sticks in the same session", /Desktop\\Calvras\\scripts/i.test(afterCd.split("\n").slice(-4).join("\n")), JSON.stringify(afterCd.split("\n").slice(-3)));

await field.fill("dir /b");
await field.press("Enter");
await page.waitForTimeout(2_500);
const afterDir = await log.innerText();
record("a real command lists real files", /verify-four-fixes\.mjs/.test(afterDir), `${afterDir.length} chars of output`);
await page.screenshot({ path: path.join(OUT, "terminal.png") });

// The dock must not still own a copy of the terminal.
await page.getByRole("button", { name: "Workspace files" }).click();
await page.waitForTimeout(700);
const dockTerminalTab = await page.getByRole("tab", { name: "Terminal" }).count();
record("the shell left the right dock", dockTerminalTab === 0, `${dockTerminalTab} dock tab(s)`);

await app.close();

// ---- restore the account's own data --------------------------------------------------------
app = await launch();
page = await app.firstWindow();
attach();
await openWorkspace();
await page.evaluate(([prefix, snapshot]) => {
  const restore = (name, value) => { if (value === null) localStorage.removeItem(`${prefix}/${name}`); else localStorage.setItem(`${prefix}/${name}`, value); };
  restore("chats", snapshot.chats);
  restore("recents", snapshot.recents);
  restore("projects", snapshot.projects);
}, [accountKey, before]);
await page.reload({ waitUntil: "domcontentloaded" });
await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 60_000 });
const restored = await readStorage();
record("the account's own history is back the way it was", restored.chats === before.chats && restored.recents === before.recents);
await app.close();

await fs.writeFile(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\n${results.passed.length} passed, ${results.failed.length} failed`);
for (const failure of results.failed) console.log(`  FAILED: ${failure}`);
process.exitCode = results.failed.length ? 1 : 0;
