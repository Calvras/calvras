// Proves the file-attachment path without needing the model: the exact IPC the agent's
// upload_file_to_page uses (browser-set-file-input) is called against a real <input type=file>
// in the app's own browser panel, and the proof is the multipart body the fixture server
// received. It also proves the security boundary: if the user answers "Don't allow" to the
// native confirm, the same call must refuse to read the file.
import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const OUT = ".agents/artifacts/file-attach";
await fs.mkdir(OUT, { recursive: true });
const checks = [];
const check = (label, ok) => { checks.push([label, Boolean(ok)]); console.log(`${ok ? "PASS" : "FAIL"} — ${label}`); };

const SENTINEL = `calvras-sentinel-${crypto.randomBytes(4).toString("hex")}`;
const RESUME = `CURRICULUM VITAE\nName: Iyana Okonkwo\nEmail: iyana.okonkwo@example.com\nExperience: 7 years\nDocument id: ${SENTINEL}\n`;

const root = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-attach-ws-"));
const outside = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-attach-doc-"));
const resumePath = path.join(outside, "resume.txt");
await fs.writeFile(resumePath, RESUME, "utf8");

const submissions = [];
const hits = [];
function parseMultipart(raw) {
  const text = raw.toString("latin1");
  const fields = {};
  for (const match of text.matchAll(/name="([^"]+)"\r\n\r\n([\s\S]*?)(?=\r\n--)/g)) if (!fields[match[1]]) fields[match[1]] = match[2].trim();
  const parts = text.split(/--[\w-]+\r\n/);
  const filePart = parts.find((part) => /filename="[^"]+"/.test(part));
  const fileName = filePart?.match(/filename="([^"]*)"/)?.[1] || "";
  const fileBody = filePart ? filePart.slice(filePart.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "") : "";
  return { fields, fileName, fileBody, raw: text.slice(0, 400) };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  hits.push(`${req.method} ${url.pathname}`);
  if (req.method === "POST" && url.pathname === "/submit") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { fields, fileName, fileBody, raw } = parseMultipart(Buffer.concat(chunks));
    submissions.push({ fields, fileName, fileBody, raw });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset=utf-8><title>Details received</title><body><h1 id=confirmation>Details received</h1><p id=file>Résumé on file: ${fileName || "none"}</p><p id=name>Name: ${fields.name || "none"}</p></body>`);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset=utf-8><title>Attach fixture</title>
<body style="font:16px system-ui;max-width:560px;margin:40px auto"><h1>Tell us about you</h1>
<form method=post action=/submit enctype="multipart/form-data">
<label>Full name</label><input name=name id=name>
<label>Email</label><input name=email id=email>
<label>Years</label><input name=years id=years>
<label>Your CV</label><input name=cv id=cv type=file>
<button type=submit id=submit>Send details</button></form></body>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
const mainLog = [];
{
  const proc = app.process();
  proc.stdout?.on("data", (chunk) => mainLog.push(String(chunk)));
  proc.stderr?.on("data", (chunk) => mainLog.push(String(chunk)));
}
let page;
try {
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate((dir) => {
    localStorage.setItem("calvras_projects", JSON.stringify([{ name: "Attach Proof", path: dir }]));
    localStorage.setItem("calvras_active_project", JSON.stringify({ name: "Attach Proof", path: dir }));
    localStorage.setItem("calvras_access_mode", "full");
    localStorage.removeItem("calvras_chat_messages");
  }, root);
  await page.reload();
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });

  // Answer the native confirm as the user would — Allow for the first leg, Don't allow for the
  // second. The production code path is unchanged; only the OS dialog is scripted.
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogAnswers = "allow";
    globalThis.__dialogCalls = [];
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__dialogCalls.push({ detail: options?.detail, answer: globalThis.__dialogAnswers });
      return { response: globalThis.__dialogAnswers === "allow" ? 0 : 1, checkboxChecked: false };
    };
  });

  // The dock only mounts once it has been opened, and /browser is the user-facing way to do it.
  const composer = page.getByRole("textbox", { name: "Prompt" });
  await composer.click({ force: true });
  await composer.fill("/browser");
  await page.waitForTimeout(600);
  await composer.press("Enter");
  await page.waitForSelector("webview", { timeout: 20_000 });

  const opened = await page.evaluate(async ([url]) => {
    const view = document.querySelector("webview");
    if (!view) return { ok: false, reason: "no <webview> in the document" };
    view.setAttribute("src", url);
    await new Promise((resolve) => {
      const done = () => { view.removeEventListener("did-finish-load", done); resolve(); };
      view.addEventListener("did-finish-load", done);
      setTimeout(done, 15_000);
    });
    return { ok: true, id: view.getWebContentsId(), title: await view.executeJavaScript("document.title") };
  }, [`${base}/form`]);
  check(`the app's browser panel loaded the fixture (${JSON.stringify(opened).slice(0, 120)})`, opened.ok && opened.id > 0);

  const attach = await page.evaluate(async ([id, dir, source]) => {
    try { return { ok: true, result: await window.__electron.browserSetFileInput(id, "#cv", dir, source) }; }
    catch (error) { return { ok: false, error: String(error && error.message ? error.message : error) }; }
  }, [opened.id, root, resumePath]);
  check(`browser-set-file-input accepted the out-of-project path (${attach.ok ? JSON.stringify(attach.result) : attach.error})`, attach.ok);

  const inPage = await page.evaluate(async () => {
    const view = document.querySelector("webview");
    return view.executeJavaScript(`(() => { const f = document.querySelector('#cv').files; return f.length + '|' + (f[0] ? f[0].name + '|' + f[0].size : 'none'); })()`);
  });
  check(`the page's file input really holds the CV (${inPage})`, /^1\|resume\.txt\|\d+$/.test(String(inPage)));

  // Fill from the document and press the real submit control, so the server can confirm the
  // bytes that actually arrived.
  const box = await page.evaluate(async ([name, email, years]) => {
    const view = document.querySelector("webview");
    return view.executeJavaScript(`(() => {
      document.querySelector('#name').value=${JSON.stringify(name)};
      document.querySelector('#email').value=${JSON.stringify(email)};
      document.querySelector('#years').value=${JSON.stringify(years)};
      const f = document.querySelector('form');
      try { f.requestSubmit(); return 'requestSubmit'; } catch (error) { return 'threw: ' + error.message; }
    })()`);
  }, ["Iyana Okonkwo", "iyana.okonkwo@example.com", "7"]);
  check(`the panel's form was submitted (${box})`, box === "requestSubmit");
  await page.waitForTimeout(3_000);
  const after = await page.evaluate(() => document.querySelector("webview").getURL());
  check(`pressing the panel's submit control posted the form (${after})`, /\/submit/.test(String(after)));
  const submission = submissions[submissions.length - 1];
  check(`the site received the résumé's own bytes (${submission?.fileName || "none"}, ${String(submission?.fileBody || "").length} chars, head ${JSON.stringify(String(submission?.raw || "")).slice(0, 260)})`,
    Boolean(submission) && submission.fileName === "resume.txt" && submission.fileBody.includes(SENTINEL));
  check(`the submitted answers came from the document (${JSON.stringify(submission?.fields || {}).slice(0, 120)})`,
    submission?.fields?.name === "Iyana Okonkwo" && /7/.test(String(submission?.fields?.years || "")));
  check(`the confirmed copy is staged inside the project`, (await fs.readFile(path.join(root, ".calvras", "uploads", "resume.txt"), "utf8").catch(() => "")).includes(SENTINEL));

  // The boundary: with the user answering "Don't allow", the same file must not reach the page.
  await app.evaluate(() => { globalThis.__dialogAnswers = "deny"; });
  const second = await page.evaluate(async ([id, dir, source]) => {
    try { return { ok: true, result: await window.__electron.browserSetFileInput(id, "#cv", dir, source) }; }
    catch (error) { return { ok: false, error: String(error && error.message ? error.message : error) }; }
  }, [opened.id, root, path.join(outside, "resume.txt")]);
  check(`declining the dialog blocks the read (${String(second.error || "allowed").slice(0, 90)})`,
    !second.ok && /did not allow/i.test(String(second.error)));
  const dialogs = await app.evaluate(() => globalThis.__dialogCalls || []);
  check(`the confirm dialog named the exact file both times (${dialogs.length} call(s))`,
    dialogs.length >= 2 && dialogs.every((d) => String(d.detail).includes(resumePath)));
  await page.screenshot({ path: path.join(OUT, "panel.png"), animations: "disabled" }).catch(() => {});
} catch (error) {
  check(`harness completed without throwing (${String(error && error.message ? error.message : error).split("\n")[0].slice(0, 160)})`, false);
  if (page) await page.screenshot({ path: path.join(OUT, "crash.png"), animations: "disabled" }).catch(() => {});
} finally {
  await page?.evaluate(() => {
    try { localStorage.setItem("calvras_projects", "[]"); localStorage.removeItem("calvras_active_project"); } catch { /* storage unavailable */ }
  }).catch(() => {});
  await fs.writeFile(path.join(OUT, "main.log"), mainLog.join("")).catch(() => {});
  await app.close().catch(() => {});
  server.close();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
}

const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
console.log(JSON.stringify({ ok: failed.length === 0, passed: checks.length - failed.length, failed }, null, 2));
process.exitCode = failed.length ? 1 : 0;
