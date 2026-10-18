// Proves the four capabilities added on top of the single-turn agent, on the real rendered app:
// per-role subagent engines in Settings, durable appointments in the task panel, and the
// module-level knowledge tools driving a live turn.
// Nothing here asserts a sentence the app did not produce: the seeded ledger entries are written
// in exactly the shape addSchedule stores, and every knowledge claim is checked against the
// .calvras/knowledge.json the runtime itself wrote. Run with --no-live to skip the real turn.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import fss from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

const LIVE = !process.argv.includes("--no-live");
const out = ".agents/artifacts/agent-upgrades";
await fs.mkdir(out, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
const checks = [];
const report = (label, ok, detail = "") => { checks.push([label, ok]); console.log(`${ok ? "PASS" : "FAIL"} — ${label}${detail ? ` :: ${detail.slice(0, 320)}` : ""}`); };
/** A picture of the app is evidence, not a verdict: a repaint can time the capture out. */
const shot = async (name) => {
  try { await page.screenshot({ path: path.join(out, `${name}.png`), animations: "disabled", timeout: 10_000 }); }
  catch { console.log(`note: the ${name} screenshot timed out; the checks above still stand`); }
};

const KEYS = ["calvras_preferences", "calvras_projects", "calvras_active_project", "calvras_access_mode", "calvras_chat_messages"];
const saved = {};
let page;
let workspace = "";
try {
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });
  for (const key of KEYS) saved[key] = await page.evaluate((name) => localStorage.getItem(name), key);

  // --- Settings: one engine choice per worker role -------------------------------------------
  await page.getByRole("button", { name: "Settings" }).click();
  const engines = page.getByText("Subagent engines", { exact: true });
  await engines.waitFor({ timeout: 30_000 });
  const builderEffort = page.getByLabel("Implementation worker effort");
  const builderModel = page.getByLabel("Implementation worker model");
  const controls = {
    efforts: await page.locator('select[aria-label$="worker effort"]').count(),
    models: await page.locator('input[aria-label$="worker model"]').count(),
  };
  report(`three roles each get an effort and a model control (got ${JSON.stringify(controls)})`, controls.efforts === 3 && controls.models === 3);
  await builderEffort.selectOption("Thorough");
  await builderModel.fill("gemini-2.0-flash");
  await page.getByLabel("Research worker effort").selectOption("Quick");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("calvras_preferences") || "{}"));
  report("the choice is saved per role, not as one global setting", stored.workerRouting?.builder?.effort === "Thorough" && stored.workerRouting?.builder?.model === "gemini-2.0-flash" && stored.workerRouting?.researcher?.effort === "Quick", JSON.stringify(stored.workerRouting));
  // A model name too long or a blank one must not reach the runtime as a pinned engine.
  // A model field emptied out must come back as no pinned engine, not as the spaces typed in.
  await builderModel.fill("   ");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Settings" }).click();
  await engines.waitFor({ timeout: 30_000 });
  const blanked = {
    model: await page.getByLabel("Implementation worker model").inputValue(),
    effort: await page.getByLabel("Implementation worker effort").inputValue(),
  };
  report("blanking the model puts the role back on the cascade and keeps its effort", blanked.model === "" && blanked.effort === "Thorough", JSON.stringify(blanked));
  await shot("settings-engines");
  await page.keyboard.press("Escape");

  // --- A project folder, full access ---------------------------------------------------------
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-upgrades-"));
  const write = async (rel, content) => {
    const file = path.join(workspace, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
  };
  await write("package.json", JSON.stringify({ name: "upgrade-fixture" }));
  await write("src/util/format.ts", "export function format(value: number) {\n  return String(value);\n}\n");
  await write("src/data/store.ts", 'import { format } from "../util/format";\nexport function createStore() {\n  return { label: format(1) };\n}\n');
  await write("src/data/read.ts", 'import { createStore } from "./store";\nexport function readAll() {\n  return createStore();\n}\n');
  await write("src/ui/Panel.tsx", 'import { readAll } from "@/data/read";\nexport function Panel() {\n  readAll();\n  return null;\n}\n');
  await write("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }));

  // An appointment in the exact shape schedule_run stores, so the panel is reading a real ledger.
  // Four hours out keeps it safely unclaimed while the harness runs.
  const slot = new Date(Date.now() + 4 * 3_600_000);
  const timeOfDay = `${String(slot.getHours()).padStart(2, "0")}:${String(slot.getMinutes()).padStart(2, "0")}`;
  const label = `Every day at ${timeOfDay}`;
  const entry = {
    id: "harness-daily", prompt: "Summarise what changed today.", kind: "daily", timeOfDay,
    mode: "automatic", enabled: true, createdAt: new Date().toISOString(), nextRunAt: slot.getTime(), runs: [],
  };
  await fs.mkdir(path.join(workspace, ".calvras"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".calvras", "schedule.json"), JSON.stringify({ entries: [entry] }, null, 2), "utf8");

  await page.evaluate(([dir]) => {
    const project = { name: "upgrade-fixture", path: dir };
    localStorage.setItem("calvras_projects", JSON.stringify([project]));
    localStorage.setItem("calvras_active_project", JSON.stringify(project));
    localStorage.setItem("calvras_access_mode", "full");
    localStorage.setItem("calvras_chat_messages", "[]");
  }, [workspace]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });

  // --- The task panel shows the stored appointment and can pause it --------------------------
  await page.getByRole("button", { name: "Tasks" }).click();
  const section = page.locator('section[aria-label="Scheduled work"]');
  await section.waitFor({ timeout: 30_000 });
  const line = section.locator("p", { hasText: label }).first();
  await line.waitFor({ timeout: 15_000 });
  const shown = (await line.textContent()).replace(/\s+/g, " ");
  report(`the panel says back what the ledger holds (${shown})`, shown.includes(label) && /(In \d+ (minutes|hours)|Overdue)/.test(shown));
  await section.getByRole("button", { name: new RegExp(`Pause ${label}`) }).click();
  await page.waitForTimeout(1_200);
  const pausedRow = await line.textContent();
  const afterPause = JSON.parse(await fs.readFile(path.join(workspace, ".calvras", "schedule.json"), "utf8"));
  report("pausing writes the ledger, not just the panel", afterPause.entries[0].enabled === false && /Paused/.test(pausedRow || ""), `${pausedRow?.replace(/\s+/g, " ")} :: enabled=${afterPause.entries[0].enabled}`);
  await section.getByRole("button", { name: new RegExp(`Resume ${label}`) }).click();
  await page.waitForTimeout(1_200);
  const afterResume = JSON.parse(await fs.readFile(path.join(workspace, ".calvras", "schedule.json"), "utf8"));
  report("resuming puts a real future time on the entry", afterResume.entries[0].enabled === true && afterResume.entries[0].nextRunAt > Date.now(), `nextRunAt in ${Math.round((afterResume.entries[0].nextRunAt - Date.now()) / 60_000)} minutes`);
  await shot("scheduled-panel");

  if (LIVE) {
    console.log("live phase: driving one real turn that uses the knowledge tools");
    const composer = page.getByRole("textbox", { name: "Prompt" });
    await composer.fill("Do this in order, one tool call each: build_knowledge for this folder, then search_knowledge with the query \"store\", then read_module with the name of the module it matched. Finish by telling me how many module cards the folder has and which module the query matched.");
    await page.keyboard.press("Enter");

    const turn = page.locator('[id^="msg-"]').last();
    let finished = 0;
    for (let attempt = 0; attempt < 120; attempt++) {
      await page.waitForTimeout(2_000);
      finished = await turn.getByRole("button", { name: /Copy reply/ }).count();
      if (attempt % 15 === 0) {
        const step = await turn.innerText({ timeout: 1_500 }).catch(() => "");
        console.log(`live phase: waiting for the turn to finish (attempt ${attempt}) :: ${step.replace(/\s+/g, " ").slice(-240)}`);
      }
      if (finished) break;
    }
    report(`the live turn reached a finished reply (${finished} action buttons)`, finished > 0);

    for (let pass = 0; pass < 4; pass++) {
      const closed = await turn.locator('[aria-expanded="false"]').all();
      for (const handle of closed) await handle.click({ timeout: 1_000 }).catch(() => {});
      await page.waitForTimeout(250);
    }
    const turnText = (await turn.innerText({ timeout: 5_000 }).catch(() => "")).replace(/\s+/g, " ");
    // A row's words are the model's own intent, so the structure is what this checks: the turn
    // must render the steps it claims, and the runtime's operation log is what proves each call
    // really executed.
    const rows = await turn.locator('button[aria-expanded]').count();
    report(`the finished turn renders its step rows (${rows} expandable rows)`, rows >= 3, turnText.slice(0, 200));
    report("a row names the module work it did", /module|knowledge/i.test(turnText), turnText.slice(-240));
    report("the finished turn names no model behind it", (await turn.getByText(/^Answered by /).count()) === 0 && !/restricted|conversation-only/i.test(turnText));

    const rootReal = fss.realpathSync(path.resolve(workspace));
    const stateFile = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "Calvras", "projects", createHash("sha256").update(rootReal).digest("hex"), "state.json");
    let ops = null;
    try { ops = JSON.parse(await fs.readFile(stateFile, "utf8")).logs.filter((log) => ["build_knowledge", "search_knowledge", "read_module"].includes(log.tool)); } catch { ops = null; }
    report(`the runtime logged each knowledge call it ran (${(ops || []).map((log) => `${log.tool}=${log.ok}`).join(", ") || "no operation log"})`, Array.isArray(ops) && ["build_knowledge", "search_knowledge", "read_module"].every((tool) => ops.some((log) => log.tool === tool && log.ok === true)), stateFile);

    // The ledger the runtime wrote is the only proof the cards are real.
    let base = null;
    try { base = JSON.parse(await fs.readFile(path.join(workspace, ".calvras", "knowledge.json"), "utf8")); } catch { report("the build wrote .calvras/knowledge.json", false, "no ledger file"); }
    if (base) {
      const names = base.modules.map((module) => module.name);
      report(`the ledger holds ${base.modules.length} module cards (${names.join(", ")})`, base.modules.length >= 4 && names.includes("src/data"));
      const card = base.modules.find((module) => module.name === "src/data");
      report("a card's files are files that really sit in the folder", card.files.every((file) => file.startsWith("src/data/")), JSON.stringify(card.files));
      report("a card's imports were read out of those files", card.dependsOn.includes("src/util"), JSON.stringify(card.dependsOn));
      // A reply that claims a card count must agree with the ledger, or the number was invented.
      const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
      let claimed = NaN;
      const digits = turnText.match(/(\d+)\s+(?:module cards?|modules)\b/);
      if (digits) claimed = Number(digits[1]);
      else {
        for (const [word, value] of Object.entries(words)) {
          if (new RegExp(`\\b${word}\\b[^.\\n]{0,16}?\\bmodule`, "i").test(turnText)) { claimed = value; break; }
        }
      }
      report(`the reply's card count matches the ledger (said ${claimed}, ledger ${base.modules.length})`, claimed === base.modules.length, turnText.slice(-260));
      report("the reply names the module the search matched", /src\/data/.test(turnText), turnText.slice(-200));
    }
    await shot("live-knowledge-turn");
  }
} finally {
  for (const key of KEYS) {
    await page?.evaluate(([name, value]) => {
      if (value === null) localStorage.removeItem(name); else localStorage.setItem(name, value);
    }, [key, saved[key]]).catch(() => {});
  }
  await app.close().catch(() => {});
  if (workspace) await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
}

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
