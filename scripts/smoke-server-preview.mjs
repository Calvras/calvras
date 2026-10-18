import { _electron as electron } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import assert from "node:assert/strict";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-server-preview-"));
const profile = path.join(tmp, "profile");
const workspace = path.join(tmp, "preview-app");
await fs.mkdir(profile, { recursive: true });
await fs.mkdir(workspace, { recursive: true });
const artifactDir = path.resolve(".agents/artifacts/runtime");
await fs.mkdir(artifactDir, { recursive: true });

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const value = probe.address().port;
    probe.close(() => resolve(value));
  });
});
const previewUrl = `http://127.0.0.1:${port}/`;
const pageTitle = "Calvras Preview Smoke";

await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "calvras-preview-smoke", private: true, scripts: { start: "node server.mjs" } }, null, 2));
await fs.writeFile(path.join(workspace, "server.mjs"), `
import http from "node:http";
const port = ${port};
const html = \`<!doctype html><html><head><meta charset="utf-8"><title>${pageTitle}</title>
<style>body{font-family:system-ui;background:#0b1220;color:#e5e7eb;display:grid;place-items:center;height:100vh;margin:0}main{text-align:center}h1{font-weight:600}button{padding:10px 18px;border-radius:8px;border:0;background:#3b82f6;color:#fff;font-size:14px}</style></head>
<body><main><h1 id="headline">Calvras preview is live</h1><p>This page is served by the project dev server.</p><button id="counter" onclick="this.textContent='Clicked '+(++window.n)">Click me</button></main>
<script>window.n=0</script></body></html>\`;
http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}).listen(port, "127.0.0.1", () => console.log("Calvras preview server listening at " + "http://127.0.0.1:" + port + "/"));
setTimeout(() => process.exit(0), 120000);
`);

const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: [".", `--user-data-dir=${profile}`],
  env,
  timeout: 60000,
});
const results = {};
const logs = [];
let page;
let inferenceCalls = 0;
const inferenceRequests = [];

try {
  page = await app.firstWindow();
  page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => logs.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ""}`));
  page.on("response", (response) => { if (response.status() >= 400) logs.push(`http ${response.status()}: ${response.url()}`); });
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(({ workspace }) => {
    localStorage.setItem("calvras_projects", JSON.stringify([{ name: "Preview app", path: workspace }]));
    localStorage.setItem("calvras_active_project", JSON.stringify({ name: "Preview app", path: workspace }));
    localStorage.setItem("calvras_seen_workspaces", JSON.stringify([workspace]));
    localStorage.setItem("calvras_access_mode", "full");
    localStorage.removeItem("calvras_chat_messages");
    localStorage.removeItem("calvras_session_memory");
  }, { workspace });
  await page.reload();

  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.waitFor({ timeout: 45000 });

  // Deterministic stand-in for the model: first turn asks for the real start_server
  // tool, the follow-up confirms it. Every tool call still executes for real.
  await page.route("**/api/v1/chat/completions", async (route) => {
    inferenceCalls += 1;
    try {
      const requestBody = route.request().postDataJSON();
      const userContent = requestBody?.messages?.[1]?.content;
      inferenceRequests.push({ mediaAttached: Array.isArray(userContent), parts: Array.isArray(userContent) ? userContent.map((part) => part.type) : [] });
    } catch { inferenceRequests.push({ mediaAttached: false, parts: [] }); }
    const content = inferenceCalls === 1
      ? JSON.stringify({ message: "Starting the preview server.", actions: [{ type: "start_server", command: "node server.mjs" }], status: "continue" })
      : JSON.stringify({ message: `The dev server is running. Preview it at ${previewUrl} — the panel is open on the right.`, actions: [], status: "complete" });
    try {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
      });
    } catch (error) {
      logs.push(`fulfill error: ${error instanceof Error ? error.message : String(error)}`);
      await route.abort().catch(() => {});
    }
  });

  await prompt.fill("start the dev server");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();

  const dock = page.locator(".browser-dock");
  await dock.waitFor({ state: "attached", timeout: 45000 });
  await page.waitForFunction(() => document.querySelector(".browser-dock")?.getAttribute("data-open") === "true", undefined, { timeout: 45000 });
  results.open = await dock.getAttribute("data-open");
  results.active = await dock.getAttribute("data-active");
  assert.equal(results.open, "true", "the right panel should slide out when the server is ready");
  assert.equal(results.active, "false", "the preview must stay unlocked so the user can use it");

  await page.waitForFunction((url) => {
    const webview = document.querySelector(".browser-dock webview");
    if (!webview || typeof webview.getURL !== "function") return false;
    try { return webview.getURL() === url; } catch { return false; }
  }, previewUrl, { timeout: 45000 });

  const webviewState = await page.evaluate(async () => {
    const webview = document.querySelector(".browser-dock webview");
    const address = document.querySelector('input[aria-label="Browser address"]');
    return {
      url: webview.getURL(),
      title: webview.getTitle(),
      address: address ? address.value : "",
      text: await webview.executeJavaScript("document.body.innerText"),
      lock: Boolean(document.querySelector(".browser-dock-lock")),
      browserAttr: document.querySelector(".chat-page")?.getAttribute("data-browser"),
      transition: getComputedStyle(document.querySelector(".browser-dock")).transitionProperty,
    };
  });
  results.webview = { url: webviewState.url, title: webviewState.title, address: webviewState.address, lock: webviewState.lock, browserAttr: webviewState.browserAttr, transition: webviewState.transition, text: webviewState.text.slice(0, 200) };
  assert.equal(webviewState.url, previewUrl, "the webview should load the server URL");
  assert.equal(webviewState.address, previewUrl, "the address bar should show the server URL");
  assert.match(webviewState.text, /Calvras preview is live/, "the real server page should render inside the panel");
  assert.equal(webviewState.lock, false, "no agent lock should cover a server preview");
  assert.equal(webviewState.browserAttr, "open", "the chat layout should make room for the panel");
  assert.match(webviewState.transition, /transform/, "the dock should use a slide transition");

  await page.getByText(/panel is open on the right/i).waitFor({ timeout: 60000 });
  const conversation = await page.getByLabel("Conversation", { exact: true }).innerText();
  results.replyHasLink = conversation.includes(previewUrl);
  assert.equal(results.replyHasLink, true, "the agent reply should include the server link");
  results.inferenceRequests = inferenceRequests;
  results.traceHasPreviewCheck = /check preview/i.test(conversation);
  assert.equal(results.traceHasPreviewCheck, true, "the agent should record its UI preview check in the trace");
  assert.equal(inferenceRequests.at(-1)?.mediaAttached, true, "the preview screenshot should be attached to the next model turn");

  // The panel edge should resize like a real split view and remember the width.
  const beforeResize = await page.evaluate(() => document.querySelector(".browser-dock").getBoundingClientRect().width);
  const handle = page.locator(".browser-dock-resize");
  const handleBox = await handle.boundingBox();
  assert.ok(handleBox, "the resize handle should be visible");
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 - 170, handleBox.y + handleBox.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const resized = await page.evaluate(() => ({
    width: document.querySelector(".browser-dock").getBoundingClientRect().width,
    variable: document.querySelector(".chat-page").style.getPropertyValue("--browser-dock-width"),
    stored: Number(localStorage.getItem("calvras_browser_width")),
    resizing: document.querySelector(".browser-dock").getAttribute("data-resizing"),
  }));
  results.resize = { beforeResize, ...resized };
  assert.ok(resized.width >= beforeResize + 140, "dragging the edge left should widen the panel");
  assert.equal(resized.resizing, "false", "resizing state should clear on release");
  assert.ok(Math.abs(resized.stored - resized.width) <= 2, "the chosen width should persist");

  await page.screenshot({ path: path.join(artifactDir, "server-preview-open.png") });

  // Closing is the user's choice and the loaded preview should survive.
  await page.getByRole("button", { name: "Close browser panel" }).click();
  await page.waitForFunction(() => document.querySelector(".browser-dock")?.getAttribute("data-open") === "false", undefined, { timeout: 5000 });
  await page.waitForTimeout(450);
  const closed = await page.evaluate(() => {
    const dock = document.querySelector(".browser-dock");
    const webview = document.querySelector(".browser-dock webview");
    const style = getComputedStyle(dock);
    return { open: dock.getAttribute("data-open"), hidden: dock.getAttribute("aria-hidden"), visibility: style.visibility, transform: style.transform, url: webview.getURL() };
  });
  results.closed = closed;
  assert.equal(closed.open, "false", "close should slide the panel away");
  assert.equal(closed.hidden, "true", "closed panel should be hidden from assistive tech");
  assert.equal(closed.visibility, "hidden", "closed panel should be visually hidden after the slide");
  assert.equal(closed.url, previewUrl, "closing the panel should not drop the preview page");

  results.ok = true;
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} catch (error) {
  results.ok = false;
  results.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  results.inferenceCalls = inferenceCalls;
  results.diagnostics = await (async () => {
    try {
      return await page.evaluate(() => ({
        electron: Object.keys(window.__electron || {}),
        dockCount: document.querySelectorAll(".browser-dock").length,
        conversation: document.querySelector('[aria-label="Conversation"]')?.innerText?.slice(-2500) || "",
        composer: document.querySelector('[aria-label="Conversation"]')?.parentElement?.innerText?.slice(-800) || "",
      }));
    } catch (reason) { return { evaluateError: String(reason) }; }
  })();
  await page.screenshot({ path: path.join(artifactDir, "server-preview-failed.png") }).catch(() => {});
  console.log(JSON.stringify({ ok: false, results, logs: logs.slice(-80) }, null, 2));
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
