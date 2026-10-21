// A question that asks for items must come back as a list, on screen, from the real app.
// Two modes: the capabilities answer (full list + one follow-up question) and an ordinary
// "just list 20" request, which used to come back as one comma-separated sentence.
//   node scripts/live-capabilities-check.mjs
//   LIVE_MODE=list node scripts/live-capabilities-check.mjs
//   LIVE_PROMPT=... LIVE_WAIT_MS=... node scripts/live-capabilities-check.mjs
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LIST_MODE = process.env.LIVE_MODE === "list";
const PROMPT = process.env.LIVE_PROMPT || (LIST_MODE ? "just list 20 languages you can write code in" : "what can you do");
const OUT = `.agents/artifacts/${LIST_MODE ? "live-list" : "live-capabilities"}`;
const WAIT_MS = Number(process.env.LIVE_WAIT_MS || 180_000);
await fs.mkdir(OUT, { recursive: true });

const checks = [];
const check = (label, ok) => { checks.push([label, Boolean(ok)]); console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); };

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
const page = await app.firstWindow();
let accountKey = null; let saved = null;
try {
  await page.waitForLoadState("domcontentloaded");
  accountKey = await page.evaluate(() => {
    const user = JSON.parse(localStorage.getItem("calvras_user") || "null");
    return user?.email ? `calvras/account/${user.email.toLowerCase()}` : null;
  });
  if (!accountKey) throw new Error("the app is not signed in");
  saved = await page.evaluate((prefix) => ({ chats: localStorage.getItem(`${prefix}/chats`), recents: localStorage.getItem(`${prefix}/recents`), projects: localStorage.getItem(`${prefix}/projects`), activeProject: localStorage.getItem(`${prefix}/activeProject`) }), accountKey);
  // An empty transcript and full access: nothing here should need a folder or an approval.
  await page.evaluate((prefix) => {
    localStorage.setItem(`${prefix}/chats`, "{}");
    localStorage.setItem(`${prefix}/recents`, "[]");
    localStorage.setItem("calvras_access_mode", "full");
  }, accountKey);
  await page.reload();
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });

  const input = page.getByRole("textbox", { name: "Prompt" });
  const sentAt = Date.now();
  await input.click({ force: true });
  await input.fill(PROMPT);
  await input.press("Enter");

  let finishedAt = 0;
  while (Date.now() < sentAt + WAIT_MS) {
    const running = await page.evaluate(() => Boolean(document.querySelector('button[aria-label="Stop task"]'))).catch(() => false);
    if (!running && Date.now() - sentAt > 4_000) { finishedAt = Date.now(); break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(`turn ${finishedAt ? `ended after ${((finishedAt - sentAt) / 1000).toFixed(1)}s` : "never ended inside the wait"}`);
  await page.screenshot({ path: path.join(OUT, "capabilities.png"), fullPage: false, animations: "disabled" }).catch(() => {});

  const readTranscript = () => page.evaluate((prefix) => {
    const chats = JSON.parse(localStorage.getItem(`${prefix}/chats`) || "{}");
    const turn = Object.values(chats).flatMap((chat) => chat?.messages || []).slice(-1)[0];
    const phases = turn?.phases || [];
    return {
      status: turn?.status || null,
      tools: phases.flatMap((phase) => (phase.trace || []).filter((node) => node.toolName).map((node) => node.toolName)),
      // Each phase carries the message the turn was telling at that moment, so the same final
      // sentence can appear several times; the last one is what the user is left looking at.
      said: phases.map((phase) => String(phase.message || "").trim()).filter(Boolean).length,
      reply: [...new Set(phases.map((phase) => String(phase.message || "").trim()).filter(Boolean))].join("\n\n"),
    };
  }, accountKey).catch(() => ({ status: null, tools: [], said: 0, reply: "" }));
  let transcript = await readTranscript();
  for (let waited = 0; waited < 15_000 && !transcript.reply; waited += 1_000) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    transcript = await readTranscript();
  }
  // The rendered reply, because a list the model wrote is only a list once the bubble shows it as one.
  const rendered = await page.evaluate(() => {
    const bubble = [...document.querySelectorAll("ul, ol")].sort((a, b) => b.querySelectorAll("li").length - a.querySelectorAll("li").length)[0];
    return { items: bubble ? [...bubble.querySelectorAll("li")].map((li) => li.textContent.trim()) : [], text: document.body.innerText };
  }).catch(() => ({ items: [], text: "" }));

  // The bug the user screenshotted: the list landed, then the unfinished-work card appeared under
  // it, and pressing it sent the app's own task brief back at a conversation answer for a second copy.
  const carryOn = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll("button")].filter((button) => /Pick it back up/.test(button.textContent)).length,
    card: /work unfinished|action ceiling|steps still open/i.test(document.body.innerText),
  })).catch(() => ({ buttons: 0, card: false }));
  check(`no unfinished-work card and no "Pick it back up" under an answer (${carryOn.buttons} button(s), card ${carryOn.card ? "shown" : "absent"})`, carryOn.buttons === 0 && !carryOn.card);

  const reply = transcript.reply || rendered.text;
  console.log(`reply:\n${reply.slice(0, 2600)}\n--- end ---`);
  // A numbered list is as much a list as a bulleted one — the model picks either for a run of steps.
  const bullets = reply.split("\n").filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line));
  console.log(`${transcript.tools.length} tool call(s): ${transcript.tools.join(", ") || "(none)"}; ${bullets.length} bullet line(s) in the reply; ${rendered.items.length} rendered list item(s)`);

  check(`the answer is a list of ${bullets.length} bullets, not a paragraph`, bullets.length >= (LIST_MODE ? 10 : 8));
  check(`the page renders it as ${rendered.items.length} list items`, rendered.items.length >= (LIST_MODE ? 10 : 8));
  // The failure this catches: twenty names packed into one comma-separated sentence. Only measured
  // in list mode — a capability bullet legitimately enumerates its own parts ("routes, database, auth").
  if (LIST_MODE) {
    const packed = reply.split("\n").filter((line) => /\b\w+,\s*\w+,\s*\w+,\s*\w+\b/.test(line));
    check(`no line packs four names into commas — each item on its own line${packed.length ? ` (offender: "${packed[0].slice(0, 60)}")` : ""}`, packed.length === 0);
    check(`it answered the list request with the items themselves, not a sentence about them`, bullets.length >= 10 && !/i don.t keep track|depends on what|are you looking to/i.test(reply));
  } else {
    check("it names the concrete things: the browser panel, the terminal, bulk web work, git, subagents",
      ["browser", "terminal", "git", "schedul", "subagent|worker|parallel", "bulk|hundreds"].every((needle) => new RegExp(needle, "i").test(reply)));
    const genericClose = /what would you like to work on\s*\?/i.test(reply);
    check(`it does not close with the generic "what would you like to work on?"`, !genericClose);
    const tail = reply.trim();
    const lastLine = tail.split("\n").slice(-1)[0];
    const questionCount = (tail.match(/\?/g) || []).length;
    check(`it ends on exactly one follow-up question (${questionCount} "?" in the reply, last line "${lastLine.slice(0, 80)}")`, tail.endsWith("?") && questionCount === 1);
    check("the final line is a question rather than another capability", lastLine.includes("?"));
  }
  check(`the answer came without running a tool (${transcript.tools.length} calls)`, transcript.tools.length === 0);
  // The bug this catches: the answer landed, and the loop asked the model again under Thinking…,
  // so the same list arrived two and three times.
  check(`it said it once — ${transcript.said} round(s) spoke, not ${transcript.said > 1 ? "repeats" : "none"}`, transcript.said === 1);
  check(`the turn recorded as ${transcript.status || "nothing"}, not a stopped run`, transcript.status === "finished");
  check(`the turn ended on its own`, Boolean(finishedAt));

  await page.evaluate((snapshot) => {
    const prefix = snapshot.prefix;
    for (const [key, value] of Object.entries(snapshot.values)) { if (value === null) localStorage.removeItem(`${prefix}/${key}`); else localStorage.setItem(`${prefix}/${key}`, value); }
  }, { prefix: accountKey, values: saved });
} finally {
  await app.close().catch(() => {});
}

const bad = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({ ok: bad.length === 0, checks }, null, 2));
process.exit(bad.length ? 1 : 0);
