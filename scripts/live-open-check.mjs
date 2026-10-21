// A real website, a real two-part instruction, and the durable record of what the agent did after
// the page opened. The first half (does the panel reach the site in seconds) was already proven;
// this run answers the question the user actually asked: once a page is open, does it keep going —
// read it, click the thing it was told to click — and does it say something true about it?
//   node scripts/live-open-check.mjs
//   LIVE_URL=... LIVE_WAIT_MS=... node scripts/live-open-check.mjs
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const URL_TO_OPEN = process.env.LIVE_URL || "https://news.ycombinator.com";
const OUT = ".agents/artifacts/live-open";
const WAIT_MS = Number(process.env.LIVE_WAIT_MS || 300_000);
await fs.mkdir(OUT, { recursive: true });

const checks = [];
const check = (label, ok) => { checks.push([label, Boolean(ok)]); console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); };
const PROMPT = `Open ${URL_TO_OPEN} in the browser panel, tell me the top story on it, then click that story and tell me what its page says.`;

/** The page as the user would read it, fetched here so the reply can be checked against the real
 * words instead of against whatever the model believed. */
async function groundTruth() {
  const html = await fetch(URL_TO_OPEN, { headers: { "user-agent": "Mozilla/5.0" } }).then((response) => response.text()).catch(() => "");
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  // Hacker News puts the headline in the first titleline; other sites get the first <h1>/<h2>.
  const headline = /class="titleline"><a[^>]*>([^<]{12,})<\/a>/.exec(html)?.[1]
    || /<h[12][^>]*>([^<]{12,})<\/h[12]>/.exec(html)?.[1] || "";
  return { text, headline: headline.replace(/&amp;/g, "&").trim() };
}

/** Does the reply carry a phrase the page really prints, rather than a plausible invention? */
function sharesPhrase(reply, source) {
  const words = source.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const haystack = reply.toLowerCase();
  for (let length = 5; length >= 3; length -= 1) {
    for (let start = 0; start + length <= words.length; start += 1) {
      const phrase = words.slice(start, start + length).join(" ");
      if (phrase.length >= 14 && haystack.includes(phrase)) return phrase;
    }
  }
  return "";
}

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
  const root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "calvras-liveopen-")), "project");
  await fs.mkdir(root, { recursive: true });
  await page.evaluate(([prefix, dir]) => {
    const projects = [{ name: "Live Open Check", path: dir }];
    localStorage.setItem(`${prefix}/projects`, JSON.stringify(projects));
    localStorage.setItem(`${prefix}/activeProject`, JSON.stringify(projects[0]));
    localStorage.setItem(`${prefix}/chats`, "{}");
    localStorage.setItem(`${prefix}/recents`, "[]");
    localStorage.setItem("calvras_access_mode", "full");
  }, [accountKey, root]);
  await page.reload();
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });

  const truth = await groundTruth();
  console.log(`ground truth: headline "${truth.headline}", ${truth.text.length} characters of page text`);

  const input = page.getByRole("textbox", { name: "Prompt" });
  const sentAt = Date.now();
  await input.click({ force: true });
  await input.fill(PROMPT);
  await input.press("Enter");

  // One sampler for the whole turn: the panel's own address bar says when the page is really
  // open, and the chat column says what the user was told at that moment. Sampling from the send
  // rather than from the open means a turn that never opens anything still leaves a record.
  const host = new URL(URL_TO_OPEN).hostname;
  const samples = [];
  let openedAt = 0;
  let finishedAt = 0;
  const deadline = sentAt + WAIT_MS;
  while (Date.now() < deadline) {
    const seen = await page.evaluate(() => {
      const field = document.querySelector('input[aria-label="Browser address"]');
      const whole = document.body.innerText.replace(/\s+/g, " ");
      const cut = whole.indexOf("Ask anything");
      return {
        address: field ? String(field.value || field.getAttribute("value") || "") : "(no panel)",
        running: Boolean(document.querySelector('button[aria-label="Stop task"]')),
        chat: (cut > 0 ? whole.slice(0, cut) : whole).trim().slice(-260),
      };
    }).catch(() => null);
    if (!seen) break;
    if (!openedAt && seen.address.includes(host)) openedAt = Date.now();
    if (openedAt && !seen.running) { finishedAt = Date.now(); break; }
    if (samples[samples.length - 1]?.chat !== seen.chat) {
      samples.push({ at: Math.round((Date.now() - sentAt) / 1000), ...seen });
      console.log(`[${samples[samples.length - 1].at}s] ${seen.chat}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const openSeconds = openedAt ? (openedAt - sentAt) / 1000 : -1;
  check(`the panel reached ${host} in ${openSeconds.toFixed(1)}s, under the 10s the user budgets`, Boolean(openedAt) && openSeconds <= 10);
  await page.screenshot({ path: path.join(OUT, "live-open.png"), animations: "disabled" }).catch(() => {});
  const afterOpen = samples.filter((sample) => sample.at >= Math.round(openSeconds));
  const stale = afterOpen.filter((sample) => /opening the page/i.test(sample.chat) && !/done: opening the page/i.test(sample.chat));
  check(`${stale.length ? `the step still read "Opening the page" at ${stale.map((s) => `${s.at}s`).join(",")}` : "the line never claimed a finished action as the current one"}`, Boolean(openedAt) && stale.length === 0);
  check(`the turn kept talking while it worked (${samples.length} distinct lines seen)`, samples.length >= 2);
  check(`the turn ended on its own after ${finishedAt ? ((finishedAt - sentAt) / 1000).toFixed(0) : "the whole wait"}s`, Boolean(finishedAt));

  // Two records of the same turn: the transcript the run wrote into storage (every tool call it
  // actually made), and the timeline the user can expand on screen. Either alone can be missing —
  // the store lands a beat late, the card stays collapsed — so read both and say what was seen.
  const readTranscript = () => page.evaluate((prefix) => {
    const chats = JSON.parse(localStorage.getItem(`${prefix}/chats`) || "{}");
    const messages = Object.values(chats).flatMap((chat) => chat?.messages || []);
    // A turn is stored as one message: what the user said, with the agent's phases attached to it.
    // There is no separate assistant row to go looking for.
    const turn = messages[messages.length - 1];
    const phases = turn?.phases || [];
    return {
      stored: Object.keys(chats).length,
      shape: messages.map((message) => `${message.role}×${(message.phases || []).length}ph/${(message.phases || []).flatMap((phase) => phase.trace || []).length}tr`),
      tools: phases.flatMap((phase) => (phase.trace || []).filter((node) => node.toolName).map((node) => node.toolName)),
      reply: phases.map((phase) => phase.message).filter(Boolean).join("\n"),
    };
  }, accountKey).catch(() => ({ stored: -1, shape: [], tools: [], reply: "" }));
  let transcript = await readTranscript();
  for (let waited = 0; waited < 15_000 && !transcript.tools.length; waited += 1_000) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    transcript = await readTranscript();
  }
  const onScreen = await page.evaluate(() => {
    const whole = document.body.innerText.replace(/\s+/g, " ");
    const cut = whole.indexOf("Ask anything");
    return (cut > 0 ? whole.slice(0, cut) : whole).trim();
  }).catch(() => "");
  const reply = transcript.reply || onScreen;
  console.log(`${transcript.stored} chat(s) stored; ${transcript.shape.join(" / ") || "no messages"}; tools: ${transcript.tools.join(", ") || "(none recorded)"}`);
  console.log(`reply: ${reply.slice(-500)}`);
  const after = transcript.tools.slice(transcript.tools.indexOf("open_browser") + 1);
  check(`it carried on past the open with ${after.length} further page moves (${after.join(", ")})`, transcript.tools.includes("open_browser") && after.length >= 2);
  const phrase = sharesPhrase(reply, truth.headline || truth.text);
  check(`its report quoted the real page ("${phrase}") instead of inventing a headline`, Boolean(phrase));
  const moved = after.some((tool) => ["read_page", "take_screenshot", "scroll_page", "click_at", "click_element", "fill_input", "type_into_page", "press_page_key", "navigate_browser", "wait_for_element", "upload_file_to_page", "run_page_script"].includes(tool));
  check(`the moves it made were real page actions (${[...new Set(after)].join(", ")})`, moved);

  const claimedStop = await page.evaluate(() => /stopped right here/i.test(document.body.innerText)).catch(() => false);
  check(`a run that did work never claims "Stopped right here" with nothing written`, !claimedStop);
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
