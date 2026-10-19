// Opt-in proof that /admin-calvras really renders and really writes. It boots the actual Worker
// handler over real SQLite on a loopback port, then drives the page in a real browser through the
// running dev server, clicking the chips and reading the database behind them.
//   ADMIN_UI_PAGE=http://localhost:5200/admin-calvras RUN_ADMIN_UI=1 npx vitest run src/test/admin-console-ui.test.ts
// Skipped without RUN_ADMIN_UI=1 because it launches a browser and needs the dev server up.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEDGER_SCHEMA, grantPlan, recordSignIn } from "../lib/runtime/ledger";
import { type SiteEnv } from "../lib/site-api";
import { d1Shim } from "./sqlite-d1";
import { startSiteServer, type SiteServer } from "./site-server";

const enabled = process.env["RUN_ADMIN_UI"] === "1";
const pageUrl = process.env["ADMIN_UI_PAGE"] || "http://localhost:5173/admin-calvras";
const token = "console-owner-token";
const shots = path.join(os.tmpdir(), "calvras-admin-console");

const sqlite = new DatabaseSync(":memory:");
let site: SiteServer;

beforeAll(async () => {
  if (!enabled) return;
  fs.mkdirSync(shots, { recursive: true });
  sqlite.exec(LEDGER_SCHEMA);
  const env: SiteEnv = { CALVRAS_DB: d1Shim(sqlite), CALVRAS_ADMIN_TOKEN: token };
  const now = Date.now();
  for (const [index, email] of ["shikari@calvras.com", "ada@calvras.com", "linus@calvras.com"].entries()) {
    const name = email.split("@")[0] || email;
    await recordSignIn(env.CALVRAS_DB!, { email, name, subject: `sub-${index}`, platform: "Win32", version: "10.0.3", at: now - index * 60_000 });
  }
  await grantPlan(env.CALVRAS_DB!, "ada@calvras.com", "ultra", "owner", now);

  site = await startSiteServer(env);
}, 60_000);

afterAll(async () => {
  if (!enabled) return;
  await site?.close();
  sqlite.close();
});

describe("the owner console in a browser", { timeout: 120_000 }, () => {
  it.skipIf(!enabled)("opens, lists, grants and forgets against the real ledger", async () => {
    const reachable = await fetch(pageUrl).catch(() => null);
    expect(reachable?.ok, `The dev server is not answering at ${pageUrl}. Start it and pass ADMIN_UI_PAGE.`).toBe(true);

    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
      const page = await context.newPage();
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(String(error.message)));
      page.on("console", (message) => { if (message.type() === "error") failures.push(message.text()); });

      // Storage has to exist before the page script runs, so it is seeded on the same origin first.
      await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
      await page.evaluate(([base, ownerToken]) => {
        window.localStorage.setItem("calvras_site_base", base as string);
        window.localStorage.setItem("calvras_admin_token", ownerToken as string);
      }, [site.base, token]);
      await page.reload({ waitUntil: "networkidle" });

      // The token in storage unlocks the console without a keystroke.
      await page.getByRole("heading", { name: "Accounts" }).waitFor({ timeout: 20_000 });
      await page.getByRole("cell", { name: /shikari@calvras\.com/ }).first().waitFor({ timeout: 20_000 });
      expect(await page.getByRole("heading", { name: "Signed in" }).count()).toBe(1);
      expect(await page.locator("table").filter({ hasText: "ada@calvras.com" }).getByText("ultra", { exact: false }).first().isVisible()).toBe(true);
      await page.screenshot({ path: path.join(shots, "console-open.png"), fullPage: true });

      // Grant Pro to the free account by pressing the chip the owner would press.
      const row = page.locator("tr", { hasText: "shikari@calvras.com" }).first();
      await row.getByRole("button", { name: "pro" }).click();
      await row.getByRole("button", { name: "pro" }).waitFor({ timeout: 15_000 });
      const stored = sqlite.prepare("SELECT plan, plan_set_by FROM accounts WHERE email = 'shikari@calvras.com'").get() as Record<string, unknown>;
      expect(stored).toEqual(expect.objectContaining({ plan: "pro", plan_set_by: "owner" }));

      // Its history opens on the row that was just changed.
      await row.getByRole("button", { name: "History" }).click();
      await page.getByRole("heading", { name: "shikari@calvras.com" }).waitFor({ timeout: 15_000 });
      const history = (await page.locator(".admin-history").innerText()).toLowerCase();
      expect(history).toContain("plan");
      expect(history).toContain("owner set pro");
      expect(history).toContain("signin");

      // Searching narrows the table to one address.
      await page.getByRole("textbox", { name: "Search accounts" }).fill("ada@");
      await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 1, null, { timeout: 15_000 });
      await page.screenshot({ path: path.join(shots, "console-search.png"), fullPage: true });

      // Forgetting asks first, and only then removes the row and its events.
      let asked = "";
      page.once("dialog", (dialog) => { asked = dialog.message(); void dialog.accept(); });
      await page.getByRole("button", { name: "Forget" }).click();
      await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 0, null, { timeout: 15_000 });
      expect(asked).toContain("ada@calvras.com");
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM accounts WHERE email LIKE 'ada%'").get()).toEqual(expect.objectContaining({ n: 0 }));
      await page.screenshot({ path: path.join(shots, "console-empty-search.png"), fullPage: true });

      // An unstyled or half-hydrated page would show as a console error, and milk is the grant colour.
      expect(failures.filter((line) => !/favicon|DevTools|Download the React/i.test(line))).toEqual([]);
      const chip = await page.locator(".admin-milk").first().evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(chip.replace(/\s/g, "")).toBe("rgb(245,240,232)");
    } finally {
      await browser.close();
    }
  });
});
