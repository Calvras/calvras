import { chromium } from "playwright";
import fs from "node:fs";

fs.mkdirSync(".agents/artifacts/verify", { recursive: true });
const BASE = "http://localhost:8082/app";
const out = (name) => `.agents/artifacts/verify/${name}.png`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message || e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

// 1) Splash — navigate and catch the logo before the 2s gate clears.
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(500);
await page.screenshot({ path: out("1-splash") });

// 2) Skip splash/auth by pre-seeding storage, reload into the app.
await page.addInitScript(() => {
  localStorage.setItem("calvras_user", JSON.stringify({ provider: "google", name: "Calvras user", joinedAt: Date.now() }));
  sessionStorage.setItem("calvras_session_started", "1");
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 15000 });
await page.screenshot({ path: out("2-home") });

// 3) Slash menu → pick Goal → removable chip + typed text.
const box = page.getByRole("textbox", { name: "Prompt" });
await page.getByRole("button", { name: "Open prompt input" }).click();
await page.waitForTimeout(400);
await box.click();
await box.type("/");
await page.getByRole("listbox", { name: "Slash commands" }).waitFor({ timeout: 5000 });
await page.screenshot({ path: out("3-slash-menu") });
await page.getByRole("option", { name: /Goal/ }).click();
await page.locator('[data-slash-chip="goal"]').waitFor({ timeout: 4000 });
await box.type("build me a landing page");
await page.screenshot({ path: out("4-goal-chip") });

// 4) Folder chip menu (no folder yet → "Add a folder").
await page.getByRole("button", { name: /Add a folder/ }).click();
await page.screenshot({ path: out("5-folder-add") });

// 5) Side chat panel.
await page.getByRole("button", { name: "Side chat" }).click();
await page.getByRole("complementary", { name: "Side chat" }).waitFor({ timeout: 4000 });
await page.getByRole("button", { name: "How long?" }).waitFor({ timeout: 3000 });
const sideInput = page.getByRole("complementary", { name: "Side chat" }).getByPlaceholder("Ask anything…");
await sideInput.fill("Where are you with this?");
await page.getByRole("complementary", { name: "Side chat" }).getByRole("button", { name: "Send" }).click();
await page.waitForTimeout(9000);
await page.screenshot({ path: out("6-sidechat") });

// 6) Tasks panel (polished look).
await page.getByRole("button", { name: "Tasks" }).click();
await page.getByRole("complementary", { name: "Tasks" }).waitFor({ timeout: 4000 });
await page.screenshot({ path: out("7-tasks") });

console.log(JSON.stringify({ ok: errors.length === 0, errorCount: errors.length, errors: errors.slice(0, 8) }, null, 2));
await browser.close();
