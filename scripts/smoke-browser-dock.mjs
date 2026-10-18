import { _electron as electron } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import assert from "node:assert/strict";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-dock-profile-"));
const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: [".", `--user-data-dir=${profile}`],
  env,
  timeout: 60000,
});
const results = {};
try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.addInitScript(() => {
    localStorage.setItem("calvras_access_mode", "full");
    localStorage.removeItem("calvras_chat_messages");
  });
  await page.reload();
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.waitFor({ timeout: 45000 });

  await prompt.fill(
    "You must use the open_browser tool (the visible browser panel), not web_fetch. Open https://example.com, then use read_page and reply with the page's main heading. Do not answer from memory."
  );
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();

  const dock = page.locator('.browser-dock[data-open="true"]');
  await dock.waitFor({ timeout: 240000 });
  results.opened = true;

  const address = dock.locator(".browser-dock-address input");
  await page.waitForFunction(
    () => {
      const input = document.querySelector(".browser-dock-address input");
      return Boolean(input && input.value.includes("example.com"));
    },
    undefined,
    { timeout: 60000 }
  );
  results.address = await address.inputValue();
  await page.waitForTimeout(1500);

  results.style = await page.evaluate(() => {
    const dockEl = document.querySelector(".browser-dock");
    const probe = document.createElement("div");
    probe.style.background = "var(--background)";
    probe.style.position = "absolute";
    probe.style.width = "1px";
    probe.style.height = "1px";
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const cs = getComputedStyle(dockEl);
    return {
      background: cs.backgroundColor,
      expectedBackground: expected,
      borderTopLeftRadius: cs.borderTopLeftRadius,
      borderBottomLeftRadius: cs.borderBottomLeftRadius,
      borderTopRightRadius: cs.borderTopRightRadius,
      borderBottomRightRadius: cs.borderBottomRightRadius,
      borderWidths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
      boxShadow: cs.boxShadow,
      width: dockEl.getBoundingClientRect().width,
      viewport: window.innerWidth,
    };
  });
  assert.equal(results.style.background, results.style.expectedBackground, "Dock background must match the app background");
  assert.equal(results.style.borderTopLeftRadius, "10px");
  assert.equal(results.style.borderBottomLeftRadius, "10px");
  assert.equal(results.style.borderTopRightRadius, "0px");
  assert.equal(results.style.borderBottomRightRadius, "0px");
  assert.deepEqual(results.style.borderWidths, ["0px", "0px", "0px", "0px"]);
  assert.equal(results.style.boxShadow, "none");

  assert.equal(await page.locator(".workspace-actions").getByRole("button", { name: /browser panel/i }).count(), 0, "Manual browser button must stay removed");

  await fs.mkdir(".agents/artifacts/runtime", { recursive: true });
  await page.screenshot({ path: ".agents/artifacts/runtime/phase-b-dock.png", animations: "disabled" });

  const stop = page.getByRole("button", { name: "Stop task", exact: true });
  if (await stop.count()) await stop.waitFor({ state: "detached", timeout: 180000 });
  const conversation = await page.getByLabel("Conversation", { exact: true }).innerText();
  results.agentMentionedExample = /example domain/i.test(conversation);
  console.log(JSON.stringify({ ok: true, results }));
} finally {
  await app.close();
  await fs.rm(profile, { recursive: true, force: true });
}
