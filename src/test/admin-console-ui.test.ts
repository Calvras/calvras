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
import { LEDGER_SCHEMA, grantPlan, recordSignIn, recordTask } from "../lib/runtime/ledger";
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
    // Two of the three arrive with Cloudflare geolocation, the third with none — the console has to
    // show a place for the first and an em dash for the last instead of blanking the row.
    const where = index === 0 ? { city: "Lahore", country: "PK" } : index === 1 ? { country: "DE" } : {};
    await recordSignIn(env.CALVRAS_DB!, { email, name, subject: `sub-${index}`, platform: "Win32", version: "10.0.3", ...where, at: now - index * 60_000 });
  }
  await grantPlan(env.CALVRAS_DB!, "ada@calvras.com", "ultra", "owner", now);
  // Two finished turns and one that never landed — the console's usage column, its "did not finish"
  // tile and the Tasks drawer all read these rows, and asks group two of them under one heading.
  for (const [index, task] of ([
    { status: "finished", prompt: "build a landing page for my bakery", tools: 7, seconds: 44 },
    { status: "stopped", prompt: "build a landing page for my dentist", tools: 2, seconds: 9 },
    { status: "finished", prompt: "sort my downloads folder by date", tools: 4, seconds: 12 },
  ] as const).entries()) {
    await recordTask(env.CALVRAS_DB!, { email: "shikari@calvras.com", plan: "free", platform: "Win32", version: "10.0.3", at: now - index * 30_000, ...task });
  }

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
      // The dev server keeps its HMR socket open, so "networkidle" never lands; load plus the wait for
      // the heading below is what proves the page hydrated against the test ledger.
      await page.reload({ waitUntil: "load" });

      // The token in storage unlocks the console without a keystroke.
      await page.getByRole("heading", { name: "Accounts" }).waitFor({ timeout: 40_000 });
      await page.getByRole("cell", { name: /shikari@calvras\.com/ }).first().waitFor({ timeout: 40_000 });
      expect(await page.getByRole("heading", { name: "Signed in" }).count()).toBe(1);
      // The page says for itself that it is polling, and the dot it paints is the milk-and-green
      // live indicator — a console left open all day has to be readable at a glance.
      expect((await page.locator(".admin-live").innerText()).toLowerCase()).toContain("live — checked");
      expect(await page.locator(".admin-live i.is-off").count()).toBe(0);
      const accounts = page.locator("table.admin-accounts");
      expect(await accounts.filter({ hasText: "ada@calvras.com" }).getByText("ultra", { exact: false }).first().isVisible()).toBe(true);
      // The owner reads where each account signed in from: city plus country, country alone, or nothing.
      for (const [email, place] of [["shikari@calvras.com", "Lahore, PK"], ["ada@calvras.com", "DE"], ["linus@calvras.com", "—"]] as [string, string][]) {
        const row = accounts.locator("tr", { hasText: email }).first();
        expect((await row.locator("td").nth(5).innerText()).trim(), email).toBe(place);
      }
      // Usage is a column of its own now, and the daily report is written from the ledger itself
      // because this site has no model key — it must say so rather than invent a sentence.
      expect((await accounts.locator("tr", { hasText: "shikari@calvras.com" }).locator("td").nth(3).innerText()).toLowerCase()).toContain("3 tasks");
      await page.locator(".admin-report p").waitFor({ timeout: 20_000 });
      const report = (await page.locator(".admin-report p").innerText()).toLowerCase();      expect(report).toContain("3 tasks in the last 24 hours");
      expect(report).toContain("build a landing page");
      expect(report).toContain("calvras_ai_key");
      await page.screenshot({ path: path.join(shots, "console-open.png"), fullPage: true });

      // Grant Pro to the free account by pressing the chip the owner would press.
      const row = accounts.locator("tr", { hasText: "shikari@calvras.com" }).first();
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

      // The tasks of that account open the same drawer, with the turn that never finished in it.
      await row.getByRole("button", { name: "Tasks" }).click();
      await page.locator(".admin-tasks li").first().waitFor({ timeout: 15_000 });
      const tasks = await page.locator(".admin-tasks li").allInnerTexts();
      expect(tasks).toHaveLength(3);
      expect(tasks.join(" ")).toContain("build a landing page for my bakery");
      expect(tasks.join(" ").toLowerCase()).toContain("stopped");
      await page.screenshot({ path: path.join(shots, "console-tasks.png"), fullPage: true });

      // Blocking is a press too: it asks, then the site holds the account off.
      const linus = accounts.locator("tr", { hasText: "linus@calvras.com" }).first();
      let asked = "";
      page.once("dialog", (dialog) => { asked = dialog.message(); void dialog.accept(); });
      await linus.getByRole("button", { name: "Block" }).click();
      await linus.locator(".admin-blocked").waitFor({ timeout: 15_000 });
      expect(asked).toContain("linus@calvras.com");
      expect(sqlite.prepare("SELECT blocked, blocked_by FROM accounts WHERE email = 'linus@calvras.com'").get()).toEqual(expect.objectContaining({ blocked: 1, blocked_by: "owner" }));
      await linus.getByRole("button", { name: "Unblock" }).click();
      await page.waitForFunction(() => !document.querySelector(".admin-blocked"), null, { timeout: 15_000 });
      expect(sqlite.prepare("SELECT blocked FROM accounts WHERE email = 'linus@calvras.com'").get()).toEqual(expect.objectContaining({ blocked: 0 }));

      // Searching narrows the table to one address, and closes a drawer left open on another.
      await page.getByRole("textbox", { name: "Search accounts" }).fill("ada@");
      await page.waitForFunction(() => document.querySelectorAll("table.admin-accounts tbody tr").length === 1, null, { timeout: 15_000 });
      expect(await page.locator(".admin-history").count()).toBe(0);
      await page.screenshot({ path: path.join(shots, "console-search.png"), fullPage: true });

      // Forgetting asks first, and only then removes the row and its events.
      page.once("dialog", (dialog) => { asked = dialog.message(); void dialog.accept(); });
      await page.getByRole("button", { name: "Forget" }).click();
      await page.waitForFunction(() => document.querySelectorAll("table.admin-accounts tbody tr").length === 0, null, { timeout: 15_000 });
      expect(asked).toContain("ada@calvras.com");
      expect((await page.locator(".admin-notice").innerText())).toContain("is forgotten");
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM accounts WHERE email LIKE 'ada%'").get()).toEqual(expect.objectContaining({ n: 0 }));
      await page.screenshot({ path: path.join(shots, "console-empty-search.png"), fullPage: true });

      // An unstyled or half-hydrated page would show as a console error, and milk is the grant colour.
      expect(failures.filter((line) => !/favicon|DevTools|Download the React/i.test(line))).toEqual([]);
      const chip = await page.locator(".admin-milk").first().evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(chip.replace(/\s/g, "")).toBe("rgb(245,240,232)");

      // Last, because it is meant to fail: a site with no model key answers the chat panel with the
      // reason rather than inventing a reply, and that refusal arrives as an HTTP 503.
      await page.getByRole("textbox", { name: "Ask the console" }).fill("who used it most?");
      await page.getByRole("button", { name: "Ask" }).click();
      await page.locator(".admin-chat li.analyst").last().waitFor({ timeout: 20_000 });
      expect((await page.locator(".admin-chat li.analyst").last().innerText()).toLowerCase()).toContain("no model key");
      await page.screenshot({ path: path.join(shots, "console-chat.png"), fullPage: true });
    } finally {
      await browser.close();
    }
  });
});
