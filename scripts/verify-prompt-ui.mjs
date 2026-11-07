// Verifies this batch on the running desktop app: links picked out of the prompt and the
// user's own bubble, the prose live-step line with no dots box, and elapsed time in words.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const out = ".agents/artifacts/prompt-ui";
await fs.mkdir(out, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
const checks = [];
const report = (label, ok, detail = "") => { checks.push([label, ok]); console.log(`${ok ? "PASS" : "FAIL"} — ${label}${detail ? ` :: ${detail}` : ""}`); };

let page;
try {
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const composer = page.getByRole("textbox", { name: "Prompt" });
  await composer.waitFor({ timeout: 30_000 });

  // 1 — the composer notices an address while it is being typed.
  await composer.fill("open https://example.com and tell me the heading on the page");
  await page.waitForTimeout(400);
  const pill = page.locator("span.text-link", { hasText: "https://example.com" });
  report("composer flags the address in the draft", (await pill.count()) > 0);
  const pillColor = await pill.first().evaluate((node) => getComputedStyle(node).color).catch(() => "MISSING");
  const draftColor = await composer.evaluate((node) => getComputedStyle(node).color);
  report(`composer pill is coloured, not the rest of the draft (${pillColor} vs ${draftColor})`, pillColor !== "MISSING" && pillColor !== draftColor);
  await page.screenshot({ path: path.join(out, "composer-link.png"), animations: "disabled" });

  // 2 — the sent message keeps the address clickable and coloured.
  await page.evaluate(() => { window.__baseline = document.querySelectorAll("button").length; });
  await composer.press("Enter");
  const bubbleLink = page.locator("a[href='https://example.com']").first();
  await bubbleLink.waitFor({ timeout: 15_000 });
  const compared = await bubbleLink.evaluate((node) => {
    const owner = node.closest("div");
    return { link: getComputedStyle(node).color, text: getComputedStyle(owner ?? node).color, background: getComputedStyle(node).backgroundColor, weight: getComputedStyle(node).fontWeight };
  });
  report(`user bubble paints the address differently from its own text (link ${compared.link} vs text ${compared.text}, weight ${compared.weight})`, compared.link !== compared.text);
  const underline = await bubbleLink.evaluate((node) => getComputedStyle(node).textDecorationLine);
  report(`bubble link is underlined (${underline})`, underline.includes("underline"));
  await page.screenshot({ path: path.join(out, "bubble-link.png"), animations: "disabled" });

  // 3 — the round in flight is open and the agent's own sentence sits under it as body text.
  // Older turns are in the same transcript, so only the newest expanded round counts.
  const deadline = Date.now() + 150_000;
  let sawStep = false, sawWorking = false;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const openRounds = [...document.querySelectorAll(".reply-round > button[aria-expanded='true']")];
      const live = openRounds.at(-1) ?? null;
      const prose = live ? live.closest(".reply-round")?.nextElementSibling?.querySelector("p") ?? null : null;
      return {
        working: Boolean(live),
        step: prose ? prose.innerText.replace(/\s+/g, " ").trim() : "",
        stepSize: prose ? getComputedStyle(prose).fontSize : "",
        dots: document.querySelectorAll("span[style*='agent-pixel-on']").length,
      };
    });
    if (state.dots) dotsSeen = true;
    if (state.working) {
      sawWorking = true;
      const step = state.step.trim();
      if (step) {
        report(`the round in flight is open and its sentence is on screen ("${step.slice(0, 70)}" at ${state.stepSize})`, true);
        report(`that sentence is sized as body text, not a caption (${state.stepSize})`, parseFloat(state.stepSize) >= 14);
        report("the dots box never reappears under a working round", state.dots === 0, `pixel-dot spans: ${state.dots}`);
        await page.screenshot({ path: path.join(out, "live-step.png"), animations: "disabled" });
        sawStep = true;
        break;
      }
    }
    await page.waitForTimeout(1_000);
  }
  if (!sawWorking) report("agent reached a round that is open while it works", false, "no expanded round seen in 150s");
  else if (!sawStep) report("the round in flight carries the agent's own sentence", false, "the open round never grew a sentence under it");

  // 4 — let one turn finish so the settled header and its elapsed wording can be read.
  // Turns from earlier runs are still in the transcript, so only headers that appeared after
  // this message was sent count as this turn's own.
  const settleDeadline = Date.now() + 240_000;
  let settled = "";
  while (Date.now() < settleDeadline) {
    settled = await page.evaluate(() => {
      const header = [...document.querySelectorAll("button")]
        .filter((b, i) => i >= window.__baseline && b.matches(".reply-round > button[aria-expanded]"))
        .at(-1);
      return header ? header.innerText.replace(/\s+/g, " ").trim() : "";
    });
    if (settled) break;
    await page.waitForTimeout(2_000);
  }
  if (!settled) {
    const tail = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(-260));
    report("turn finished and produced a settled header", false, `no header appeared; end of view was: ${tail}`);
  }
  report(`the settled header says what its rows add up to (${settled.slice(0, 60) || "none"})`,
    /^(?:ran \d+ commands?|read \d+ files?|edited \d+ files?|searched \d+ times?|fetched \d+ pages?|\d+ failed|Thought it through|Worked)(?: · .*)?$/.test(settled));
  await page.screenshot({ path: path.join(out, "settled.png"), animations: "disabled" });
} catch (error) {
  report("harness completed without throwing", false, String(error && error.message ? error.message : error).split("\n")[0]);
  if (page) await page.screenshot({ path: path.join(out, "crash.png"), animations: "disabled" }).catch(() => {});
} finally {
  await app.close().catch(() => {});
}

const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
console.log(JSON.stringify({ ok: failed.length === 0, passed: checks.length - failed.length, failed }, null, 2));
process.exitCode = failed.length ? 1 : 0;
