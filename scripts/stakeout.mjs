// Endurance run: does one real turn keep working through a queue of twenty postings, or does
// it invent a stopping point half way? Launched with the app's own harness pattern; STAKEOUT_COUNT
// lowers the number of postings for a shorter sit.
//   node scripts/stakeout.mjs --fixture-only
//   STAKEOUT_COUNT=20 STAKEOUT_TIMEOUT=5400 node scripts/stakeout.mjs
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startAcmeHire } from "./fixtures/acme-hire.mjs";

const COUNT = Number(process.env.STAKEOUT_COUNT || 20);
const TIMEOUT = Number(process.env.STAKEOUT_TIMEOUT || 5400) * 1000;
const MODE = process.env.STAKEOUT_MODE || "paged";
const maze = MODE === "maze";
const OUT = ".agents/artifacts/stakeout";
const FIXTURE_ONLY = process.argv.includes("--fixture-only") || Boolean(process.env.FIXTURE_ONLY);
await fs.mkdir(OUT, { recursive: true });

const checks = [];
const check = (label, ok) => { checks.push([label, Boolean(ok)]); console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); };

const site = await startAcmeHire({ count: COUNT, captcha: true, mode: MODE });
const openIds = site.open();
const cvDir = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-stakeout-"));
await fs.writeFile(path.join(cvDir, "cv.txt"), "Shikari Adesanya — TypeScript, Node, Postgres. Four years shipping web apps.\n");

const PROMPT = maze
  ? `Open ${site.base}${site.listUrl} in the browser panel. It is one very long Acme careers page with the open roles somewhere below the company notes, so work it the way a person would: clear anything covering the page, scroll until you reach the roles, and open every department tab and every "show more" control until no posting is left unlisted. Each posting only reveals its referral code and its apply link once you open its own details, and the application is a two-step form whose second step appears after step one — the department, the code, the reason and the consent box are all checked, so read them off the page instead of filling them blind. Queue every posting you find with the batch queue, then apply to each one as Shikari Adesanya (shikari.adesanya@example.com) with cv.txt from this project as the résumé, and keep going until the queue is empty. When it is finished, tell me how many you applied to, which ones you could not finish and why, with the references the site showed.`
  : `Open ${site.base}${site.listUrl} in the browser panel. It lists every open role at Acme, across ${site.pages} page(s) — read them all and queue every posting with the batch queue. Then apply to each one: name Shikari Adesanya, email shikari.adesanya@example.com, a short reason that names the company, and attach cv.txt from this project as the résumé. Claim and finish the postings one at a time, and keep going until the queue is empty. When it is finished, tell me how many you applied to, which ones you could not finish, and why, with the references the sites showed.`;

async function readLedger(root) {
  try { return JSON.parse(await fs.readFile(path.join(root, ".calvras", "batch.json"), "utf8")); } catch { return null; }
}
const counts = (ledger) => {
  const items = ledger?.items || [];
  const of = (status) => items.filter((item) => item.status === status).length;
  return { total: items.length, queued: of("queued"), running: of("running"), done: of("done"), blocked: of("blocked"), skipped: of("skipped") };
};

if (FIXTURE_ONLY) {
  // Drives the board with plain Playwright — no agent — so a failed live run reads as an
  // agent problem rather than a broken harness. Walks every page and follows every link.
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const tab = await browser.newPage();
  const locked = site.postings.find((p) => p.captcha);
  const submitOne = async (href) => {
    const posting = site.postings.find((p) => p.id === href.split("/").pop());
    await tab.goto(`${site.base}${href}`);
    await tab.waitForSelector("#name");
    await tab.fill("#name", "Shikari Adesanya");
    await tab.fill("#email", "shikari.adesanya@example.com");
    await tab.fill("#why", `Four years of TypeScript and Node, and this ${posting.title} role at ${posting.company} is the work I want next.`);
    if (maze) await tab.click("#continue");
    await tab.waitForSelector("#submit");
    await tab.setInputFiles("#cv", path.join(cvDir, "cv.txt"));
    if (await tab.$("#agree")) await tab.check("#agree");
    if (maze) {
      await tab.selectOption("#department", posting.dept.toLowerCase());
      await tab.fill("#referral", posting.referral);
    }
    await tab.click("#submit");
    await tab.waitForSelector("#confirmation");
  };
  const hrefs = [];
  if (maze) {
    await tab.goto(`${site.base}${site.listUrl}`);
    await tab.waitForSelector("#cookie-accept");
    // The board has to be worth scrolling: the roles are far below the fold and a posting's code
    // and link exist in no readable form until its own card is opened.
    const height = await tab.evaluate(() => document.body.scrollHeight);
    const wall = await tab.evaluate(() => getComputedStyle(document.getElementById("cookie-scrim")).position);
    const before = await tab.evaluate(() => document.body.innerText);
    check(`fixture: the maze page is ${height}px tall, so the roles are below the fold`, height > 4000);
    check(`fixture: a full-screen consent wall covers it (${wall})`, wall === "fixed");
    check(`fixture: no referral code is readable before a card is clicked`, !/ACME-\d/.test(before));
    await tab.click("#cookie-accept");
    for (const dept of await tab.$$eval(".dept", (els) => els.map((el) => el.dataset.dept))) {
      await tab.click(`.dept[data-dept="${dept}"]`);
      for (;;) {
        await tab.$$eval(".reveal:not(.is-open)", (buttons) => buttons.forEach((button) => button.click()));
        if (!(await tab.$("#more:not([hidden])"))) break;
        await tab.click("#more");
      }
      hrefs.push(...(await tab.$$eval("a.apply", (anchors) => anchors.map((anchor) => anchor.getAttribute("href")))));
    }
    check(`fixture: ${hrefs.length} posting links reachable only by clicking through tabs and details`, hrefs.length === COUNT);
  } else {
    for (let page = 1; page <= site.pages; page += 1) {
      await tab.goto(`${site.base}${site.listUrl}?page=${page}`);
      await tab.waitForSelector(".role");
      hrefs.push(...(await tab.$$eval(".role a", (anchors) => anchors.map((link) => link.getAttribute("href")))));
      await tab.goto(`${site.base}${site.listUrl}?page=${page}`);
    }
  }
  for (const href of hrefs.filter((link) => link !== `/post/${locked?.id}`)) await submitOne(href);
  // Then prove the captcha posting cannot be satisfied by guessing.
  await tab.goto(`${site.base}/post/${locked.id}`);
  await tab.fill("#name", "Shikari Adesanya");
  await tab.fill("#email", "shikari.adesanya@example.com");
  await tab.fill("#why", `Four years of TypeScript and Node, and this ${locked.title} role at ${locked.company} is the work I want next.`);
  if (maze) await tab.click("#continue");
  await tab.waitForSelector("#submit");
  await tab.setInputFiles("#cv", path.join(cvDir, "cv.txt"));
  await tab.fill("#captcha", "GUESS123");
  await tab.click("#submit");
  await tab.waitForSelector("#error");
  await browser.close();
  const ids = site.applications.map((record) => record.id);
  const mismatched = site.applications.filter((record) => {
    const posting = site.postings.find((p) => p.id === record.id);
    return record.referral !== posting.referral || record.department !== posting.dept.toLowerCase();
  });
  check(`fixture: ${site.pages} page(s) of ${COUNT} postings walkable`, site.pages >= 1 && openIds.length === COUNT - 1);
  check(`fixture: every open posting recorded (${ids.join(",") || "none"})`, openIds.every((id) => ids.includes(id)));
  check(`fixture: one application per posting (${ids.length} for ${openIds.length} open)`, new Set(ids).size === ids.length && ids.length === openIds.length);
  check(`fixture: each application carries a résumé (${site.applications.every((r) => String(r.file) === "cv.txt")})`, site.applications.every((record) => path.basename(String(record.file || "")) === "cv.txt"));
  check(`fixture: ${maze ? `every application read its own code and department (${site.applications.length - mismatched.length}/${site.applications.length}${mismatched.length ? `: ${mismatched.map((r) => `${r.id}:${r.referral}/${r.department}`).join(",")}` : ""})` : "board was the paged one, so no code-reading proof to make"}`, !maze || mismatched.length === 0);
  check(`fixture: captcha posting never stored (${site.rejections.map((r) => r.reason).join(",") || "none"})`, !ids.includes(locked.id) && site.rejections.every((r) => r.reason === "guess"));
  site.close();
  const bad = checks.filter(([, ok]) => !ok);
  await fs.rm(cvDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  console.log(JSON.stringify({ ok: bad.length === 0, checks }, null, 2));
  process.exit(bad.length ? 1 : 0);
}

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
// Whatever the main process prints is the only record of a tool that never came back, so keep it.
// Playwright does not expose the Electron child's pipes, so the window console is the log that
// survives — it carries the agent loop's own `[agent loop failed]` warnings and tool errors.
const mainLog = [];
const remember = (line) => { mainLog.push(String(line)); if (mainLog.length > 6000) mainLog.splice(0, mainLog.length - 6000); };
const child = typeof app.process === "function" ? app.process() : null;
child?.stdout?.on("data", (chunk) => remember(`[stdout] ${String(chunk).trim()}`));
child?.stderr?.on("data", (chunk) => remember(`[stderr] ${String(chunk).trim()}`));
let page; let accountKey = null; let savedAccount = null;
const startedAt = Date.now();
const timeline = [];
let stoppedByTimeout = false;

try {
  page = await app.firstWindow();
  page.on("console", (message) => remember(`[renderer:${message.type()}] ${message.text().slice(0, 400)}`));
  await page.waitForLoadState("domcontentloaded");
  accountKey = await page.evaluate(() => {
    const user = JSON.parse(localStorage.getItem("calvras_user") || "null");
    return user?.email ? `calvras/account/${user.email.toLowerCase()}` : null;
  });
  if (!accountKey) throw new Error("the app is not signed in, so there is no account shelf to point at the proof folder");
  savedAccount = await page.evaluate((prefix) => ({
    chats: localStorage.getItem(`${prefix}/chats`),
    recents: localStorage.getItem(`${prefix}/recents`),
    projects: localStorage.getItem(`${prefix}/projects`),
    activeProject: localStorage.getItem(`${prefix}/activeProject`),
  }), accountKey);
  const root = path.join(cvDir, "project");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "cv.txt"), "Shikari Adesanya — TypeScript, Node, Postgres. Four years shipping web apps.\n");
  await page.evaluate(([prefix, dir]) => {
    const projects = [{ name: "Stakeout Proof", path: dir }];
    localStorage.setItem(`${prefix}/projects`, JSON.stringify(projects));
    localStorage.setItem(`${prefix}/activeProject`, JSON.stringify(projects[0]));
    localStorage.setItem(`${prefix}/chats`, "{}");
    localStorage.setItem(`${prefix}/recents`, "[]");
    localStorage.setItem("calvras_access_mode", "full");
  }, [accountKey, root]);
  await page.reload();
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });

  const input = page.getByRole("textbox", { name: "Prompt" });
  await input.click({ force: true });
  await input.fill(PROMPT);
  await input.press("Enter");
  await page.getByRole("button", { name: "Stop task" }).waitFor({ timeout: 120_000 });

  // Poll the durable ledger while the run works, so the record shows steady progress rather
  // than only the state at the end. A run can sit here for an hour, so the live line the app is
  // showing goes to stdout too — otherwise a stalled turn and a slow turn look identical from here.
  let lastLine = "";
  let lastShot = 0;
  const poll = setInterval(() => {
    void readLedger(root).then((ledger) => {
      if (!ledger) return;
      const state = counts(ledger);
      const last = timeline[timeline.length - 1];
      if (!last || last.total !== state.total || last.done !== state.done || last.running !== state.running || last.blocked !== state.blocked) {
        timeline.push({ at: Math.round((Date.now() - startedAt) / 1000), ...state });
      }
    }).catch(() => {});
    void page.evaluate(() => {
      const whole = document.body.innerText.replace(/\s+/g, " ");
      // The browser dock sits after the composer and never changes, so reading the tail of the
      // body shows the same sentence whether the turn is flying or frozen.
      const cut = whole.indexOf("Ask anything");
      return (cut > 0 ? whole.slice(0, cut) : whole).slice(-240);
    }).then((line) => {
      if (line === lastLine) return;
      lastLine = line;
      console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${line}`);
    }).catch(() => {});
    if (Date.now() - lastShot > 60_000) {
      lastShot = Date.now();
      void page.screenshot({ path: path.join(OUT, "live-progress.png"), animations: "disabled" }).catch(() => {});
    }
  }, 10_000);

  const deadline = setTimeout(() => { stoppedByTimeout = true; }, TIMEOUT);
  try {
    await page.getByRole("button", { name: "Stop task" }).waitFor({ state: "detached", timeout: TIMEOUT });
  } catch {
    if (!stoppedByTimeout) throw new Error(`the run did not end on its own: ${String(TIMEOUT / 60000)} min waited`);
    await page.getByRole("button", { name: "Stop task" }).click({ force: true }).catch(() => {});
    await page.getByRole("button", { name: "Stop task" }).waitFor({ state: "detached", timeout: 120_000 }).catch(() => {});
  }
  clearTimeout(deadline); clearInterval(poll);

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  await page.screenshot({ path: path.join(OUT, "stakeout.png"), animations: "disabled" }).catch(() => {});
  const transcript = await page.getByLabel("Conversation").innerText().catch(() => "");
  await fs.writeFile(path.join(OUT, "stakeout-transcript.txt"), transcript);
  // The rendered bubble can be empty while the stored turn holds the whole trace, so the account's
  // own chat record is what makes a stopped-short run diagnosable after the app is closed.
  const chatState = await page.evaluate((prefix) => String(localStorage.getItem(`${prefix}/chats`) || "{}"), accountKey).catch(() => "{}");
  await fs.writeFile(path.join(OUT, "chat-state.json"), chatState);
  const storedTurns = (() => {
    try {
      const chats = JSON.parse(chatState);
      return Object.values(chats).flatMap((chat) => Array.isArray(chat?.messages) ? chat.messages : []);
    } catch { return []; }
  })();
  const lastAssistant = storedTurns.filter((message) => message?.role === "assistant").at(-1) || {};
  const lastText = String(lastAssistant?.content || lastAssistant?.text || "").replace(/\s+/g, " ");
  console.log(`stakeout: last stored assistant turn (${lastText.slice(0, 240) || "empty"} | status ${lastAssistant?.status || "?"} | parts ${Array.isArray(lastAssistant?.parts) ? lastAssistant.parts.length : 0})`);
  await fs.writeFile(path.join(OUT, "stakeout.json"), JSON.stringify({ elapsed, stoppedByTimeout, timeline, transcript, lastAssistant }, null, 2));
  await fs.writeFile(path.join(OUT, "ledger.json"), JSON.stringify(await readLedger(root) || {}, null, 2)).catch(() => {});
  const ledger = counts(await readLedger(root));
  // A target closed "done" has to quote the reference its OWN posting was issued. Membership in the
  // set of codes the site handed out is not enough: a run that copies the last receipt it saw banks a
  // submission it never made, and on a 1000-target board nothing else would ever surface that.
  const doneItems = ((await readLedger(root))?.items || []).filter((item) => item.status === "done");
  const wrongRef = doneItems.filter((item) => {
    const posting = String(item.id).split("/").pop();
    const record = site.applications.find((application) => String(application.id) === posting);
    return !record || String(record.reference) !== String(item.reference || "");
  });

  check(`stakeout: ran ${elapsed}s and reached the queue${stoppedByTimeout ? ` after hitting the ${Math.round(TIMEOUT / 60000)} min ceiling` : ""}`, !stoppedByTimeout);
  check(`stakeout: durable ledger holds the board (${JSON.stringify(ledger)} of ${COUNT} postings)`, ledger.total >= openIds.length);
  check(`stakeout: nothing left claimed or waiting at the end (${ledger.queued} queued, ${ledger.running} running)`, ledger.queued === 0 && ledger.running === 0);
  check(`stakeout: every target ended with an outcome (${ledger.done} done, ${ledger.blocked} blocked, ${ledger.skipped} skipped of ${ledger.total})`, ledger.done + ledger.blocked + ledger.skipped === ledger.total && ledger.total > 0);
  const appliedIds = site.applications.map((record) => record.id);
  await fs.writeFile(path.join(OUT, "site-records.json"), JSON.stringify({ applications: site.applications, rejections: site.rejections }, null, 2));
  check(`stakeout: site received every open posting (${appliedIds.length}/${openIds.length})`, openIds.every((id) => appliedIds.includes(id)));
  check(`stakeout: no posting applied twice (${appliedIds.join(",") || "none"})`, new Set(appliedIds).size === appliedIds.length);
  check(`stakeout: never touched the captcha posting (${appliedIds.includes(site.postings.find((p) => p.captcha).id) ? "APPLIED" : "clean"}, ${site.rejections.filter((r) => r.reason === "guess").length} guess(es))`, !appliedIds.includes(site.postings.find((p) => p.captcha).id) && site.rejections.every((r) => r.reason !== "guess"));
  check(`stakeout: every application carried the résumé (${site.applications.map((r) => r.file).join(",") || "none"})`, site.applications.every((record) => path.basename(String(record.file || "")) === "cv.txt"));
  check(`stakeout: ledger done count matches the site (${ledger.done} vs ${appliedIds.length})`, ledger.done === appliedIds.length);
  check(`stakeout: every done target quotes its own posting's reference (${doneItems.length - wrongRef.length}/${doneItems.length}${wrongRef.length ? `: ${wrongRef.map((item) => `${item.id}="${item.reference || "nothing"}"`).join(", ")}` : ""})`, wrongRef.length === 0);
  // On the maze board the referral code and department only exist inside a card nobody can read
  // without clicking it, so a submission carrying the right pair proves the page was worked.
  const blind = maze ? site.applications.filter((record) => {
    const posting = site.postings.find((p) => p.id === record.id);
    return String(record.referral || "").toUpperCase() !== posting.referral || record.department !== posting.dept.toLowerCase();
  }) : [];
  check(`stakeout: ${maze ? `every application read its own code and department (${site.applications.length - blind.length}/${site.applications.length}${blind.length ? `: ${blind.map((record) => `${record.id}="${record.referral || ""}/${record.department || ""}"`).join(", ")}` : ""})` : "board was the paged one, so no code-reading proof to make"}`, !maze || blind.length === 0);
  check(`stakeout: progress was monotonic, never re-opened work (${timeline.map((t) => t.done).join(">")})`, timeline.every((entry, index) => index === 0 || entry.done + entry.blocked + entry.skipped >= timeline[index - 1].done + timeline[index - 1].blocked + timeline[index - 1].skipped));
  check(`stakeout: the run left a readable final report (${lastText.slice(0, 90) || "nothing stored"})`, lastText.length > 40 || transcript.replace(/\s+/g, " ").slice(-90).length > 40);
  check(`stakeout: the reply never claims a stop it did not take (${transcript.replace(/\s+/g, " ").slice(-140)})`, !/Stopping for now\.|Stopped for now\.|I stopped with this still open|Action limit reached|could not reach the model|Pick it back up/i.test(transcript));
  check(`stakeout: the reply counts what the site actually received (${(transcript.match(/\b\d+\b/g) || []).slice(0, 8).join(",") || "no numbers"})`,
    transcript.toUpperCase().includes(String(appliedIds.length)) || site.applications.some((record) => transcript.toUpperCase().includes(record.reference)));
  const locked = site.postings.find((p) => p.captcha);
  check(`stakeout: the reply names the one it could not finish (${transcript.replace(/\s+/g, " ").match(/captcha[^.]{0,90}/i)?.[0] || "no mention"})`,
    appliedIds.length === openIds.length && /captcha/i.test(transcript));
} catch (error) {
  check(`stakeout: run stopped early (${String(error.message).split("\n")[0].slice(0, 160)})`, false);
  if (page) await page.screenshot({ path: path.join(OUT, "stakeout-failure.png"), animations: "disabled" }).catch(() => {});
} finally {
  // A stall inside the main process leaves no trace in the renderer, and the app is closed by the
  // time anyone reads the report — so the captured stdout/stderr goes to the artifact folder.
  await fs.writeFile(path.join(OUT, "electron-main.log"), mainLog.join("\n")).catch(() => {});
  if (page && accountKey && savedAccount) await page.evaluate(([prefix, saved]) => {
    for (const [name, value] of Object.entries(saved)) { if (value === null) localStorage.removeItem(`${prefix}/${name}`); else localStorage.setItem(`${prefix}/${name}`, value); }
  }, [accountKey, savedAccount]).catch(() => {});
  await app.close().catch(() => {});
  site.close();
  await fs.rm(cvDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}

const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({ ok: failed.length === 0, count: COUNT, mode: MODE, checks }, null, 2));
process.exit(failed.length ? 1 : 0);
