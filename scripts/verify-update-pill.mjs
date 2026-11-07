// Proves the update path in the real desktop app, against a real HTTPS feed rather than a mocked
// one: the packaged server publishes the version manifest, a newer published version puts a milky
// Update in the top right of the title bar, one click streams the installer into the app's own
// updates folder, and the process refuses to launch anything that is not a file it wrote there.
// Nothing is ever installed: the ready state is verified, then the fixture installer is removed so
// the restart step reports the truth instead of running a fake build.
import { _electron as electron } from "playwright";
import { execSync } from "node:child_process";
import https from "node:https";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const NEWER = "99.1.0";
const EXE = `Calvras-Setup-${NEWER}.exe`;
const INSTALLER_BYTES = 5 * 1024 * 1024 + 4096;
const FEED_PORT = 4443;
const checks = [];
const say = (label, pass) => { checks.push([label, pass === true]); return pass === true; };
const out = { feed: null, pill: null, states: [], ipc: null, ready: null, guard: null, missing: null, error: "" };

const certDir = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-feed-"));
const keyFile = path.join(certDir, "feed-key.pem");
const certFile = path.join(certDir, "feed-cert.pem");
execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyFile}" -out "${certFile}" -days 2 -nodes -subj "/CN=calvras.com" -addext "subjectAltName=DNS:calvras.com,IP:127.0.0.1"`, { stdio: "ignore" });

// What the published feed says right now. The harness flips it between this build, a newer build,
// and the landing page the live site still serves in place of the feed.
const published = { mode: "same", version: "0.0.0" };

const server = https.createServer({ key: await fs.readFile(keyFile), cert: await fs.readFile(certFile) }, async (request, response) => {
  if (request.url === "/update.json") {
    if (published.mode === "html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!DOCTYPE html><html><head><title>Calvras</title></head><body>landing page</body></html>");
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
    response.end(JSON.stringify({ ok: true, product: "Calvras", platform: "windows-x64", version: published.version, tag: `v${published.version}`, installer: `https://127.0.0.1:${FEED_PORT}/${EXE}`, portable: "", release: `https://github.com/Calvras/calvras/releases/tag/v${published.version}` }));
    return;
  }
  if (request.url === `/${EXE}`) {
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(INSTALLER_BYTES) });
    let sent = 0;
    while (sent < INSTALLER_BYTES) {
      const chunk = Buffer.alloc(Math.min(256 * 1024, INSTALLER_BYTES - sent), 0x41);
      if (sent === 0) chunk.write("MZ", 0, "latin1");
      sent += chunk.length;
      response.write(chunk);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    response.end();
    return;
  }
  response.writeHead(404, { "content-type": "text/html" });
  response.end("<html>no such build</html>");
});
await new Promise((resolve) => server.listen(FEED_PORT, "127.0.0.1", resolve));

try { execSync('taskkill //IM electron.exe //F', { stdio: "ignore" }); } catch {}
await new Promise((resolve) => setTimeout(resolve, 3_000));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// The page reaches the fixture through Chromium's host mapping and cert switch; the main process
// downloads with Node's own TLS stack, so it has to be told to trust this fixture's certificate.
env.NODE_EXTRA_CA_CERTS = certFile;
const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: [`--host-resolver-rules=MAP calvras.com 127.0.0.1:${FEED_PORT}`, "--ignore-certificate-errors", "--test-type", "."],
  env,
  timeout: 60_000,
});
const page = await app.firstWindow();
const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
const installerPath = path.join(userData, "updates", EXE);
const pill = page.locator(".workspace-actions button.update-pill");

async function openWith(mode, version) {
  published.mode = mode;
  published.version = version;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Minimize" }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2_000);
}

try {
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "Minimize" }).waitFor({ timeout: 30_000 });
  const current = await page.evaluate(() => window.__electron.appVersion());

  // 1. The build's own server publishes the feed every installed app reads.
  out.feed = await page.evaluate(async () => {
    const base = await window.__electron.getServerUrl();
    const response = await fetch(`${base}/update.json`);
    return { status: response.status, contentType: response.headers.get("content-type"), body: await response.json() };
  });
  say(`the app's server answers /update.json as json (${out.feed.status} ${out.feed.contentType})`, out.feed.status === 200 && String(out.feed.contentType).includes("json"));
  say(`the feed names the running build ${out.feed.body.version} with an https installer`, out.feed.body.version === current && /^https:\/\//.test(out.feed.body.installer));
  say("a feed that names this build shows no pill", (await pill.count()) === 0);

  // 2. A feed the site still serves as HTML must not be allowed to advertise anything.
  await openWith("html", current);
  say("a landing page served in place of the feed shows no pill", (await pill.count()) === 0);

  // 3. A broken feed shows no pill.
  await openWith("json", "not-a-version");
  say("a feed with an unreadable version shows no pill", (await pill.count()) === 0);

  // 4. A newer published version puts a milky Update in the tools row beside the task icons.
  await openWith("json", NEWER);
  await pill.waitFor({ state: "visible", timeout: 20_000 });
  const box = await pill.boundingBox();
  const row = await page.locator(".workspace-actions").boundingBox();
  const filesBox = await page.locator('.workspace-actions button[aria-label="Workspace files"]').boundingBox();
  const style = await pill.evaluate((node) => ({ text: node.textContent, background: getComputedStyle(node).backgroundColor, radius: getComputedStyle(node).borderRadius, title: node.title }));
  out.pill = { style, box, row, filesBox, viewport: await page.evaluate(() => window.innerWidth) };
  say(`the pill reads Update on milk #f5f0e8 (${style.text} ${style.background} r=${style.radius})`, style.text === "Update" && style.background === "rgb(245, 240, 232)" && Number(style.radius.replace("px", "")) >= 10);
  say(`it sits in the tools row, top right, left of the task icons (${JSON.stringify({ x: Math.round(box.x), y: Math.round(box.y), h: Math.round(box.height) })})`,
    box.y >= row.y && box.y + box.height <= row.y + row.height && box.height <= 34 && box.x + box.width <= filesBox.x && box.x + box.width > out.pill.viewport * 0.6);
  say(`its tooltip names the version it would install (${style.title})`, style.title.includes(NEWER));
  await fs.mkdir(path.join(".agents", "artifacts"), { recursive: true });
  await page.screenshot({ path: path.join(".agents", "artifacts", "update-pill.png") }).catch(() => {});

  // 5. One click hands the published installer URL to the main process, which streams it to disk.
  await page.waitForTimeout(5_000);
  await pill.waitFor({ state: "attached", timeout: 20_000 });
  await page.evaluate(() => {
    window.__pillStates = [];
    window.__ipc = [];
    window.__clicks = 0;
    window.__electron.onUpdateState((state) => window.__ipc.push([state.state, state.percent ?? null]));
    document.addEventListener("click", (event) => { if (event.target.closest?.(".workspace-actions button.update-pill")) window.__clicks += 1; }, true);
    const read = () => document.querySelector(".workspace-actions button.update-pill")?.textContent;
    const record = () => {
      const text = read();
      if (text && window.__pillStates.at(-1) !== text) window.__pillStates.push(text);
    };
    record();
    new MutationObserver(record).observe(document.querySelector(".workspace-actions"), { subtree: true, childList: true, characterData: true });
  });
  await pill.click();
  // The bar shows percents for the whole download, so waiting for any text change would return on
  // the first one. Wait for the state the download actually ends in: ready, or an honest failure.
  await page.waitForFunction(() => {
    const text = document.querySelector(".workspace-actions button.update-pill")?.textContent;
    return text === "Restart" || text === "Try again";
  }, null, { timeout: 90_000 });
  out.states = await page.evaluate(() => window.__pillStates);
  out.ipc = await page.evaluate(() => ({ clicks: window.__clicks, count: window.__ipc.length, first: window.__ipc[0], last: window.__ipc.at(-1) }));
  const ready = await pill.evaluate((node) => ({ text: node.textContent, title: node.title, disabled: node.disabled }));
  const written = await fs.readFile(installerPath).catch(() => null);
  out.ready = { ready, bytes: written?.length ?? 0, magic: written ? written.subarray(0, 2).toString("latin1") : "missing" };
  say(`the pill walked Update to a real percent to Restart (${JSON.stringify(out.states)} ${JSON.stringify(ready)})`, out.states[0] === "Update" && ready.text === "Restart");
  say(`the download reported real percentages in the bar (${JSON.stringify(out.states.filter((text) => text !== "Update"))})`, out.states.some((text) => /^Updating \d+%$/.test(text)));
  say(`the installer landed in the app's updates folder (${out.ready.bytes} bytes, ${out.ready.magic})`, out.ready.bytes === INSTALLER_BYTES && out.ready.magic === "MZ");
  say("the ready step asks for a restart instead of closing the app by itself", /is on this computer/.test(ready.title) && ready.disabled === false);
  say(`one press started one download and IPC carried ${out.ipc.count} whole-percent steps (${JSON.stringify(out.ipc)})`,
    out.ipc.clicks === 1 && out.ipc.last?.[0] === "ready" && out.ipc.count <= 102);

  // 6. The main process will only launch a .exe it wrote itself.
  out.guard = await page.evaluate(async (target) => await window.__electron.updateInstall(target), "C:\\Windows\\System32\\calc.exe");
  say(`it refuses a program it did not download (${JSON.stringify(out.guard)})`, out.guard.ok === false && /not a Calvras update file/i.test(out.guard.error));

  // 7. A restart without the file says so rather than pretending it updated.
  await fs.rm(installerPath, { force: true });
  await pill.click();
  await page.waitForFunction(() => document.querySelector(".workspace-actions button.update-pill")?.textContent === "Try again", null, { timeout: 20_000 });
  out.missing = await pill.evaluate((node) => ({ text: node.textContent, title: node.title }));
  say(`a vanished installer reports the truth (${JSON.stringify(out.missing)})`, out.missing.text === "Try again" && /no longer on this disk/i.test(out.missing.title));
  say("the app is still running", await page.evaluate(() => window.__electron.appVersion()).then((value) => typeof value === "string" && value.length > 0));
} catch (error) {
  out.error = error instanceof Error ? error.message.slice(0, 400) : String(error);
} finally {
  await app.close().catch(() => {});
  server.close();
  await fs.rm(installerPath, { force: true }).catch(() => {});
  await fs.rm(certDir, { recursive: true, force: true });
}

const failed = checks.filter(([, pass]) => !pass);
console.log(JSON.stringify({ ok: failed.length === 0 && !out.error, error: out.error, failed: failed.map(([label]) => label), checks, out }, null, 2));
process.exit(failed.length === 0 && !out.error ? 0 : 1);
