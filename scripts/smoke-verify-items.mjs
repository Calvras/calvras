import { _electron as electron } from "playwright";
import path from "node:path";
import assert from "node:assert/strict";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 30000 });
const evidence = {};
try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 20000 });

  const storage = await page.evaluate(() => ({ chat: localStorage.getItem("calvras_chat_messages"), project: localStorage.getItem("calvras_active_project"), projects: localStorage.getItem("calvras_projects"), mode: localStorage.getItem("calvras_access_mode"), seen: localStorage.getItem("calvras_seen_workspaces") }));
  await page.evaluate(() => {
    localStorage.removeItem("calvras_chat_messages");
    localStorage.removeItem("calvras_seen_workspaces");
    localStorage.setItem("calvras_access_mode", "ask");
    const project = { name: "Calvras", path: "C:\\Users\\darka\\Desktop\\Calvras" };
    localStorage.setItem("calvras_active_project", JSON.stringify(project));
    localStorage.setItem("calvras_projects", JSON.stringify([project]));
  });
  await page.reload();
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 20000 });

  // Static items: no "Local workspace", header hr removed, no "Calvras" under the input.
  evidence.localWorkspaceCount = await page.getByText("Local workspace").count();
  evidence.headerBorder = await page.evaluate(() => getComputedStyle(document.querySelector(".workspace-header")).borderBottomWidth);
  evidence.belowInput = await page.evaluate(() => {
    const input = document.querySelector('textarea[aria-label="Prompt"]');
    const row = input?.closest("form") || input?.parentElement?.parentElement;
    return row?.textContent?.trim() || "";
  });

  // Title bar: centered gradient brand, no leftover "CALVRAS" label, no workspace breadcrumb.
  evidence.titlebar = await page.evaluate(() => {
    const bar = [...document.querySelectorAll("div")].find((node) => node.style.height === "28px" && node.querySelector && node.querySelector("span"));
    if (!bar) return { missing: true };
    const brand = [...bar.querySelectorAll("span")].find((span) => span.textContent === "Calvras");
    const rect = brand?.getBoundingClientRect();
    const style = brand ? getComputedStyle(brand) : null;
    return {
      brandCount: [...bar.querySelectorAll("span")].filter((span) => span.textContent === "Calvras").length,
      gradient: style ? style.backgroundImage : null,
      clip: style ? style.webkitBackgroundClip || style.backgroundClip : null,
      centerOffset: rect ? Math.round(Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2)) : null,
      leftLabel: [...bar.querySelectorAll("span")].some((span) => span.textContent === "CALVRAS" || (span.textContent === "Calvras" && span.getBoundingClientRect().left < 120)),
    };
  });
  evidence.workspaceHeaderText = await page.evaluate(() => document.querySelector(".workspace-header")?.textContent || "");

  // Paste: files placed on the clipboard arrive as attachments the agent can read.
  await page.evaluate(() => {
    const textarea = document.querySelector('textarea[aria-label="Prompt"]');
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])], "paste-shot.png", { type: "image/png" }));
    data.items.add(new File(["notes from the clipboard"], "clipboard-notes.txt", { type: "text/plain" }));
    textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('[aria-label^="Open preview of"]').length === 2, null, { timeout: 8000 });
  evidence.paste = await page.evaluate(() => {
    const thumbs = [...document.querySelectorAll('[aria-label^="Open preview of"]')];
    const image = thumbs.find((thumb) => (thumb.getAttribute("aria-label") || "").includes("paste-shot.png"));
    const doc = thumbs.find((thumb) => (thumb.getAttribute("aria-label") || "").includes("clipboard-notes.txt"));
    return { thumbs: thumbs.length, imageHasImg: Boolean(image?.querySelector("img")), docHasChip: Boolean(doc && !doc.querySelector("img") && doc.querySelector("svg")) };
  });
  await page.evaluate(() => document.querySelectorAll('[aria-label^="Remove "]').forEach((button) => button.click()));
  await page.waitForFunction(() => document.querySelectorAll('[aria-label^="Open preview of"]').length === 0, null, { timeout: 5000 });
  evidence.paste.cleared = true;
  await page.screenshot({ path: ".agents/artifacts/runtime/verify-home.png", animations: "disabled" });

  // Live task: force a real terminal failure, expect live output and honest recovery.
  await page.getByRole("textbox", { name: "Prompt" }).fill("Run this exact command with node: node does-not-exist-check.js — when it errors, show me the real error output, then find another way to prove the file is missing (list the directory) and report what you found.");
  await page.getByRole("button", { name: "Send prompt" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("does-not-exist-check"), null, { timeout: 15000 });

  // First encounter: fresh workspace gets a full map before any change. Both
  // initial actions run sequentially, so wait for both pills before capturing.
  await page.waitForFunction(() => {
    const text = [...document.querySelectorAll("button")].map((button) => button.textContent || "").join("\n");
    return /directory tree/i.test(text) && /read package json/i.test(text);
  }, null, { timeout: 60000 }).catch(() => {});
  evidence.firstEncounterPills = await page.evaluate(() => {
    const text = [...document.querySelectorAll("button")].map((button) => button.textContent || "").join("\n");
    return { tree: /directory tree/i.test(text), manifest: /read package json/i.test(text) };
  });

  const approval = page.locator('input[type="radio"][value="task"]');
  const approved = await approval.waitFor({ state: "visible", timeout: 45000 }).then(() => true).catch(() => false);
  evidence.approvalShown = approved;
  evidence.timelineCollapsedWhileWorking = await page.evaluate(() => {
    const header = [...document.querySelectorAll("button[aria-expanded]")].find((button) => /Working/.test(button.textContent || ""));
    return header ? header.getAttribute("aria-expanded") : null;
  });
  evidence.runStateDuringApproval = await page.evaluate(() => {
    const state = document.querySelector(".workspace-run-state");
    const dot = document.querySelector(".workspace-run-state > .is-working");
    return { text: state?.textContent, gradient: dot ? getComputedStyle(dot).backgroundImage : null };
  });
  await page.screenshot({ path: ".agents/artifacts/runtime/verify-running.png", animations: "disabled" });
  if (approved) {
    await approval.check();
    await page.getByRole("button", { name: "Confirm choice" }).click();
  }

  await page.waitForFunction(() => document.body.innerText.includes("MODULE_NOT_FOUND"), null, { timeout: 120000 });

  await page.waitForFunction(() => {
    try { return JSON.parse(localStorage.getItem("calvras_chat_messages") || "[]").some((m) => m.done && m.role === "user"); } catch { return false; }
  }, null, { timeout: 180000 });
  await page.waitForSelector(".workspace-run-state", { state: "detached", timeout: 120000 }).catch(() => {});
  await page.getByRole("button", { name: /Worked for/ }).first().click().catch(() => {});
  await page.getByRole("button", { name: /run command/i }).first().click().catch(() => {});
  evidence.terminalLive = await page.evaluate(() => {
    const text = document.body.innerText;
    return { exit1: text.includes("exit 1"), moduleNotFound: text.includes("MODULE_NOT_FOUND"), nodeError: text.includes("internal/modules"), worked: /Worked for \d+ second/.test(text), hardcoded: text.includes("Check the project files.") };
  });
  await page.screenshot({ path: ".agents/artifacts/runtime/verify-final-expanded.png", animations: "disabled" });
  evidence.final = await page.evaluate(() => {
    const messages = JSON.parse(localStorage.getItem("calvras_chat_messages") || "[]");
    const text = document.body.innerText;
    let duplicatePhases = 0;
    for (const message of messages) {
      const texts = (message.phases || []).map((phase) => (phase.message || "").trim()).filter(Boolean);
      for (let index = 1; index < texts.length; index++) if (texts[index] === texts[index - 1]) duplicatePhases++;
    }
    return {
      status: messages.map((m) => m.status),
      errors: messages.map((m) => m.error || null),
      phaseCount: messages.map((m) => (m.phases || []).length),
      resumeCount: text.includes("Pick it back up") ? 1 : 0,
      hardcodedGuard: text.includes("did not take the required action"),
      duplicatePhases,
      seenRecorded: (localStorage.getItem("calvras_seen_workspaces") || "").includes("Calvras"),
    };
  });
  await page.screenshot({ path: ".agents/artifacts/runtime/verify-final.png", animations: "disabled" });

  // Second run: Full access must run a real command with no approval prompt at all.
  await page.evaluate(() => { localStorage.setItem("calvras_access_mode", "full"); localStorage.removeItem("calvras_chat_messages"); });
  await page.reload();
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 20000 });
  await page.getByRole("textbox", { name: "Prompt" }).fill("Run this exact command with the terminal: node --version. Then report the version it printed.");
  await page.getByRole("button", { name: "Send prompt" }).click();
  let approvalsSeen = 0;
  let versionSeen = false;
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    approvalsSeen = Math.max(approvalsSeen, await page.locator('input[type="radio"][value="task"]').count());
    versionSeen = await page.evaluate(() => /v2\d\.\d+\.\d+/.test(document.body.innerText)).catch(() => false);
    if (versionSeen) break;
    await page.waitForTimeout(2000);
  }
  if (versionSeen) {
    for (let grace = 0; grace < 3; grace++) { approvalsSeen = Math.max(approvalsSeen, await page.locator('input[type="radio"][value="task"]').count()); await page.waitForTimeout(1000); }
  }
  await page.waitForFunction(() => {
    try { const messages = JSON.parse(localStorage.getItem("calvras_chat_messages") || "[]"); return messages.some((m) => m.done && m.role === "user"); } catch { return false; }
  }, null, { timeout: 120000 }).catch(() => {});
  evidence.fullAccess = await page.evaluate(() => {
    const messages = JSON.parse(localStorage.getItem("calvras_chat_messages") || "[]");
    return { status: messages.map((m) => m.status), versionInText: /v2\d\.\d+\.\d+/.test(document.body.innerText) };
  });
  evidence.fullAccess.approvalsSeen = approvalsSeen;
  await page.screenshot({ path: ".agents/artifacts/runtime/verify-full-access.png", animations: "disabled" });

  assert.equal(evidence.localWorkspaceCount, 0, "Local workspace must be gone");
  assert.equal(evidence.headerBorder, "0px", "Header hairline must be removed");
  assert.ok(!/Calvras/.test(evidence.belowInput), "No Calvras label under the input");
  assert.equal(evidence.titlebar.brandCount, 1, "Title bar shows exactly one centered Calvras brand");
  assert.match(evidence.titlebar.gradient || "", /gradient/, "Title bar brand must use the blue gradient");
  assert.equal(evidence.titlebar.clip, "text", "Title bar brand must be gradient-clipped text");
  assert.ok((evidence.titlebar.centerOffset ?? 999) <= 60, "Title bar brand must sit in the middle");
  assert.equal(evidence.titlebar.leftLabel, false, "No Calvras text on the left of the title bar");
  assert.ok(!/Calvras|\//.test(evidence.workspaceHeaderText), "Workspace header breadcrumb must be gone");
  assert.deepEqual({ thumbs: evidence.paste.thumbs, image: evidence.paste.imageHasImg, doc: evidence.paste.docHasChip, cleared: evidence.paste.cleared }, { thumbs: 2, image: true, doc: true, cleared: true }, "Pasted image and document files must attach as readable attachments");
  assert.deepEqual(evidence.firstEncounterPills, { tree: true, manifest: true }, "First encounter must map the folder before editing");
  assert.equal(evidence.timelineCollapsedWhileWorking, "false", "Trace must start collapsed while working");
  assert.match(evidence.runStateDuringApproval.gradient || "", /gradient/, "Run indicator must use the blue gradient");
  assert.ok(evidence.terminalLive.exit1 && evidence.terminalLive.moduleNotFound, "Real command failure must be visible");
  assert.equal(evidence.terminalLive.hardcoded, false, "No hardcoded inspection line");
  assert.deepEqual(evidence.final.status, ["finished"], "Run must finish");
  assert.deepEqual(evidence.final.errors, [null], "No failure surfaced");
  assert.equal(evidence.final.resumeCount, 0);
  assert.equal(evidence.final.duplicatePhases, 0, "No repeated identical phase messages");
  assert.equal(evidence.final.seenRecorded, true, "Finished workspaces must be recorded as seen");
  assert.equal(evidence.fullAccess.approvalsSeen, 0, "Full access must never ask before running commands");
  assert.equal(evidence.fullAccess.versionInText, true, "Full access command must really run");
  assert.deepEqual(evidence.fullAccess.status, ["finished"], "Full access run must finish");

  await page.evaluate((original) => {
    localStorage.removeItem("calvras_chat_messages");
    if (original.chat) localStorage.setItem("calvras_chat_messages", original.chat);
    if (original.project) localStorage.setItem("calvras_active_project", original.project); else localStorage.removeItem("calvras_active_project");
    if (original.projects) localStorage.setItem("calvras_projects", original.projects);
    if (original.mode) localStorage.setItem("calvras_access_mode", original.mode); else localStorage.removeItem("calvras_access_mode");
    if (original.seen) localStorage.setItem("calvras_seen_workspaces", original.seen); else localStorage.removeItem("calvras_seen_workspaces");
  }, storage);
  console.log(JSON.stringify({ ok: true, evidence }));
} finally {
  await app.close();
}
