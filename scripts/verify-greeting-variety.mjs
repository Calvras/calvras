// Proves a greeting is not a canned line: three "hey" turns in one conversation must
// come back worded differently, and the nav panel is screenshotted so its curve can be read.
import { _electron as electron } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";

const OUT = ".agents/artifacts/greeting-variety";
await fs.mkdir(OUT, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: ["."],
  env,
  timeout: 60_000,
});

const results = { passed: [], failed: [] };
const record = (label, ok, detail = "") => results[ok ? "passed" : "failed"].push(`${label}${detail ? ` — ${detail}` : ""}`);

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.waitFor({ timeout: 60_000 });

  const before = await page.evaluate(() => localStorage.getItem("calvras_chat_messages"));
  await fs.writeFile(path.join(OUT, "messages.before.json"), before ?? "null");
  // Start from an empty transcript so the only greetings in history are the ones under test.
  await page.evaluate(() => localStorage.removeItem("calvras_chat_messages"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await prompt.waitFor({ timeout: 60_000 });

  const turn = async () => page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[aria-label="Conversation"] [id^="msg-"]')];
    return nodes.filter((node) => !node.querySelector("textarea")).map((node) => node.innerText).at(-1) ?? "";
  });

  const waitReply = async (seen = "") => {
    for (let i = 0; i < 20; i++) {
      const latest = await turn();
      if (latest && latest !== seen) return latest;
      await page.waitForTimeout(1500);
    }
    return turn();
  };

  const send = async (text) => {
    const seen = await turn();
    await prompt.fill(text);
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    const stop = page.getByRole("button", { name: "Stop task", exact: true });
    await stop.waitFor({ timeout: 30_000 });
    await stop.waitFor({ state: "detached", timeout: 240_000 });
    return waitReply(seen);
  };

  const replies = [];
  for (let i = 0; i < 3; i++) {
    if (i === 0) {
      // The "Working" pill is only on screen mid-run, so read it during the first turn.
      await prompt.fill("hey");
      await page.getByRole("button", { name: "Send prompt", exact: true }).click();
      const state = page.locator(".workspace-run-state");
      await state.waitFor({ timeout: 30_000 });
      const runState = await state.evaluate((node) => ({
        text: node.innerText.trim(),
        children: [...node.children].map((child) => child.className),
        animated: [...node.querySelectorAll("*")].filter((child) => getComputedStyle(child).animationName !== "none").map((child) => child.className),
      }));
      await fs.writeFile(path.join(OUT, "run-state.json"), JSON.stringify(runState, null, 2));
      record("the Working pill has no pulsing dot", runState.children.length === 1 && runState.animated.length === 0, JSON.stringify(runState));
      const stop = page.getByRole("button", { name: "Stop task", exact: true });
      await stop.waitFor({ state: "detached", timeout: 240_000 });
      replies.push(await waitReply());
      continue;
    }
    replies.push(await send("hey"));
  }
  await fs.writeFile(path.join(OUT, "replies.json"), JSON.stringify(replies, null, 2));
  await page.screenshot({ path: path.join(OUT, "chat.png"), animations: "disabled" });

  const bodies = replies.map((reply) => reply.replace(/^Thought for [^\n]*\n/, "").trim());
  for (const [i, body] of bodies.entries()) {
    record(`greeting ${i + 1} answered`, body.length > 0, body.slice(0, 120));
    record(`greeting ${i + 1} never mentions the workspace`, !/\b(project|folder|workspace|repository)\b/i.test(body), body.slice(0, 160));
    record(`greeting ${i + 1} does not offer a task menu`, !/what would you like to work on|how can I help you with|what do you want to build\?/i.test(body), body.slice(0, 160));
  }
  const distinct = new Set(bodies.map((body) => body.toLowerCase())).size;
  record("the three greetings are worded differently from each other", distinct === 3, `distinct=${distinct}: ${JSON.stringify(bodies)}`);

  // The nav panel: open Projects so the sidebar is on screen, then shoot the whole window.
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.waitForTimeout(700);
  const panel = page.locator(".app-sidebar");
  await panel.waitFor({ timeout: 10_000 });
  const style = await panel.evaluate((node) => {
    const css = getComputedStyle(node);
    const railCss = getComputedStyle(document.querySelector(".app-rail"));
    return {
      radius: css.borderRadius,
      left: css.left, top: css.top,
      railRadius: railCss.borderRadius, railLeft: railCss.left, railTop: railCss.top,
    };
  });
  await fs.writeFile(path.join(OUT, "panel-style.json"), JSON.stringify(style, null, 2));
  const radiusPx = parseFloat(style.radius);
  record("the sidebar is rounded", radiusPx >= 12, style.radius);
  record("the sidebar is inset from the window edge", parseFloat(style.left) >= 16, style.left);
  record("the rail is rounded", parseFloat(style.railRadius) >= 12, style.railRadius);
  record("the rail is inset from the window edge", parseFloat(style.railLeft) >= 8, style.railLeft);
  await page.screenshot({ path: path.join(OUT, "sidebar.png"), animations: "disabled" });

  await page.evaluate((restore) => { if (restore === null) localStorage.removeItem("calvras_chat_messages"); else localStorage.setItem("calvras_chat_messages", restore); }, before);
} finally {
  await app.close();
}

console.log(JSON.stringify({ ok: results.failed.length === 0, ...results }, null, 2));
process.exit(results.failed.length ? 1 : 0);
