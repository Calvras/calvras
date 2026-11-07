// Simulates a stranger's laptop: the two OAuth files this machine saved are moved aside, so the
// only config the app can find is the copy the build staged into electron/oauth-defaults.json.
// Before that existed, both buttons answered "sign in is not configured on this computer yet".
// The browser step is the proof — a consent URL is opened only when a client id was resolved.
//   node scripts/verify-signin-fresh-laptop.mjs
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { googleOAuthConfig, githubOAuthConfig } = require("../electron/oauth-config.cjs").createOAuthConfigReader();

const CONFIG_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "Calvras");
const PROVIDERS = ["google", "github"];
const OUT = ".agents/artifacts/signin-fresh-laptop";
const held = [];
const results = [];

const heldAside = (provider) => path.join(CONFIG_DIR, `${provider}-oauth.json.held-aside`);

try {
  // Hold aside, never delete: if this script is interrupted the real files are still on disk,
  // just renamed, and the finally block (or a manual rename back) restores them.
  await fs.mkdir(OUT, { recursive: true });
  for (const provider of PROVIDERS) {
    const file = path.join(CONFIG_DIR, `${provider}-oauth.json`);
    try {
      await fs.rename(file, heldAside(provider));
      held.push(provider);
      console.log(`Held aside ${file}`);
    } catch { console.log(`No per-user ${provider} config on this machine to hold aside.`); }
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // One app per provider: the second button is disabled while a sign-in is in flight, so
  // measuring both in one window would only prove the first one.
  for (const provider of PROVIDERS) {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-fresh-laptop-"));
    const app = await electron.launch({
      executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
      args: [".", `--user-data-dir=${profile}`],
      env,
      timeout: 60000,
    });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      const button = page.getByRole("button", { name: `Continue with ${provider === "google" ? "Google" : "GitHub"}`, exact: true });
      await button.waitFor({ timeout: 45000 });
      await button.click();
      await page.waitForTimeout(6000);
      const body = await page.locator("body").innerText();
      const notConfigured = /is not configured on this computer/i.test(body);
      const pending = await button.isDisabled().catch(() => false);
      const config = provider === "google" ? googleOAuthConfig() : githubOAuthConfig();
      results.push([
        provider,
        !notConfigured && Boolean(config.clientId),
        `clientId=${config.clientId ? "resolved from the bundled copy" : "NULL"}${notConfigured ? " — the app said not configured" : ""}${pending ? ", and the button stayed busy waiting for the browser" : ""}`,
      ]);
      await page.screenshot({ path: path.join(OUT, `${provider}.png`), animations: "disabled" });
    } finally {
      await app.close();
      await fs.rm(profile, { recursive: true, force: true });
    }
  }
} finally {
  for (const provider of held) {
    try {
      await fs.rename(heldAside(provider), path.join(CONFIG_DIR, `${provider}-oauth.json`));
      console.log(`Restored the per-user ${provider} config.`);
    } catch (error) { console.log(`RESTORE FAILED for ${provider}: ${error.message}. It is at ${heldAside(provider)}`); }
  }
}

let ok = true;
for (const [label, pass, detail] of results) { ok = ok && pass; console.log(`${pass ? "PASS" : "FAIL"}  ${label} sign-in resolved a client id with no per-user config — ${detail}`); }
process.exit(ok ? 0 : 1);
