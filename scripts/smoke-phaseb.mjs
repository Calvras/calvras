import { _electron as electron } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import assert from "node:assert/strict";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-phaseb-"));
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60000 });
const results = {};
try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 45000 });

  await page.waitForFunction(() => document.querySelector("div[style*='app-region']"), undefined, { timeout: 30000 });
  results.titlebar = await page.evaluate(() => {
    const bar = document.querySelector("div[style*='app-region']");
    return bar ? { text: bar.textContent.trim(), backgroundImage: getComputedStyle(bar).backgroundImage, backgroundColor: getComputedStyle(bar).backgroundColor } : null;
  });
  assert.ok(results.titlebar, "Titlebar not found");
  assert.equal(results.titlebar.backgroundImage, "none", "Titlebar must be a flat strip with no gradient");
  assert.equal(results.titlebar.backgroundColor, "rgb(20, 20, 21)", "Titlebar must be the flat charcoal strip");
  assert.ok(!/calvras/i.test(results.titlebar.text), "CALVRAS label must be gone from the titlebar");

  const openPrompt = page.getByRole("button", { name: "Open prompt input" });
  if (await openPrompt.count()) await openPrompt.click();
  const camera = page.getByRole("button", { name: "Look at my screen" });
  await camera.waitFor();
  await camera.click();
  await page.getByRole("button", { name: /^Open preview of screen-/ }).first().waitFor({ timeout: 20000 });
  results.screenCapture = await page.getByRole("button", { name: /^Open preview of screen-/ }).count();

  assert.equal(await page.getByRole("button", { name: /browser panel/i }).count(), 0, "Manual globe button must be removed");
  const folder = page.locator(".workspace-project-switcher button").first();
  const tools = page.getByRole("button", { name: "Workspace files" });
  const folderBox = await folder.boundingBox();
  const toolsBox = await tools.boundingBox();
  assert.ok(folderBox && toolsBox && folderBox.x + folderBox.width <= toolsBox.x, "Folder pill must not overlap the workspace button");
  results.header = { folderRight: folderBox.x + folderBox.width, toolsLeft: toolsBox.x };
  await page.screenshot({ path: ".agents/artifacts/runtime/phase-b-header.png", animations: "disabled" });

  const get1 = await page.evaluate(async (projectRoot) => (await (await fetch(`/api/agent/journal?projectPath=${encodeURIComponent(projectRoot)}`)).json()), root);
  assert.equal(get1.ok, true);
  assert.equal(get1.content, "");
  const post = await page.evaluate(async (projectRoot) => (await (await fetch("/api/agent/journal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectPath: projectRoot, text: "**Request:** verify journal\n**Outcome:** finished" }),
  })).json()), root);
  assert.equal(post.ok, true);
  const onDisk = await fs.readFile(path.join(root, ".calvras", "journal.md"), "utf8");
  assert.ok(onDisk.includes("verify journal"));
  const get2 = await page.evaluate(async (projectRoot) => (await (await fetch(`/api/agent/journal?projectPath=${encodeURIComponent(projectRoot)}`)).json()), root);
  assert.ok(get2.content.includes("**Outcome:** finished"));
  results.journal = true;

  console.log(JSON.stringify({ ok: true, results }));
} finally {
  await app.close();
  await fs.rm(root, { recursive: true, force: true });
}
