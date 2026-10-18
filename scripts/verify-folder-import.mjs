// Proves Calvras opens a folder the user picked straight off their disk — an empty one, and one
// far past the old 2,000-file cap — without copying it, and refuses the paths it should refuse.
// The native dialog is stubbed in the main process so the run is unattended; everything after the
// click is the real app, real HTTP and real disk.
import { _electron as electron } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const out = ".agents/artifacts/folder-import";
await fs.promises.mkdir(out, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
const checks = [];
const report = (label, ok, detail = "") => { checks.push([label, ok]); console.log(`${ok ? "PASS" : "FAIL"} — ${label}${detail ? ` :: ${detail}` : ""}`); };

const stamp = Date.now().toString(36);
const tmp = (name) => path.join(os.tmpdir(), `calvras-${name}-${stamp}`);
const emptyDir = tmp("empty");
const bigDir = tmp("big");
fs.mkdirSync(emptyDir, { recursive: true });
fs.mkdirSync(path.join(bigDir, "src", "components"), { recursive: true });
fs.writeFileSync(path.join(bigDir, "index.html"), "<h1>portfolio</h1>");
fs.writeFileSync(path.join(bigDir, "src", "app.ts"), "export const name = 'Iyana';");
for (let i = 0; i < 2_100; i++) fs.writeFileSync(path.join(bigDir, "src", "components", `c${i}.tsx`), "x");
const bigCount = fs.readdirSync(path.join(bigDir, "src", "components")).length;

let page;
const saved = {};
try {
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });
  for (const key of ["calvras_chat_messages", "calvras_projects", "calvras_active_project"]) {
    saved[key] = await page.evaluate((k) => localStorage.getItem(k), key);
  }

  // A chat already underway is the state where the folder must not be changeable in place.
  await page.evaluate((at) => {
    localStorage.setItem("calvras_chat_messages", JSON.stringify([{ id: at, text: "hi", role: "user", done: true, status: "finished", phases: [] }]));
    localStorage.removeItem("calvras_active_project");
  }, Date.now());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });

  // app.evaluate scopes globalThis per call, so the picked path is baked into the stub itself.
  const stubPicker = (target) => app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, target);
  const activeProject = () => page.evaluate(() => JSON.parse(localStorage.getItem("calvras_active_project") || "{}")?.path ?? "");
  const folderAlert = async () => (await page.getByRole("alert").first().textContent().catch(() => "") ?? "").trim();
  // Only the composer chip carries a title attribute, so this cannot hit the sidebar or settings list.
  const folderChip = (name) => page.locator("button[title]").filter({ hasText: name });
  const pickFolder = async (source, button) => {
    await stubPicker(source);
    await page.getByRole("button", { name: button }).click();
    const name = path.basename(source);
    await folderChip(name).waitFor({ timeout: 20_000 });
    return { name, projectPath: await activeProject(), error: await folderAlert() };
  };
  // Once a folder is open the control lives in the chip's menu instead.
  const changeFolder = async (source) => {
    await stubPicker(source);
    const before = await activeProject();
    await folderChip(path.basename(before)).click();
    await page.getByRole("menuitem", { name: /Choose a new folder/ }).click();
    await page.waitForFunction((old) => document.querySelector('[role="alert"]')?.textContent || old !== (window.localStorage.getItem("calvras_active_project") || "{}"), before, { timeout: 20_000 }).catch(() => {});
    return { projectPath: await activeProject(), error: await folderAlert() };
  };

  report("a running chat offers a folder only through a new chat",
    (await page.getByRole("button", { name: "Add a folder in a new chat" }).count()) === 1 &&
    (await page.getByRole("button", { name: /^Add a folder$/ }).count()) === 0);

  const empty = await pickFolder(emptyDir, "Add a folder in a new chat");
  report(`the empty folder opened as a project (${empty.name})`, empty.error === "" && Boolean(empty.projectPath) && fs.existsSync(empty.projectPath));
  report("it is the folder on disk, not a copy under Calvras Imports", empty.projectPath === emptyDir);
  report("the chat that started it is now empty, so the folder is editable again",
    (await page.evaluate(() => localStorage.getItem("calvras_chat_messages"))) === null);
  await page.screenshot({ path: path.join(out, "empty-folder-opened.png"), animations: "disabled" });

  const big = await changeFolder(bigDir);
  report(`a folder with ${bigCount + 2} files opened with no cap complaint (${big.error || "clean"})`, big.error === "" && big.projectPath === bigDir);
  report("nothing was copied into Calvras Imports for it",
    !fs.existsSync(path.join(os.homedir(), "Desktop", "Calvras Imports", `calvras-big-${stamp}-`)));
  report("the real files are still exactly where they were",
    fs.readFileSync(path.join(bigDir, "src", "app.ts"), "utf8") === "export const name = 'Iyana';" &&
    fs.readdirSync(path.join(bigDir, "src", "components")).length === bigCount);
  await page.screenshot({ path: path.join(out, "big-folder-opened.png"), animations: "disabled" });

  // A path that is not one of the user's project folders must be refused out loud, not silently.
  const fileRefusal = await changeFolder(path.join(bigDir, "index.html"));
  report(`a file instead of a folder is refused in words (${fileRefusal.error.slice(0, 48)})`, /not a folder/i.test(fileRefusal.error));
  report("and the working folder never moved", fileRefusal.projectPath === bigDir);

  const broadRefusal = await changeFolder(os.homedir());
  report(`the whole user folder is refused (${broadRefusal.error.slice(0, 48)})`, /whole user folder/i.test(broadRefusal.error));
  report("and the working folder is still the real project", broadRefusal.projectPath === bigDir);
  await page.screenshot({ path: path.join(out, "refusals.png"), animations: "disabled" });
} finally {
  for (const [key, value] of Object.entries(saved)) {
    await page?.evaluate(([k, v]) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }, [key, value]).catch(() => {});
  }
  await fs.promises.rm(emptyDir, { recursive: true, force: true });
  await fs.promises.rm(bigDir, { recursive: true, force: true });
  await app.close().catch(() => {});
}

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
