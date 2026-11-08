// Drives the real Kraken desktop UI through the v8 checks: reply format on a
// live build task, light code blocks, Run-in-terminal, and image-only send.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OUT = ".agents/artifacts/kraken-v8";
await fs.mkdir(OUT, { recursive: true });
const checks = [];
const check = (label, ok) => { checks.push([label, Boolean(ok)]); console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); };

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "kraken-v8-build-"));
console.log("scratch workspace:", scratch);

const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: ["main.cjs"],
  env,
  timeout: 60_000,
});

let shot = 0;
const snap = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, "0")}-${name}.png`), animations: "disabled" }).catch(() => {});
};

let fatal = null;
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector("#prompt-input", { timeout: 30_000 });
  await page.evaluate(() => {
    const now = Date.now();
    const seed = [
      { id: "seed_a1", title: "Build the landing page", workspaceName: "Ember Site", workspaceDir: "", createdAt: now - 3600e3, updatedAt: now - 3600e3, messages: [] },
      { id: "seed_a2", title: "Fix the hero gradient", workspaceName: "Ember Site", workspaceDir: "", createdAt: now - 7200e3, updatedAt: now - 7200e3, messages: [] },
      { id: "seed_b1", title: "Review Q3 support report", workspaceName: "Calvras", workspaceDir: "", createdAt: now - 86400e3, updatedAt: now - 86400e3, messages: [] },
    ];
    localStorage.setItem("kraken_chats_history", JSON.stringify(seed));
  });
  await page.reload();
  await page.waitForSelector("#prompt-input", { timeout: 30_000 });
  await page.waitForTimeout(2500);
  await snap(page, "home-sidebar");

  // Sidebar: chats grouped under project folders
  const sidebar = await page.evaluate(() => {
    const groups = [...document.querySelectorAll(".project-folder-group")];
    return {
      groups: groups.length,
      headers: groups.map(g => g.querySelector(".project-folder-header, .folder-header")?.textContent?.trim() || g.textContent.trim().slice(0, 40)),
      chats: document.querySelectorAll("#chat-history-list .chat-history-item, #chat-history-list .history-item").length,
    };
  });
  check(`sidebar groups chats under project folders (${sidebar.groups} groups, ${sidebar.chats} chats)`, sidebar.groups >= 2 && sidebar.chats >= 3);
  check("seeded folders appear as group headers", sidebar.headers.some(h => /Ember Site/.test(h)) && sidebar.headers.some(h => /Calvras/.test(h)));
  console.log("sidebar groups:", JSON.stringify(sidebar.headers));

  // Project picker popover (opens from the sidebar Projects + button)
  await page.click("#sidebar-projects-add-btn");
  await page.waitForTimeout(400);
  const popoverVisible = await page.evaluate(() => {
    const el = document.getElementById("project-selector-popover");
    return el && el.style.display !== "none";
  });
  check("project selector popover opens", popoverVisible);
  await snap(page, "project-popover");
  await page.evaluate(() => { const el = document.getElementById("project-selector-popover"); if (el) el.style.display = "none"; });

  // Regression: stripToolBlocks must keep real code fences intact
  const fenceCheck = await page.evaluate(() => {
    const input = 'Here is the command:\n```powershell\nGet-Date\n```\n```run:echo hi```\nDone.';
    const out = stripToolBlocks(input);
    return { out, keepsBlock: out.includes("```powershell\nGet-Date\n```"), stripsTool: !out.includes("echo hi") };
  });
  check("stripToolBlocks keeps legitimate code blocks", fenceCheck.keepsBlock);
  check("stripToolBlocks still removes tool blocks", fenceCheck.stripsTool);
  console.log("fence check:", JSON.stringify(fenceCheck));
  const jsonEcho = await page.evaluate(() => stripToolBlocks('Now verifying.\n{"files": ["index.html", "style.css"]}\nDone.'));
  check("JSON tool echoes stripped from prose", !jsonEcho.includes('{"files"') && jsonEcho.includes("Done."));

  // Point the agent at the scratch workspace
  await page.evaluate(async (dir) => {
    await window.require("electron").ipcRenderer.invoke("workspace:set-folder", dir);
    await refreshWorkspaceInfo();
  }, scratch);
  const chip = await page.textContent("#folder-name-label");
  check(`workspace chip shows scratch folder (${chip})`, chip.includes(path.basename(scratch)));

  // ── Build task ──────────────────────────────────────────────────────────
  await page.fill("#prompt-input", "Build a one-page site for a coffee brand called Ember: write index.html with a hero and a menu section, write style.css, run a command that lists the files to confirm, then open the preview. Keep your updates short.");
  await page.press("#prompt-input", "Enter");
  await page.waitForSelector(".agent-thinking-state", { timeout: 60_000 });
  console.log("build task accepted, trace group live");

  // Wait for the first round to settle: tool rows OR generation end (error/no-tools)
  await page.waitForFunction(
    () => document.querySelector(".agent-tool-item") || isGenerating === false,
    { timeout: 240_000, polling: 1000 },
  );
  await page.waitForTimeout(3000);
  await snap(page, "working-live");
  const early = await page.evaluate(() => ({
    generating: isGenerating,
    tools: document.querySelectorAll(".agent-tool-item").length,
    errors: [...document.querySelectorAll(".agent-phase-error")].map(e => e.textContent.trim()),
    finals: [...document.querySelectorAll(".agent-phase-message")].map(m => m.innerText.trim().slice(0, 200)),
  }));
  console.log("first-round state:", JSON.stringify(early));
  if (!early.generating && early.tools === 0) {
    check("agent produced tool rows or a final reply", early.finals.length > 0 || early.errors.length > 0);
    throw new Error("Build round ended without tool rows: " + JSON.stringify(early));
  }
  const live = await page.evaluate(() => {
    const states = [...document.querySelectorAll(".agent-thinking-state")];
    return {
      liveGroups: states.filter(s => s.classList.contains("is-live")).length,
      shimmer: document.querySelectorAll(".agent-shimmer-title").length,
      tools: document.querySelectorAll(".agent-tool-item").length,
      summaries: states.map(s => s.querySelector(".agent-group-summary")?.textContent?.trim()),
    };
  });
  if (early.generating) {
    check(`a trace group is live while working (${JSON.stringify(live.summaries)})`, live.liveGroups >= 1);
    check("shimmer title present while live", live.shimmer >= 1);
  }

  // Wait for generation to finish, snapping progress shots along the way
  const deadline = Date.now() + 300_000;
  let progressShots = 0;
  while (Date.now() < deadline) {
    const still = await page.evaluate(() => isGenerating);
    if (!still) break;
    await page.waitForTimeout(15_000);
    if (progressShots < 6) await snap(page, `build-progress-${++progressShots}`);
  }
  const finished = await page.evaluate(() => isGenerating === false);
  check("build task finished within 5 minutes", finished);
  await page.waitForTimeout(800);
  await snap(page, "build-complete");

  const done = await page.evaluate(() => {
    const states = [...document.querySelectorAll(".agent-thinking-state")];
    const messages = [...document.querySelectorAll(".agent-phase-message")].filter(m => m.style.display !== "none");
    const last = messages[messages.length - 1];
    const bodyText = document.querySelector(".chat-viewport")?.innerText || "";
    return {
      phases: states.length,
      collapsed: states.filter(s => s.classList.contains("collapsed")).length,
      summaries: states.map(s => s.querySelector(".agent-group-summary")?.textContent?.trim()),
      tools: document.querySelectorAll(".agent-tool-item").length,
      thoughts: document.querySelectorAll(".agent-thought-item").length,
      finalText: last?.innerText?.trim().slice(0, 400) || "",
      leaks: (bodyText.match(/```(?:write|read|run|list|search|preview):/g) || []).length,
      dsml: (bodyText.match(/DSML|<\|im_start\|>/g) || []).length,
    };
  });
  console.log("done state:", JSON.stringify(done, null, 1));
  check(`multiple phases rendered (${done.phases})`, done.phases >= 1);
  check(`tool rows rendered (${done.tools})`, done.tools >= 3);
  check(`group summaries use ran/edited counts (${JSON.stringify(done.summaries)})`, done.summaries.some(s => /ran \d+|edited \d+|read \d+/.test(s || "")));
  check("final message present and short", done.finalText.length > 0 && done.finalText.length < 600);
  check("no tool-block leakage in chat", done.leaks === 0 && done.dsml === 0);

  const files = await fs.readdir(scratch);
  check(`agent wrote real files (${files.join(", ")})`, files.includes("index.html") && files.includes("style.css"));

  const previewUrl = await page.evaluate(() => document.getElementById("preview-url-input")?.value || "");
  let preview = { url: previewUrl, ok: false };
  if (previewUrl) {
    try {
      const res = await fetch(previewUrl);
      const text = await res.text();
      preview = { url: previewUrl, ok: res.ok, hasEmber: /Ember/i.test(text) };
    } catch (err) { preview.err = err.message; }
  }
  console.log("preview:", JSON.stringify(preview));
  check(`live preview serves the built page (${preview.url})`, preview.ok && preview.hasEmber);

  // ── Code block theme + Run in terminal ─────────────────────────────────
  await page.fill("#capsule-prompt-input", "Give me a powershell command that prints the current date. Show it in a code block.");
  await page.press("#capsule-prompt-input", "Enter");
  await page.waitForFunction(() => isGenerating === false, { timeout: 180_000, polling: 1000 });
  await page.waitForTimeout(500);

  const codeUi = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll(".code-block-container")];
    const last = blocks[blocks.length - 1];
    if (!last) return { found: false };
    const bg = getComputedStyle(last).backgroundColor;
    const bodyColor = getComputedStyle(last.querySelector(".code-block-body")).color;
    return { found: true, bg, bodyColor, runBtn: !!last.querySelector(".run-cmd-btn") };
  });
  console.log("code block UI:", JSON.stringify(codeUi));
  const themeOk = codeUi.found && ["rgb(13, 15, 18)", "rgb(255, 255, 255)"].includes(codeUi.bg);
  check(`code block background matches app theme (${codeUi.bg})`, themeOk);
  await snap(page, "code-block-theme");

  if (codeUi.runBtn) {
    await page.evaluate(() => { [...document.querySelectorAll(".run-cmd-btn")].pop().click(); });
    await page.waitForTimeout(4000);
    const term = await page.evaluate(() => {
      const panel = document.getElementById("terminal-panel");
      const out = document.getElementById("terminal-output");
      return { visible: panel && panel.style.display !== "none", lines: out?.innerText?.trim().slice(0, 300) || "" };
    });
    console.log("terminal after Run:", JSON.stringify(term));
    check("Run opens the terminal panel", term.visible);
    check("command output lands in the terminal, not chat", term.lines.length > 0);
    await snap(page, "run-in-terminal");
  } else {
    check("Run button present on shell code block", false);
  }

  // ── Image-only send ─────────────────────────────────────────────────────
  await page.setInputFiles("#file-input", path.resolve("avatar_milo.png")).catch(async () => {
    await page.setInputFiles("#capsule-file-input", path.resolve("avatar_milo.png"));
  });
  await page.waitForTimeout(600);
  const attachCount = await page.evaluate(() => {
    const home = document.getElementById("card-attachments");
    const cap = document.getElementById("capsule-attachments");
    return (home?.children.length || 0) + (cap?.children.length || 0);
  });
  check(`image attached without text (${attachCount})`, attachCount > 0);
  await snap(page, "image-attached");

  const phasesBefore = await page.evaluate(() => document.querySelectorAll(".agent-thinking-state").length);
  await page.evaluate(() => {
    const btn = document.getElementById("capsule-send-btn");
    btn.click();
  });
  await page.waitForTimeout(1500);
  const imgSend = await page.evaluate((before) => {
    const rows = [...document.querySelectorAll(".message-row.user")];
    const last = rows[rows.length - 1];
    return {
      generating: isGenerating,
      hasImages: !!last?.querySelector(".user-bubble-images img"),
      hasTextBubble: !!last?.querySelector(".user-bubble"),
      replied: document.querySelectorAll(".agent-thinking-state").length > before,
    };
  }, phasesBefore);
  check("image-only message sends (generating or replied)", imgSend.generating === true || imgSend.replied);
  check("image renders in user row without a text bubble", imgSend.hasImages && !imgSend.hasTextBubble);
  await snap(page, "image-only-sent");

  await page.waitForFunction(() => isGenerating === false, { timeout: 180_000, polling: 1000 }).catch(() => {});
  await snap(page, "image-reply");

  check("no uncaught page errors", errors.length === 0);
  if (errors.length) console.log("page errors:", JSON.stringify(errors));
} catch (err) {
  fatal = err;
  console.error("FATAL:", err.message);
} finally {
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) { console.log("FAILED:"); failed.forEach(([l]) => console.log(" -", l)); }
  await app.close().catch(() => {});
  process.exit(fatal || failed.length ? 1 : 0);
}