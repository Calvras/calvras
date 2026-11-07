// Proves the subagent trace rows and the full-screen Settings scrollbar on the real rendered app.
// The rows are seeded from the exact shape WorkerPool reports, so a row can only render for a job
// record the server would have produced; nothing here asserts a invented sentence.
// Run with --live to additionally drive one real turn through the app and watch a subagent tick.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const LIVE = process.argv.includes("--live");
const out = ".agents/artifacts/subagent-trace";
await fs.mkdir(out, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
const checks = [];
const report = (label, ok, detail = "") => { checks.push([label, ok]); console.log(`${ok ? "PASS" : "FAIL"} — ${label}${detail ? ` :: ${detail.slice(0, 300)}` : ""}`); };
/** A picture is evidence, not a verdict: a repaint can time the capture out and must never fail the run. */
const shot = async (name) => {
  try { await page.screenshot({ path: path.join(out, `${name}.png`), animations: "disabled", timeout: 10_000 }); }
  catch { console.log(`note: the ${name} screenshot timed out; the checks above still stand`); }
};

let page;
let savedChat = null;
let savedProjects = null;
let savedActive = null;
let savedMode = null;
let workspace = "";
try {
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });

  savedChat = await page.evaluate(() => localStorage.getItem("calvras_chat_messages"));
  savedProjects = await page.evaluate(() => localStorage.getItem("calvras_projects"));
  savedActive = await page.evaluate(() => localStorage.getItem("calvras_active_project"));
  savedMode = await page.evaluate(() => localStorage.getItem("calvras_access_mode"));

  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-subagents-"));
  await fs.writeFile(path.join(workspace, "notes.md"), "# Fixture\nThree tools are listed here.\n");

  const base = Date.now();
  const WITH_ID = base - 10;
  const WITHOUT_ID = base - 11;
  const SEARCH_ID = base - 12;
  const UPDATE = "read src/lib/tool-catalog.ts and counted the tool names";
  await page.evaluate(([at, withId, withoutId, withSearch, update]) => {
    localStorage.setItem("calvras_chat_messages", JSON.stringify([
      { id: at - 20, text: "split the audit across subagents", role: "user", done: true, status: "finished", phases: [] },
      {
        id: withId, text: "", role: "assistant", done: true, status: "finished", startedAt: at - 90_000, endedAt: at - 20_000,
        phases: [{ trace: [{ id: "d", type: "tool", primary: "Handing off a subtask", secondary: "researcher", status: "completed" }], message: "The audit ran in a subagent.", startedAt: at - 90_000, endedAt: at - 20_000 }],
        subagents: [
          { id: "job-1", role: "researcher", task: "Audit the tool list", status: "finished", startedAt: at - 80_000, endedAt: at - 40_000, updates: [update], result: "137 names, all with a dispatcher." },
          { id: "job-2", role: "builder", task: "Rewrite the sidebar", status: "blocked", startedAt: at - 40_000, endedAt: at - 35_000, updates: [] },
          { id: "job-3", role: "verifier", task: "Run the tests", status: "queued", updates: [] },
        ],
      },
      { id: at - 21, text: "no helpers this time", role: "user", done: true, status: "finished", phases: [] },
      {
        id: withSearch, text: "", role: "assistant", done: true, status: "finished", startedAt: at - 19_000, endedAt: at - 13_000,
        phases: [{
          trace: [{ id: "s", type: "search", primary: "Searched the web", secondary: "tanstack start", status: "completed", output: "DuckDuckGo returned 2 results for \"tanstack start\".", sources: [{ name: "TanStack Start", url: "https://tanstack.com/start" }, { name: "Docs", url: "https://tanstack.com/start/latest/docs" }] }],
          message: "TanStack Start is the full-stack framework.",
          startedAt: at - 19_000,
          endedAt: at - 13_000,
        }],
      },
      { id: withoutId, text: "", role: "assistant", done: true, status: "finished", startedAt: at - 18_000, endedAt: at - 12_000, phases: [{ trace: [], message: "Done without any subagent.", startedAt: at - 18_000, endedAt: at - 12_000 }] },
    ]));
  }, [base, WITH_ID, WITHOUT_ID, SEARCH_ID, UPDATE]);
  await page.reload({ waitUntil: "domcontentloaded" });

  const turn = page.locator(`[id="msg-${WITH_ID}"]`);
  await turn.getByText("The audit ran in a subagent.", { exact: true }).waitFor({ timeout: 30_000 });

  const researcher = turn.getByRole("button", { name: "Subagent researcher: Audit the tool list" });
  const builder = turn.getByRole("button", { name: "Subagent builder: Rewrite the sidebar" });
  const verifier = turn.getByRole("button", { name: "Subagent verifier: Run the tests" });
  report("one row per subagent the pool reported", (await researcher.count()) === 1 && (await builder.count()) === 1 && (await verifier.count()) === 1);
  report("a finished job states its real duration", (await researcher.textContent()).includes("Subagent finished in 40 seconds"), await researcher.textContent());
  report("a blocked job is not reported as finished", (await builder.textContent()).includes("Subagent blocked after 5 seconds"), await builder.textContent());
  report("a job that never started says queued", (await verifier.textContent()).includes("Queued"), await verifier.textContent());

  await researcher.click();
  await page.waitForTimeout(250);
  report("opening a row reveals the worker's own log line", (await turn.getByText(UPDATE, { exact: true }).count()) === 1);
  report("the row also reveals the worker's own final report", (await turn.getByText("137 names, all with a dispatcher.", { exact: true }).count()) === 1);
  report("a row with no log line has nothing to expand", (await builder.getAttribute("aria-expanded")) === "false" && (await builder.locator("svg").count()) === 0);
  // The avatar is generated from the role name, so every row must carry exactly one canvas.
  report("each subagent row carries its generated avatar", (await researcher.locator("canvas").count()) === 1 && (await builder.locator("canvas").count()) === 1 && (await verifier.locator("canvas").count()) === 1);
  await shot("subagent-rows");

  const cleanTurn = page.locator(`[id="msg-${WITHOUT_ID}"]`);
  await cleanTurn.getByText("Done without any subagent.", { exact: true }).waitFor({ timeout: 30_000 });
  report("a turn that ran no subagent renders no row", (await cleanTurn.getByRole("button", { name: /^Subagent / }).count()) === 0);

  // The reply never names the models behind it: a cascade the user cannot see or control is
  // not provenance, so no turn renders a model line, however its metadata was stored.
  report("a persisted turn names no model", (await turn.getByText(/^Answered by /).count()) === 0);
  report("a turn without subagents claims none", (await cleanTurn.getByText(/^Answered by /).count()) === 0);

  // A search row must show the sources the engine handed back, so the citations cannot be
  // invented by the model. This fixture is the exact node the runtime produces for web_search.
  const searchTurn = page.locator(`[id="msg-${SEARCH_ID}"]`);
  await searchTurn.getByText("TanStack Start is the full-stack framework.", { exact: true }).waitFor({ timeout: 30_000 });
  for (let pass = 0; pass < 3; pass++) {
    const closed = await searchTurn.locator('[aria-expanded="false"]').all();
    for (const handle of closed) await handle.click({ timeout: 1_500 }).catch(() => {});
    await page.waitForTimeout(200);
  }
  const seededChips = await searchTurn.locator('a[target="_blank"]').evaluateAll((links) => links.map((link) => ({ text: link.textContent.trim(), href: link.getAttribute("href") })));
  report("a search row renders one chip per source the engine returned", seededChips.some((chip) => chip.href === "https://tanstack.com/start") && seededChips.some((chip) => chip.href === "https://tanstack.com/start/latest/docs"), JSON.stringify(seededChips).slice(0, 240));

  // The full-screen Settings page must scroll without showing a right-hand scrollbar.
  await page.getByRole("button", { name: "Settings" }).click();
  const content = page.locator(".settings-content");
  await content.waitFor({ timeout: 30_000 });
  // Sub-pixel here is Windows display scaling, not a scrollbar gutter — a real one costs ~15px.
  const metrics = await content.evaluate((node) => {
    const style = getComputedStyle(node);
    const before = node.scrollTop;
    node.scrollTop = before + 400;
    const scrolled = node.scrollTop !== before;
    return {
      scrollbarWidth: style.scrollbarWidth,
      gutter: node.offsetWidth - node.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth),
      scrollable: node.scrollHeight > node.clientHeight,
      scrolled,
    };
  });
  report(`settings content hides its scrollbar but still scrolls (${JSON.stringify(metrics)})`, metrics.scrollbarWidth === "none" && Math.abs(metrics.gutter) < 1 && metrics.scrollable && metrics.scrolled);
  const railMetrics = await page.locator(".settings-rail").evaluate((node) => {
    const style = getComputedStyle(node);
    const chrome = node.offsetWidth - node.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
    return { scrollbarWidth: style.scrollbarWidth, gutter: chrome };
  });
  report(`the settings rail matches it (${JSON.stringify(railMetrics)})`, railMetrics.scrollbarWidth === "none" && Math.abs(railMetrics.gutter) < 1);
  await shot("settings-no-scrollbar");
  await page.keyboard.press("Escape");

  if (LIVE) {
    console.log("live phase: seeding a full-access project and driving one real turn");
    await page.getByRole("button", { name: "Projects" }).click();
    await page.evaluate(([dir]) => {
      const project = { name: "subagent-fixture", path: dir };
      localStorage.setItem("calvras_projects", JSON.stringify([project]));
      // The app stores the active project as a JSON object, not a bare path.
      localStorage.setItem("calvras_active_project", JSON.stringify(project));
      // readPreferences() compares this key verbatim, so it must be the bare word.
      localStorage.setItem("calvras_access_mode", "full");
      localStorage.setItem("calvras_chat_messages", "[]");
    }, [workspace]);
    await page.reload({ waitUntil: "domcontentloaded" });
    const composer = page.getByRole("textbox", { name: "Prompt" });
    await composer.waitFor({ timeout: 30_000 });
    await composer.fill("Use web_search once for \"Electron release notes\" and tell me the titles it returned. Then call delegate_task once with role \"researcher\" and task \"read notes.md in this workspace and report how many tools it names\". Then wait for that job with read_agent using its id and tell me what it found.");
    await page.keyboard.press("Enter");

    const rowQuery = page.locator('[id^="msg-"]').getByRole("button", { name: /^Subagent researcher/ });
    let running = null;
    for (let attempt = 0; attempt < 90; attempt++) {
      await page.waitForTimeout(2_000);
      running = await rowQuery.last().textContent({ timeout: 1_500 }).catch(() => null);
      if (attempt % 10 === 0) {
        const step = await page.locator('[id^="msg-"]').last().innerText({ timeout: 1_500 }).catch(() => "");
        console.log(`live phase: polling for the researcher row (attempt ${attempt}) :: ${step.replace(/\s+/g, " ").slice(-220)}`);
      }
      if (running) break;
    }
    report(`a live turn renders the running subagent row (${JSON.stringify(running)})`, Boolean(running) && /Subagent (running|finished)/.test(running));
    if (!running) throw new Error("the live turn never produced a researcher subagent row");
    // Read the figure from the row's own elapsed sentence, not from the first digit in the
    // text — the task title ("read notes.md") contains punctuation that would match a loose scan.
    // formatElapsed renders "7 seconds", "1 minute" and "1 min 30s", so parse all three shapes.
    const elapsed = (text) => {
      const phrase = text.match(/Subagent \w+ (?:for|in|after) (\d.+)$/)?.[1];
      const seconds = phrase?.match(/^(\d+) seconds?$/);
      if (seconds) return Number(seconds[1]);
      const minutes = phrase?.match(/^(\d+) minutes?$/);
      if (minutes) return Number(minutes[1]) * 60;
      const both = phrase?.match(/^(\d+) mins? (\d+)s$/);
      return both ? Number(both[1]) * 60 + Number(both[2]) : NaN;
    };
    const firstSeconds = elapsed(running);
    await page.waitForTimeout(5_000);
    const later = await rowQuery.last().textContent({ timeout: 3_000 }).catch(() => "");
    const laterSeconds = elapsed(later);
    report(`its elapsed time really ticks (${firstSeconds} → ${laterSeconds})`, Number.isFinite(laterSeconds) && (laterSeconds > firstSeconds || /finished/.test(later)));
    // The row's identity is the generated avatar, so the live row must carry a real canvas, not an icon.
    const avatar = await rowQuery.last().locator("canvas").count();
    report(`the live subagent row renders its generated avatar (${avatar} canvas)`, avatar >= 1);
    await shot("live-subagent");

    // The same live job has to surface in the workspace dock, not only in the trace.
    await page.getByRole("button", { name: "Workspace files" }).click();
    await page.locator('.browser-dock[data-open="true"]').waitFor({ timeout: 10_000 });
    const dockTabs = (await page.locator(".dock-tab").allInnerTexts()).map((text) => text.trim());
    const subagentTab = page.getByRole("tab", { name: "Subagents" });
    report(`the dock grows a Subagents tab while a job runs (${dockTabs.join(", ")})`, dockTabs.includes("Subagents") && (await subagentTab.count()) === 1);
    await subagentTab.click();
    const agentsPane = page.locator('[aria-label="Subagents"].dock-panel');
    await agentsPane.locator(".dock-item").first().waitFor({ timeout: 10_000 });
    const paneText = (await agentsPane.innerText()).replace(/\s+/g, " ");
    report(`the Subagents panel lists the worker roles and the real job (${paneText.slice(0, 150)})`,
      /Implementation/.test(paneText) && /Research & review/.test(paneText) && /read notes\.md/i.test(paneText));
    report("each dock subagent row carries a generated avatar", (await agentsPane.locator("canvas").count()) >= 1);
    await shot("dock-subagents");
    await page.keyboard.press("Escape");
    report("Escape slides the dock away without disturbing the running job", (await page.locator('.browser-dock[data-open="true"]').count()) === 0 && Boolean(await rowQuery.last().textContent({ timeout: 3_000 }).catch(() => null)));

    // A finished turn is the one that offers its reply actions; nothing else renders them.
    const turn = page.locator('[id^="msg-"]').last();
    let replyActions = 0;
    for (let attempt = 0; attempt < 90; attempt++) {
      replyActions = await turn.getByRole("button", { name: /Copy reply/ }).count();
      if (replyActions) break;
      await page.waitForTimeout(2_000);
    }
    report(`the live turn reaches a finished reply (${replyActions} action buttons)`, replyActions > 0);

    // Every web search this turn ran must carry the sources the engine actually returned.
    for (let pass = 0; pass < 4; pass++) {
      const closed = await turn.locator('[aria-expanded="false"]').all();
      for (const el of closed) await el.click({ timeout: 1_000 }).catch(() => {});
      await page.waitForTimeout(250);
    }
    const chips = await turn.locator('a[target="_blank"]').evaluateAll((links) => links.map((link) => ({ text: link.textContent.trim().slice(0, 80), href: link.getAttribute("href") })));
    const turnText = (await turn.innerText({ timeout: 5_000 }).catch(() => "")).replace(/\s+/g, " ");
    // The engine line is generated from the result count, so it cannot render for a search that
    // returned nothing. Whether this route is taken depends on the model's own choice of tool.
    if (/returned \d+ result/.test(turnText)) report("the live web search rendered the sources it really returned", chips.some((chip) => /^https?:\/\/(?!localhost)/.test(chip.href || "")), JSON.stringify(chips).slice(0, 240));
    else console.log(`live phase: this turn called no web_search; links seen ${JSON.stringify(chips).slice(0, 240)}`);
    report(`the finished live turn names no model behind it (${JSON.stringify(turnText.slice(0, 60))})`, (await turn.getByText(/^Answered by /).count()) === 0 && !/restricted|conversation-only/i.test(turnText));
    await shot("live-turn");
  }
} finally {
  await page?.evaluate((value) => {
    if (value === null) localStorage.removeItem("calvras_chat_messages"); else localStorage.setItem("calvras_chat_messages", value);
  }, savedChat).catch(() => {});
  await page?.evaluate((value) => {
    if (value === null) localStorage.removeItem("calvras_projects"); else localStorage.setItem("calvras_projects", value);
  }, savedProjects).catch(() => {});
  await page?.evaluate((value) => {
    if (value === null) localStorage.removeItem("calvras_active_project"); else localStorage.setItem("calvras_active_project", value);
  }, savedActive).catch(() => {});
  await page?.evaluate((value) => {
    if (value === null) localStorage.removeItem("calvras_access_mode"); else localStorage.setItem("calvras_access_mode", value);
  }, savedMode).catch(() => {});
  await app.close().catch(() => {});
  if (workspace) await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
}

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
