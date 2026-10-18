// Verifies the rebuilt desktop app renders the shipped UI: a flat title bar,
// full-screen settings with the slide-out rail, the workspace dock, and the slash-menu side chat.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const out = ".agents/artifacts/app-ui";
await fs.mkdir(out, { recursive: true });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
const checks = [];
let page;
try {
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });

  const bar = await page.evaluate(() => {
    const node = document.querySelector("div[style*='app-region']");
    const style = node ? getComputedStyle(node) : null;
    return style ? { image: style.backgroundImage, color: style.backgroundColor } : { image: "MISSING", color: "MISSING" };
  });
  checks.push([`title bar is a flat charcoal strip with no gradient (${JSON.stringify(bar)})`, bar.image === "none" && bar.color === "rgb(20, 20, 21)"]);

  // "Make it 6, reduce it": the strip is 34px (6/10 of the doubled 56) and the app starts below it.
  const chrome = await page.evaluate(() => {
    const strip = document.querySelector("div[style*='app-region']");
    const rail = document.querySelector(".app-rail");
    return {
      strip: strip ? Math.round(strip.getBoundingClientRect().height) : 0,
      var: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-title-height")) || 0,
      railTop: rail ? Math.round(rail.getBoundingClientRect().top) : -1,
      closeTop: document.querySelector('[aria-label="Close"]') ? Math.round(document.querySelector('[aria-label="Close"]').getBoundingClientRect().top) : -1,
      closeBottom: document.querySelector('[aria-label="Close"]') ? Math.round(document.querySelector('[aria-label="Close"]').getBoundingClientRect().bottom) : -1,
    };
  });
  checks.push([`the title bar strip is 34px tall and the app starts below it (${JSON.stringify(chrome)})`,
    chrome.strip === 34 && chrome.var === 34 && chrome.railTop === 34 && chrome.closeTop >= 5 && chrome.closeTop <= 7 && chrome.closeBottom <= 29]);
  await page.screenshot({ path: path.join(out, "home.png"), animations: "disabled" });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const screen = page.locator(".settings-screen");
  await screen.waitFor();
  const box = await screen.boundingBox();
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, title: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-title-height")) || 0 }));
  checks.push([`settings fills the window below the chrome (${Math.round(box.width)}x${Math.round(box.height)} vs ${viewport.width}x${viewport.height - viewport.title})`, Math.abs(box.width - viewport.width) < 2 && Math.abs(box.height - (viewport.height - viewport.title)) < 2]);
  checks.push(["sections rail is open beside the page", await page.locator(".settings-rail.is-open nav button").count() >= 6]);

  // "Put them in the center, not in the left side": the column sits in the middle of the page area.
  const column = await page.evaluate(() => {
    const content = document.querySelector(".settings-content");
    const first = content?.firstElementChild;
    if (!content || !first) return null;
    const area = content.getBoundingClientRect();
    const box = first.getBoundingClientRect();
    return { left: Math.round(box.left - area.left), right: Math.round(area.right - box.right), width: Math.round(box.width) };
  });
  checks.push([`the settings column is centered in its area (${JSON.stringify(column)})`,
    !!column && column.width <= 760 && Math.abs(column.left - column.right) <= 2 && column.left > 42]);
  await page.screenshot({ path: path.join(out, "settings-profile.png"), animations: "disabled" });

  const bodyText = await page.locator(".settings-content").innerText();
  checks.push([`no model or provider settings remain (${/api key|pin a model|provider|models/i.test(bodyText) ? "found provider ui" : "clean"})`,
    !/api key|pin a model|override automatic routing/i.test(bodyText)]);

  // Every section in the rail has to open a real page, not an empty shell.
  const sections = await page.locator(".settings-rail button").allInnerTexts();
  const visited = [];
  for (const label of sections.map((text) => text.trim()).filter(Boolean)) {
    const button = page.locator(".settings-rail button", { hasText: label }).first();
    if (!(await button.count())) continue;
    await button.click();
    await page.waitForTimeout(250);
    const heading = (await page.locator(".settings-topbar h2").innerText()).trim();
    const controls = await page.locator(".settings-content input, .settings-content select, .settings-content button, .settings-content [role=switch]").count();
    const rows = await page.locator(".settings-content kbd, .settings-content table tr, .settings-group").count();
    visited.push(`${label}→${heading}/${controls}ctl/${rows}rows`);
    checks.push([`section "${label}" opens "${heading}" with ${controls} controls and ${rows} rows`, (controls > 0 || rows > 0) && Boolean(heading)]);
  }
  await page.screenshot({ path: path.join(out, "settings-rail.png"), animations: "disabled" });
  console.log("visited:", visited.join(" | "));

  // The account row is the last thing in the rail and holds the sign-in state.
  await page.locator(".settings-rail [aria-label=Account]").click();
  await page.waitForTimeout(250);
  const accountHeading = (await page.locator(".settings-topbar h2").innerText()).trim();
  const accountText = await page.locator(".settings-content").innerText();
  checks.push([`account opens "${accountHeading}" (${accountText.replace(/\s+/g, " ").slice(0, 60)})`, Boolean(accountHeading) && accountText.trim().length > 20]);

  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".settings-screen").count(), 0, "Escape must close settings");

  // ── Usage page and the upgrade path ────────────────────────────────────────
  // The credential lives in the app's own folder; the harness reads it only to prove the
  // window never receives it, and never prints it.
  const storeDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "Calvras");
  const liveKey = await fs.readFile(path.join(storeDir, "payments.json"), "utf8")
    .then((text) => String(JSON.parse(text)["apiKey"] || "")).catch(() => "");
  const usageUrl = page.url();
  // The person using the machine can click at any moment, so every step re-enters the page it
  // needs instead of assuming the window is still where the harness left it.
  const ensureUsageOpen = async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (/\/pricing/.test(page.url()) || !(await page.getByRole("button", { name: "Settings", exact: true }).count())) {
        await page.goto(usageUrl, { waitUntil: "domcontentloaded" });
        await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });
      }
      if (!(await page.locator(".settings-screen").count())) {
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await screen.waitFor();
      }
      if ((await page.locator(".settings-topbar h2").innerText()).trim() === "Usage") {
        await page.locator(".settings-usage-grid").waitFor({ timeout: 10_000 });
        // The six totals arrive from the local server; an em dash means it has not answered yet.
        return page.waitForFunction(() => {
          const cells = [...document.querySelectorAll(".settings-usage-cell b")];
          return cells.length === 6 && cells.every((node) => node.innerText.trim() !== "—");
        }, null, { timeout: 20_000 }).then(() => true).catch(() => false);
      }
      await page.locator(".settings-rail button", { hasText: "Usage" }).first().click();
      await page.waitForTimeout(250);
    }
    return false;
  };
  const usageSettled = await ensureUsageOpen();
  const railLabels = (await page.locator(".settings-rail button").allInnerTexts()).map((text) => text.trim());
  checks.push([`Usage is in the rail above Shortcuts (${railLabels.join(", ")})`,
    railLabels.includes("Usage") && railLabels.indexOf("Usage") < railLabels.indexOf("Shortcuts")]);

  const usageRead = await page.evaluate(async () => {
    const heading = document.querySelector(".settings-topbar h2")?.innerText.trim() || "";
    const pill = [...document.querySelectorAll(".settings-content button")].find((node) => node.innerText.trim() === "Upgrade plan");
    const pillStyle = pill && document.contains(pill) ? getComputedStyle(pill) : null;
    const cells = [...document.querySelectorAll(".settings-usage-cell")].map((cell) => ({
      value: cell.querySelector("b")?.innerText.trim() || "",
      label: cell.querySelector("span")?.innerText.trim() || "",
    }));
    const rows = [...document.querySelectorAll(".settings-content .settings-row h3 span")].map((node) => node.innerText.trim());
    const statusText = await fetch("/api/agent/payments").then((response) => response.text());
    const stats = await fetch("/api/agent/usage").then((response) => response.json());
    const catalog = await fetch("/api/agent/payments/catalog").then((response) => response.json());
    return {
      heading,
      pill: pillStyle ? { bg: pillStyle.backgroundColor, color: pillStyle.color, radius: pillStyle.borderRadius } : null,
      cells, rows, statusText, stats, catalog,
    };
  });
  checks.push([`the Usage page opens with a milky white upgrade pill (${JSON.stringify(usageRead.pill)})`,
    usageRead.heading === "Usage" && !!usageRead.pill
      && usageRead.pill.bg === "rgb(245, 240, 232)" && usageRead.pill.color === "rgb(26, 21, 18)" && usageRead.pill.radius === "999px"]);
  const toolCell = usageRead.cells.find((cell) => cell.label.startsWith("Tool calls recorded"));
  const folderCell = usageRead.cells.find((cell) => cell.label === "Project folders worked in");
  checks.push([`the six totals are the server's own numbers, not client math (${JSON.stringify(usageRead.cells.map((cell) => cell.value))})`,
    usageSettled && usageRead.cells.length === 6 && !!toolCell && !!folderCell
      && toolCell.value === String(usageRead.stats.toolCalls)
      && (!usageRead.stats.failures || toolCell.label.includes(String(usageRead.stats.failures)))
      && folderCell.value === String(usageRead.stats.projects)]);
  const perTool = (usageRead.stats.byTool || []).every((row) => usageRead.rows.includes(row.tool));
  checks.push([`every tool the agent used is listed with its real count (${JSON.stringify(usageRead.stats.byTool || []).slice(0, 90)})`,
    (usageRead.stats.byTool || []).length > 0 && perTool]);
  const status = JSON.parse(usageRead.statusText);
  checks.push([`the store credential stays server-side (${JSON.stringify({ hasKey: status.hasKey, hint: status.keyHint, leaked: usageRead.statusText.includes(liveKey) && liveKey.length > 0 })})`,
    liveKey.length === 0 || (status.hasKey === true && usageRead.statusText.includes(`…${liveKey.slice(-4)}`) && !usageRead.statusText.includes(liveKey))]);
  const honestStore = String(status.merchantId || "").length
    ? usageRead.catalog.ok === true && Array.isArray(usageRead.catalog.plans)
    : usageRead.catalog.ok === false && /merchant id/i.test(String(usageRead.catalog.error)) && usageRead.catalog.plans.length === 0;
  checks.push([`the plan list is only what the store really returns (${JSON.stringify(usageRead.catalog).slice(0, 110)})`, honestStore]);
  await page.screenshot({ path: path.join(out, "settings-usage.png"), animations: "disabled" });

  await ensureUsageOpen();
  // Payment happens on the website, so the pill hands the URL to the desktop bridge and this
  // window stays where it was. The harness cannot watch the OS browser open, so it proves the
  // app did not move and that the settings screen closed instead of becoming a checkout page.
  const beforeUpgrade = page.url();
  await page.getByRole("button", { name: "Upgrade plan" }).click({ timeout: 15_000 });
  await page.waitForTimeout(1_200);
  const afterUpgrade = { url: page.url(), settingsOpen: (await page.locator(".settings-screen").count()) > 0 };
  checks.push([`upgrade leaves the app and does not turn this window into a payment page (${JSON.stringify(afterUpgrade)})`,
    afterUpgrade.url === beforeUpgrade && !afterUpgrade.settingsOpen]);

  await page.goto(new URL("/pricing", beforeUpgrade).href, { waitUntil: "domcontentloaded" });
  await page.locator(".pricing-card").first().waitFor({ timeout: 15_000 });
  const pricing = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".pricing-card")].map((card) => ({
      name: card.querySelector("h2")?.innerText.trim() || "",
      badge: card.querySelector(".pricing-card-heading span")?.innerText.trim() || "",
      amount: card.querySelector(".pricing-amount")?.innerText.replace(/\s+/g, " ").trim() || "",
      button: card.querySelector(".pricing-plan-button")?.innerText.trim() || "",
    }));
    return { cards, note: document.querySelector(".pricing-note")?.innerText.trim() || "" };
  });
  const buyable = usageRead.catalog.plans.length > 0;
  checks.push([`the pricing page sells what the store really has (${JSON.stringify(pricing.cards).slice(0, 200)} | note: ${pricing.note.slice(0, 80)})`,
    pricing.cards.length === 3
      && pricing.cards.filter((card) => card.name !== "Starter").every((card) => card.badge === (buyable ? "In the store" : "Not on sale yet"))
      && /merchant of record/i.test(pricing.note)]);
  if (!buyable) {
    await page.getByRole("button", { name: /Explore Pro/ }).click();
    const dialog = await page.getByRole("dialog").innerText();
    checks.push([`a plan that is not on sale refuses to take money and quotes the store (${dialog.replace(/\s+/g, " ").slice(0, 120)})`,
      /No payment has been taken/.test(dialog) && /merchant id|no Payments AI|no Calvras server/i.test(dialog)]);
    // The button is a step up, not the starter file the page used to hand out.
    const cta = await page.evaluate(() => { const link = document.querySelector('[role="dialog"] a.landing-download'); return { label: link ? link.innerText.replace(/\s+/g, " ").trim() : "", href: link?.getAttribute("href") || "" }; });
    checks.push([`the dialog's only button says Upgrade and points at a payment page, never a download (${JSON.stringify(cta)})`,
      /^upgrade/i.test(cta.label) && !/download|starter|\.exe|\.zip/i.test(cta.href)]);
    await page.screenshot({ path: path.join(out, "pricing-page.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
  } else {
    checks.push(["a plan on sale opens the Payments AI checkout instead of a dialog", true]);
    await page.screenshot({ path: path.join(out, "pricing-page.png"), animations: "disabled" });
  }
  await page.goto(usageUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });

  // ── Workspace dock ───────────────────────────────────────────────────────
  // A seeded folder with two real files, so the dock is listing disk, not a fixture array.
  const dockRoot = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-dock-"));
  await fs.writeFile(path.join(dockRoot, "dock-fixture.txt"), "CALVRAS-DOCK-MARKER-4173\nsecond line\n", "utf8");
  await fs.mkdir(path.join(dockRoot, "src", "components"), { recursive: true });
  await fs.writeFile(path.join(dockRoot, "src", "components", "Panel.tsx"), "export function Panel() {\n  return null;\n}\n", "utf8");

  const dockKeys = ["calvras_projects", "calvras_active_project", "calvras_access_mode", "calvras_chat_messages"];
  const savedDock = {};
  for (const key of dockKeys) savedDock[key] = await page.evaluate((name) => localStorage.getItem(name), key);
  try {
    // First the honest nothing-open state: it has to offer the real folder picker, not a dead sentence.
    await page.evaluate(() => { localStorage.removeItem("calvras_active_project"); localStorage.setItem("calvras_chat_messages", "[]"); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Workspace files" }).click();
    await page.locator('.browser-dock[data-open="true"]').waitFor({ timeout: 10_000 });
    const emptyState = await page.locator('[aria-label="Workspace files"].dock-panel').innerText();
    const picker = page.getByRole("button", { name: "Add a project folder" });
    checks.push([`with no folder open the dock explains and offers the picker (${emptyState.replace(/\s+/g, " ").slice(0, 70)})`,
      /Nothing is open yet/.test(emptyState) && (await picker.count()) === 1]);
    await page.screenshot({ path: path.join(out, "dock-empty.png"), animations: "disabled" });
    await page.keyboard.press("Escape");

    // A stored answer in list form, so the renderer is judged on what it puts in the DOM.
    await page.evaluate(([dir]) => {
      const project = { name: "Dock Fixture", path: dir };
      const now = Date.now();
      localStorage.setItem("calvras_projects", JSON.stringify([project]));
      localStorage.setItem("calvras_active_project", JSON.stringify(project));
      localStorage.setItem("calvras_access_mode", "full");
      localStorage.setItem("calvras_chat_messages", JSON.stringify([
        { id: 1, role: "user", text: "Which panels does the dock have?", phases: [], done: true, startedAt: now - 9_000, endedAt: now - 8_000 },
        { id: 2, role: "assistant", text: "", done: true, status: "complete", startedAt: now - 8_000, endedAt: now - 1_000,
          phases: [{ message: "The dock has four panels:\n- Files shows the open workspace tree\n- Preview embeds the running local server\n- Browser keeps the page Calvras drives\n- Subagents lists the parallel workers", trace: [], startedAt: now - 8_000, endedAt: now - 1_000 }] },
      ]));
    }, [dockRoot]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });

    const list = await page.evaluate(() => {
      const items = document.querySelectorAll('[aria-label="Conversation"] .markdown-body li');
      return { count: items.length, first: items[0]?.textContent?.trim().slice(0, 40) || "", tag: items[0]?.parentElement?.tagName || "none" };
    });
    checks.push([`a listed answer renders as real list items (${list.count} × <${list.tag.toLowerCase()}>, "${list.first}")`, list.count >= 4 && list.tag === "UL"]);
    await page.screenshot({ path: path.join(out, "reply-list.png"), animations: "disabled" });

    await page.getByRole("button", { name: "Workspace files" }).click();
    const dock = page.locator('.browser-dock[data-open="true"]');
    await dock.waitFor({ timeout: 10_000 });
    const tabTexts = (await page.locator(".dock-tab").allInnerTexts()).map((text) => text.trim());
    checks.push([`the dock slides out with tabbed sections (${tabTexts.join(", ")})`, tabTexts.includes("Files") && tabTexts.includes("Preview")]);
    checks.push([`panels not yet earned stay hidden (${tabTexts.join(", ")})`, !tabTexts.includes("Browser") && !tabTexts.includes("Subagents")]);

    const flat = await page.evaluate(() => {
      const read = (sel) => { const n = document.querySelector(sel); if (!n) return "MISSING"; const s = getComputedStyle(n); return `${s.backgroundImage}|${s.boxShadow}|${s.borderRadius}`; };
      return { aside: read(".browser-dock"), head: read(".dock-head"), tabs: read(".dock-tabs"), selected: read(".dock-tab.is-selected"), body: read(".dock-body") };
    });
    const noGradient = (value) => value !== "MISSING" && !/gradient/i.test(value);
    checks.push([`dock chrome is flat with no gradient or shadow (${JSON.stringify(flat)})`,
      Object.values(flat).every(noGradient) && flat.aside.startsWith("none|none|0px")]);

    // Apple-minimal means one accent: every pressable control is the same milky cream as the composer.
    const milk = await page.evaluate(() => {
      const read = (sel) => { const n = document.querySelector(sel); if (!n) return null; const s = getComputedStyle(n); return `${s.backgroundColor}|${s.color}|${s.borderRadius}`; };
      return { tab: read(".dock-tab.is-selected"), search: read(".dock-search"), button: read(".dock-button"), unselected: read(".dock-tab:not(.is-selected)") };
    });
    const milky = (value) => value !== null && value.split("|")[0] === "rgb(245, 240, 232)" && value.endsWith("|999px");
    checks.push([`the selected tab, search field and buttons are milky white pills (${JSON.stringify(milk)})`,
      milky(milk.tab) && milky(milk.search) && milky(milk.button)]);
    checks.push([`an unselected tab stays plain text, not a second chip (${milk.unselected})`,
      milk.unselected !== null && !milk.unselected.startsWith("rgb(245, 240, 232)")]);

    // The reference panel: a stamped summary card whose text fades out, icon tiles, quiet labels,
    // a count chip, and no rules between rows.
    const reference = await page.evaluate(() => {
      const pane = document.querySelector('[aria-label="Workspace files"].dock-panel');
      const card = pane?.querySelector(".dock-summary");
      const text = card?.querySelector(".dock-summary-text");
      const rows = [...(pane?.querySelectorAll("*") || [])].filter((node) => parseFloat(getComputedStyle(node).borderBottomWidth) > 0).length;
      const scrim = getComputedStyle(document.querySelector(".dock-body"), "::before").backgroundImage;
      return {
        stamp: card ? card.innerText.replace(/\s+/g, " ").trim().slice(0, 70) : "MISSING",
        fade: text ? getComputedStyle(text).maskImage || getComputedStyle(text).webkitMaskImage : "MISSING",
        scrim,
        tiles: pane?.querySelectorAll(".dock-tile").length ?? 0,
        chip: pane?.querySelector(".dock-chip")?.innerText || "MISSING",
        rows,
      };
    });
    checks.push([`the files panel reads like the reference card (${JSON.stringify(reference)})`,
      /Updated at \d/.test(reference.stamp) && /gradient/i.test(reference.fade) && /gradient/i.test(reference.scrim)
        && reference.tiles >= 3 && /listing/.test(reference.chip) && reference.rows === 0]);
    await page.screenshot({ path: path.join(out, "dock-files.png"), animations: "disabled" });

    // Files tab: the tree comes from the runtime listing the real folder.
    // Every panel stays mounted, so all reads are scoped to the visible files panel.
    const filesPane = page.locator('[aria-label="Workspace files"].dock-panel');
    const caption = await filesPane.locator(".dock-caption").innerText();
    checks.push([`the files panel names the open workspace (${caption.slice(0, 60)})`, caption.includes("Dock Fixture")]);
    await filesPane.locator("button.dock-row", { hasText: "src" }).first().click();
    await filesPane.locator("button.dock-row", { hasText: "components" }).first().click();
    await filesPane.locator("button.dock-row", { hasText: "Panel.tsx" }).first().click();
    await filesPane.locator(".dock-code").waitFor({ timeout: 15_000 });
    const opened = await filesPane.locator(".dock-code").innerText();
    checks.push([`clicking a file opens its actual bytes (${opened.replace(/\s+/g, " ").trim().slice(0, 50)})`, opened.includes("export function Panel")]);
    const openedStyle = await page.evaluate(() => {
      const pane = document.querySelector('[aria-label="Workspace files"].dock-panel');
      const code = pane.querySelector(".dock-code");
      const chip = pane.querySelector(".dock-chip");
      return {
        codeShare: +(code.getBoundingClientRect().height / pane.getBoundingClientRect().height).toFixed(2),
        chip: chip ? chip.innerText : "MISSING",
      };
    });
    checks.push([`a three-line file sizes its own box and the chip names the kind, not the file again (${JSON.stringify(openedStyle)})`,
      openedStyle.codeShare < 0.5 && !openedStyle.chip.includes("Panel.tsx") && openedStyle.chip.length > 0]);
    await page.screenshot({ path: path.join(out, "dock-file-open.png"), animations: "disabled" });
    await filesPane.getByRole("button", { name: "All files" }).click();
    await filesPane.locator("button.dock-row", { hasText: "dock-fixture.txt" }).first().click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Workspace files"] .dock-code')?.textContent.includes("CALVRAS-DOCK-MARKER-4173"), null, { timeout: 15_000 });
    checks.push(["a second file opens from disk too", true]);

    // Preview tab: honest when nothing is listening, and no iframe pointed at nowhere.
    await page.getByRole("tab", { name: "Preview" }).click();
    await page.waitForTimeout(400);
    const preview = await page.evaluate(() => ({
      text: document.querySelector('[aria-label="Preview"].dock-panel')?.innerText.replace(/\s+/g, " ") || "",
      iframes: document.querySelectorAll(".dock-preview").length,
    }));
    checks.push([`preview with no server says so and embeds nothing (${preview.text.slice(0, 70)})`, /No local server preview is open/.test(preview.text) && preview.iframes === 0]);

    await page.keyboard.press("Escape");
    assert.equal(await page.locator('.browser-dock[data-open="true"]').count(), 0, "Escape must close the dock");
    checks.push(["Escape slides the dock back out", true]);
  } finally {
    await page.evaluate(([keys, values]) => {
      for (let index = 0; index < keys.length; index++) {
        const value = values[index];
        if (value === null) localStorage.removeItem(keys[index]); else localStorage.setItem(keys[index], value);
      }
    }, [dockKeys, dockKeys.map((key) => savedDock[key])]);
    await fs.rm(dockRoot, { recursive: true, force: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });
  }

  // ── Partner inquiry form ───────────────────────────────────────────────────
  const appUrl = page.url();
  await page.goto(`${new URL(appUrl).origin}/partner`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Good ideas go further together." }).waitFor({ timeout: 30_000 });
  const partnerText = await page.evaluate(() => document.body.innerText);
  checks.push([`the partner page prints no private address (${/shikari/i.test(partnerText) ? "found one" : "clean"})`, !/shikari/i.test(partnerText)]);
  await page.getByRole("button", { name: /Let.s talk/ }).click();
  const sheet = page.getByRole("dialog", { name: /Tell us what you want to build/ });
  await sheet.waitFor({ timeout: 10_000 });
  const sendLink = sheet.getByRole("link", { name: /Send inquiry/ });
  const draft = decodeURIComponent(await sendLink.getAttribute("href") || "");
  checks.push([`the form slid up with four options and a draft addressed to the partnership inbox (${await sheet.getByRole("radio").count()} options, ${draft.slice(0, 46)})`,
    (await sheet.getByRole("radio").count()) === 4 && draft.startsWith("mailto:calvrasnoreply@gmail.com")]);
  await sheet.getByRole("radio", { name: /Education and communities/ }).check();
  await sheet.getByPlaceholder("Who you are").fill("Ada Lovelace");
  await sheet.getByPlaceholder("you@company.com").fill("ada@example.org");
  await sheet.getByPlaceholder(/The product or community/).fill("We run a 400-member developer meetup and want a Calvras workshop track.");
  const composed = decodeURIComponent(await sendLink.getAttribute("href") || "");
  checks.push([`the composed message carries what was typed (${composed.replace(/\n/g, " ").slice(0, 110)})`,
    /Education and communities/.test(composed) && /Ada Lovelace/.test(composed) && /ada@example\.org/.test(composed) && /workshop track/.test(composed)]);
  await page.screenshot({ path: path.join(out, "partner-form.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  checks.push(["Escape puts the form back down", (await page.getByRole("dialog").count()) === 0]);
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });

  await page.getByRole("button", { name: "Open prompt input" }).click();
  const input = page.getByRole("textbox", { name: "Prompt" });
  await input.click({ force: true });
  await input.fill("/");
  const sideChat = page.getByRole("option", { name: /Open side chat/ }).or(page.getByText("Open side chat", { exact: true })).first();
  await sideChat.waitFor({ timeout: 10_000 });
  await sideChat.click();
  const panel = page.getByLabel("Side chat", { exact: true });
  await panel.waitFor();
  await panel.getByPlaceholder("Ask anything").fill("how are you going?");
  await panel.getByPlaceholder("Ask anything").press("Enter");
  await panel.locator("text=/Calvras is typing/").waitFor({ state: "detached", timeout: 90_000 }).catch(() => {});
  const text = await panel.innerText();
  checks.push(["side chat answers in clean prose", text.length > 20 && !/^\s*\{/.test(text) && !text.includes('"response"')]);
  await page.screenshot({ path: path.join(out, "side-chat.png"), animations: "disabled" });
} catch (error) {
  checks.push([`stopped at: ${String(error.message).split("\n")[0].slice(0, 160)}`, false]);
  if (page) await page.screenshot({ path: path.join(out, "failure.png"), animations: "disabled" }).catch(() => {});
} finally {
  await app.close();
}
const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks, screenshots: await fs.readdir(out) }, null, 2));
process.exit(failed.length ? 1 : 0);
