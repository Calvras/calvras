// Verifies the ChatGPT PromptBox port: tools popover, active-tool chip,
// disabled/white send circle, image thumbnail + full-size preview dialog,
// tool directive reaching the API, deep-research daily counter.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OUT = ".agents/artifacts/promptbox";
await fs.mkdir(OUT, { recursive: true });
const checks = [];
const check = (label, ok) => { checks.push([label, Boolean(ok)]); console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); };

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-promptbox-"));
const pngPath = path.join(tmp, "test.png");
await fs.writeFile(pngPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: ["main.cjs", "--user-data-dir=" + await fs.mkdtemp(path.join(os.tmpdir(), "calvras-prompt-profile-"))],
  env,
  timeout: 60_000,
});

let shot = 0;
const snap = async (page, name) => {
  const p = path.join(OUT, `${String(++shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: p, animations: "disabled" }).catch(() => {});
  console.log("shot:", p);
};

let fatal = null;
let origResearch = null;
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(new URL('../app.html', import.meta.url).href);
  await page.waitForSelector("#prompt-input", { timeout: 30_000 });
  await page.waitForTimeout(1200);

  // Deterministic deep-research counter (restore afterwards)
  origResearch = await page.evaluate(() => {
    const orig = localStorage.getItem("calvras_deep_research");
    localStorage.setItem("calvras_deep_research", JSON.stringify({ date: new Date().toISOString().slice(0, 10), used: 0 }));
    renderToolsMenus();
    return orig;
  });

  // Stub the model so sends complete without network; capture API messages.
  await page.evaluate(() => {
    window.__lastApiMessages = null;
    streamCompletion = async (msgs) => { window.__lastApiMessages = msgs; return { content: "Done.", reasoning: "" }; };
  });

  // SEND STATE
  const empty = await page.evaluate(() => ({
    disabled: document.getElementById("send-btn").disabled,
    bg: getComputedStyle(document.getElementById("send-btn")).backgroundColor,
  }));
  check("home send disabled + gray when empty", empty.disabled && empty.bg === "rgb(81, 81, 81)");
  await page.fill("#prompt-input", "hello there");
  const typed = await page.evaluate(() => ({
    disabled: document.getElementById("send-btn").disabled,
    bg: getComputedStyle(document.getElementById("send-btn")).backgroundColor,
  }));
  check("home send enabled + white with text", !typed.disabled && typed.bg === "rgb(255, 255, 255)");
  await page.fill("#prompt-input", "");

  // TOOLS POPOVER
  await page.click("#home-tools-btn");
  const menu = await page.evaluate(() => ({
    visible: document.getElementById("home-tools-menu").style.display !== "none",
    count: document.querySelectorAll("#home-tools-menu .tools-item").length,
    names: [...document.querySelectorAll("#home-tools-menu .tools-item-name")].map(e => e.textContent),
    extra: document.querySelector("#home-tools-menu .tools-extra")?.textContent || "",
  }));
  console.log("menu:", JSON.stringify(menu));
  check("tools popover opens with all 5 tools", menu.visible && menu.count === 5 && menu.names.join("|") === "Create an image|Search the web|Write or code|Run deep research|Think for longer");
  check("deep research shows real '5 left' counter", menu.extra === "5 left");
  await snap(page, "home-tools-menu");

  // ACTIVE TOOL CHIP
  await page.evaluate(() => [...document.querySelectorAll("#home-tools-menu .tools-item")].find(el => el.textContent.includes("Search the web")).click());
  const chip = await page.evaluate(() => ({
    name: document.querySelector("#home-tool-chip .tool-chip-name")?.textContent || "",
    color: document.querySelector("#home-tool-chip .tool-chip") ? getComputedStyle(document.querySelector("#home-tool-chip .tool-chip")).color : "",
    labelHidden: document.querySelector("#home-tools-btn .tools-btn-label").style.display === "none",
    menuClosed: document.getElementById("home-tools-menu").style.display === "none",
    divider: Boolean(document.querySelector("#home-tool-chip .tool-chip-divider")),
  }));
  console.log("chip:", JSON.stringify(chip));
  check("selecting a tool shows blue chip + divider", chip.name === "Search" && chip.color === "rgb(153, 206, 255)" && chip.divider);
  check("Tools label hides and menu closes on select", chip.labelHidden && chip.menuClosed);
  await page.click("#home-tool-chip .tool-chip");
  const cleared = await page.evaluate(() => ({
    chip: document.getElementById("home-tool-chip").children.length,
    label: document.querySelector("#home-tools-btn .tools-btn-label").style.display !== "none",
  }));
  check("chip X clears selection and restores Tools label", cleared.chip === 0 && cleared.label);

  // IMAGE ATTACHMENT + PREVIEW DIALOG
  await page.setInputFiles("#file-input", pngPath);
  await page.waitForTimeout(300);
  const att = await page.evaluate(() => {
    const t = document.querySelector(".card-attachment-thumb");
    return {
      thumb: Boolean(t),
      size: t ? getComputedStyle(t).width : "",
      radius: t ? getComputedStyle(t).borderRadius : "",
      sendEnabled: !document.getElementById("send-btn").disabled,
      text: document.getElementById("prompt-input").value,
    };
  });
  console.log("attachment:", JSON.stringify(att));
  check("image-only attachment enables send with empty text", att.thumb && att.sendEnabled && att.text === "");
  check("thumbnail is 56px rounded-16", att.size === "56px" && att.radius === "16px");
  await page.click("#home-tools-btn");
  await page.evaluate(() => [...document.querySelectorAll("#home-tools-menu .tools-item")].find(el => el.textContent.includes("Search the web")).click());
  await snap(page, "home-chip-attachment");
  await page.click(".card-attachment-thumb");
  await page.waitForTimeout(250);
  const preview = await page.evaluate(() => ({
    overlay: Boolean(document.getElementById("prompt-image-overlay")),
    img: Boolean(document.querySelector("#prompt-image-overlay img")),
    blur: getComputedStyle(document.getElementById("prompt-image-overlay")).backdropFilter,
  }));
  check("thumbnail click opens full-size preview dialog", preview.overlay && preview.img && preview.blur.includes("blur"));
  await snap(page, "image-preview");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check("Escape closes the preview dialog", await page.evaluate(() => !document.getElementById("prompt-image-overlay")));
  await page.click(".card-attach-remove");
  check("removing attachment disables send again", await page.evaluate(() => document.getElementById("send-btn").disabled));

  // SEND WITH TOOL → directive in API, clean bubble, chip persists
  await page.click("#home-tools-btn");
  await page.evaluate(() => [...document.querySelectorAll("#home-tools-menu .tools-item")].find(el => el.textContent.includes("Create an image")).click());
  await page.fill("#prompt-input", "describe the color blue");
  await page.click("#send-btn");
  await page.waitForFunction(() => !isGenerating, { timeout: 20_000 });
  const sent = await page.evaluate(() => {
    const userMsg = chats[0].messages.find(m => m.role === "user");
    const apiUser = (window.__lastApiMessages || []).filter(m => m.role === "user").pop();
    const apiText = typeof apiUser?.content === "string" ? apiUser.content : (apiUser?.content || []).map(p => p.text || "").join(" ");
    return {
      tool: userMsg?.tool || "",
      directive: apiText.includes("[TOOL SELECTED]") && apiText.includes("image:"),
      bubbleClean: !(document.querySelector(".user-bubble")?.textContent || "").includes("TOOL SELECTED"),
      capsuleChip: document.querySelector("#capsule-tool-chip .tool-chip-name")?.textContent || "",
      capsuleAttachmentsInsideBar: document.getElementById("capsule-attachments").parentElement.id === "capsule-input-bar",
      capsuleSendDisabled: document.getElementById("capsule-send-btn").disabled,
    };
  });
  console.log("sent:", JSON.stringify(sent));
  check("sent message stores the selected tool", sent.tool === "createImage");
  check("API receives the tool directive, bubble stays clean", sent.directive && sent.bubbleClean);
  check("tool chip persists into the conversation composer", sent.capsuleChip === "Image");
  check("capsule attachments live inside the rounded bar", sent.capsuleAttachmentsInsideBar);
  check("capsule send disabled when empty", sent.capsuleSendDisabled);

  // CAPSULE TOOLS + DEEP RESEARCH COUNTER
  await page.click("#capsule-tools-btn");
  const capMenu = await page.evaluate(() => ({
    visible: document.getElementById("capsule-tools-menu").style.display !== "none",
    count: document.querySelectorAll("#capsule-tools-menu .tools-item").length,
  }));
  check("capsule tools popover works too", capMenu.visible && capMenu.count === 5);
  await page.evaluate(() => [...document.querySelectorAll("#capsule-tools-menu .tools-item")].find(el => el.textContent.includes("Run deep research")).click());
  await page.fill("#capsule-prompt-input", "compare two sorting approaches");
  await page.click("#capsule-send-btn");
  await page.waitForFunction(() => !isGenerating, { timeout: 20_000 });
  const research = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("calvras_deep_research") || "{}");
    const userMsgs = chats[0].messages.filter(m => m.role === "user");
    return { used: stored.used, tool: userMsgs[userMsgs.length - 1]?.tool || "" };
  });
  check("deep research send consumes one use and stores tool", research.used === 1 && research.tool === "deepResearch");
  await page.click("#capsule-tools-btn");
  const extra = await page.evaluate(() => document.querySelector("#capsule-tools-menu .tools-extra")?.textContent || "");
  check("counter now reads '4 left'", extra === "4 left");
  await snap(page, "capsule-tools");

  check("no renderer page errors", errors.length === 0);
  if (errors.length) console.log("page errors:", errors);
} catch (err) {
  fatal = err;
  console.error("FATAL:", err);
} finally {
  try {
    const page = await app.firstWindow();
    await page.evaluate((orig) => {
      if (orig === null) localStorage.removeItem("calvras_deep_research");
      else localStorage.setItem("calvras_deep_research", orig);
    }, origResearch);
  } catch {}
  await app.close().catch(() => {});
}

const passed = checks.filter(c => c[1]).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (fatal || passed !== checks.length) process.exit(1);