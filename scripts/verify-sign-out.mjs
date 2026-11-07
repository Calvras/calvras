// Proves that signing out really returns the app to the sign-in screen, and that a sign-in reports
// itself to the live ledger. Runs against a throwaway profile (--user-data-dir), so the copy the
// person is using keeps its own accounts, chats and keys.
//   node scripts/verify-sign-out.mjs
import { _electron as electron } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "calvras-signout-"));
const checks = [];
const say = (label, pass, extra) => { checks.push([label, pass === true, extra ?? null]); return pass === true; };
const user = { provider: "google", email: "signout.check@calvras.com", name: "Sign-out check", joinedAt: Date.now() };

let app;
try {
  app = await electron.launch({
    executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
    args: [`--user-data-dir=${profile}`, "--test-type", "."],
    timeout: 90_000,
  });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Minimize" }).waitFor({ timeout: 60_000 });

  // Put a signed-in account on this throwaway profile and come back through the launch gate, so the
  // app boots into the workspace the same way a returning person does.
  await page.evaluate((account) => {
    window.localStorage.setItem("calvras_user", JSON.stringify(account));
    window.sessionStorage.setItem("calvras_session_started", "1");
  }, user);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Minimize" }).waitFor({ timeout: 30_000 });

  const auth = page.getByRole("heading", { name: "Welcome to Calvras" });
  const gear = page.getByRole("button", { name: "Settings" });
  await gear.waitFor({ state: "visible", timeout: 30_000 });
  say("a stored Google account boots into the workspace, not the sign-in screen", (await auth.count()) === 0);

  await gear.click();
  // The account card is its own page in the Settings sidebar, so reach it the way a person does.
  await page.getByRole("button", { name: "Account" }).first().click();
  const signOut = page.getByRole("button", { name: "Sign Out" });
  await signOut.waitFor({ state: "visible", timeout: 15_000 });
  say("the Account page shows Sign Out beside the stored email", (await page.getByText(user.email).count()) > 0);

  await signOut.click();
  await auth.waitFor({ state: "visible", timeout: 30_000 });
  say("Sign Out lands on the sign-in screen", true);
  say("the stored account is gone afterwards", (await page.evaluate(() => window.localStorage.getItem("calvras_user"))) === null);
  say("the sign-in screen is Google only, with no workspace behind it", (await page.getByRole("button", { name: "Continue with Google" }).count()) === 1);

  // The same POST the app makes after a Google sign-in, sent from inside this window with a token
  // Google never issued. The site must reject the token, not the connection: a status from
  // calvras.com here means the app's own cross-origin report reaches the ledger, and the console's
  // account count can only be zero because no real sign-in was reported, not because a fetch failed.
  const reach = await page.evaluate(async () => {
    try {
      const r = await fetch("https://calvras.com/api/site/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken: "not-a-google-token", platform: "Win32", version: "reach-check" }),
      });
      return { status: r.status, error: String((await r.json().catch(() => ({})))?.error || "") };
    } catch (error) { return { failed: error instanceof Error ? error.message : String(error) }; }
  });
  say("the app can POST a sign-in report to calvras.com", typeof reach.status === "number" && reach.status > 0, reach);
  say("the site answers about the token, not about the connection", /token|verif|client id/i.test(reach.error || ""), reach);
} catch (error) {
  checks.push(["the run finished", false, error instanceof Error ? error.message.slice(0, 300) : String(error)]);
} finally {
  await app?.close().catch(() => {});
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = checks.filter(([, pass]) => !pass);
console.log(JSON.stringify({ ok: failed.length === 0, failed: failed.map(([l, , e]) => [l, e]), checks: checks.map(([l, p]) => [l, p]) }, null, 1));
process.exit(failed.length === 0 ? 0 : 1);
