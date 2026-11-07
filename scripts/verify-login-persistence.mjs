// Proves the claim behind "I have already logged in": the browser panel the agent drives
// keeps its own persistent session, so a site cookie written during one run is still there
// after the app closes and starts again, before anything is navigated.
import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const OUT = ".agents/artifacts/login-persistence";
await fs.mkdir(OUT, { recursive: true });
const checks = [];
const check = (label, ok) => checks.push([label, Boolean(ok)]);

const code = crypto.randomBytes(4).toString("hex").toUpperCase();
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": `calvras_session=${code}; Path=/; Max-Age=3600` });
  res.end(`<!doctype html><meta charset=utf-8><title>Acme Mail | Inbox</title>
<body style="font:16px system-ui;max-width:520px;margin:40px auto"><h1 id=signedin>Signed in as ${code}</h1>
<p>You are logged in to Acme Mail.</p></body>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-login-"));

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const launch = async () => {
  const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate((dir) => {
    localStorage.setItem("calvras_projects", JSON.stringify([{ name: "Login Proof", path: dir }]));
    localStorage.setItem("calvras_active_project", JSON.stringify({ name: "Login Proof", path: dir }));
    localStorage.setItem("calvras_access_mode", "full");
  }, root);
  await page.reload();
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });
  return { app, page };
};

try {
  const first = await launch();
  const input = first.page.getByRole("textbox", { name: "Prompt" });
  await input.click({ force: true });
  await input.fill(`Open ${base}/inbox in the browser panel and tell me the code the page shows.`);
  await input.press("Enter");
  await first.page.getByRole("button", { name: "Stop task" }).waitFor({ state: "detached", timeout: 8 * 60_000 });
  const transcript = await first.page.getByLabel("Conversation").innerText();
  await first.page.screenshot({ path: path.join(OUT, "first-run.png"), animations: "disabled" }).catch(() => {});
  check(`first run: the page issued a login code and the agent read it (${transcript.toUpperCase().includes(code) ? code : "not in the reply"})`, transcript.toUpperCase().includes(code));
  await first.app.close();

  const second = await launch();
  // Nothing has been navigated in this session yet, so a cookie here came off the disk.
  const stored = await second.app.evaluate(async ({ session }, url) => {
    const cookies = await session.fromPartition("persist:calvras-browser").cookies.get({ url });
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`);
  }, base);
  check(`restart: the panel's session still holds the login cookie (${stored.join(", ") || "none"})`, stored.includes(`calvras_session=${code}`));
  await second.app.close();
} catch (error) {
  check(`stopped at: ${String(error.message).split("\n")[0].slice(0, 180)}`, false);
} finally {
  server.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}

const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
process.exit(failed.length ? 1 : 0);
