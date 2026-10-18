// Proves the settings that only the main process can apply actually take effect in the
// packaged app, and survive a restart: menu-bar icon, its device label, the sleep blocker,
// and the remote-control address the local server binds to.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const OUT = ".agents/artifacts/settings-enforcement";
await fs.mkdir(OUT, { recursive: true });
const checks = [];
const check = (label, ok) => checks.push([label, Boolean(ok)]);

const EXECUTABLE = path.resolve("node_modules/electron/dist/electron.exe");
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;

// powerSaveBlocker ids are small integers, so a scan is enough to see whether one is live.
const blockers = (app) => app.evaluate(({ powerSaveBlocker }) => {
  const started = [];
  for (let id = 0; id < 16; id++) if (powerSaveBlocker.isStarted(id)) started.push(id);
  return started;
});

const launch = async () => {
  const app = await electron.launch({ executablePath: EXECUTABLE, args: ["."], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.__electron), null, { timeout: 30_000 });
  return { app, page };
};

const call = (page, method, ...args) => page.evaluate(([name, rest]) => window.__electron[name](...rest), [method, args]);
const settingsFile = async (app) => path.join(await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData")), "app-settings.json");
const readSettings = async (app) => { try { return JSON.parse(await fs.readFile(await settingsFile(app), "utf8")); } catch { return {}; } };

const first = await launch();
let app = first.app;
let page = first.page;
const file = await settingsFile(app);
const original = await readSettings(app);

try {
  const trayOn = await call(page, "setKeepInMenuBar", true);
  check(`keepInMenuBar: menu-bar icon created (${trayOn})`, trayOn === true);

  const named = await call(page, "setDeviceName", "Studio PC");
  check(`deviceName: menu-bar label carries it (${JSON.stringify(named)})`, named?.label === "Calvras — Studio PC" && named?.inMenuBar === true);
  const written = await readSettings(app);
  check(`deviceName: persisted for the next start (${written.deviceName})`, written.deviceName === "Studio PC");

  const sleepOn = await call(page, "setPreventSleep", true);
  const liveBlockers = await blockers(app);
  check(`preventSleep: blocker started at once (${sleepOn}, ids ${liveBlockers.join("/") || "none"})`, sleepOn === true && liveBlockers.length > 0);

  const remote = await call(page, "setRemoteControl", true);
  check(`remoteControl: saved and honest about needing a restart (${JSON.stringify(remote)})`, remote?.saved === true && remote?.needsRestart === true);
  await app.close();

  // Second start: nothing but the boot path may re-apply these.
  const second = await launch();
  app = second.app; page = second.page;
  const afterBoot = await blockers(app);
  check(`restart: sleep blocker re-applied by boot alone (ids ${afterBoot.join("/") || "none"})`, afterBoot.length > 0);
  const bootLabel = await call(page, "setDeviceName", "Studio PC");
  check(`restart: menu-bar icon and label back (${JSON.stringify(bootLabel)})`, bootLabel?.inMenuBar === true && bootLabel?.label === "Calvras — Studio PC");
  const network = await call(page, "networkInfo");
  check(`restart: remote control reports its LAN address (${JSON.stringify(network)})`, network?.remoteControl === true && Boolean(network?.lanAddress));
  if (network?.lanAddress) {
    const url = `http://${network.lanAddress}:${network.port}/app`;
    const status = await fetch(url, { signal: AbortSignal.timeout(10_000) }).then((response) => response.status).catch((error) => String(error.message).slice(0, 60));
    check(`restart: the app answers on the network address (${url} → ${status})`, status === 200);
  } else {
    check("restart: no LAN address to prove the bind against", false);
  }
  await app.close();

  // Third start with the settings cleared, so a switch that is off must really stop matters.
  const clean = { ...original, preventSleep: false, keepInMenuBar: false, remoteControl: false };
  await fs.writeFile(file + ".tmp", JSON.stringify(clean)); await fs.rename(file + ".tmp", file);
  const third = await launch();
  app = third.app; page = third.page;
  const clearedBlockers = await blockers(app);
  check(`off switch: no blocker when preventSleep is false (ids ${clearedBlockers.join("/") || "none"})`, clearedBlockers.length === 0);
  const offLabel = await call(page, "setDeviceName", "");
  check(`off switch: no menu-bar icon when keepInMenuBar is false (${JSON.stringify(offLabel)})`, offLabel?.inMenuBar === false && offLabel?.label === "Calvras");
  const offNetwork = await call(page, "networkInfo");
  check(`off switch: remote control reports itself off (${JSON.stringify(offNetwork)})`, offNetwork?.remoteControl === false);
  await app.close();
  app = null;
} catch (error) {
  check(`stopped at: ${String(error.message).split("\n")[0].slice(0, 180)}`, false);
  if (page) await page.screenshot({ path: path.join(OUT, "failure.png"), animations: "disabled" }).catch(() => {});
  if (app) await app.close().catch(() => {});
}

// Leave the user's own settings exactly as they were found.
await fs.writeFile(file + ".tmp", JSON.stringify(original));
await fs.rename(file + ".tmp", file);

const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
process.exit(failed.length ? 1 : 0);
