// Proves the user's ask: "I tell it where my file is, it goes to the site, clicks upload and
// chooses that file, and answers the site's questions from what the document actually says."
// The résumé lives OUTSIDE the project, so the only legitimate route is use_user_file, which
// must raise the native confirmation dialog. Proof is server-side: the fixture records the
// uploaded bytes and the fields that were submitted, and the dialog call is read back from the
// main process, so neither the copy nor the answers can be faked from the reply text.
import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const OUT = ".agents/artifacts/user-file";
const RUN_TIMEOUT = Number(process.env.RUN_TIMEOUT || 9 * 60_000);
await fs.mkdir(OUT, { recursive: true });

const checks = [];
const check = (label, ok) => { checks.push([label, Boolean(ok)]); console.log(`${ok ? "PASS" : "FAIL"} — ${label}`); };

const SENTINEL = `calvras-sentinel-${crypto.randomBytes(4).toString("hex")}`;
const RESUME = `CURRICULUM VITAE
Name: Iyana Okonkwo
Email: iyana.okonkwo@example.com
Current role: Senior Data Analyst at Meridian Health
Experience: 7 years
City: Dublin, Ireland
Document id: ${SENTINEL}
Skills: Python, DuckDB, Looker, dbt
`;

const root = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-user-file-ws-"));
const outside = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-user-file-doc-"));
const resumePath = path.join(outside, "resume.txt");
await fs.writeFile(resumePath, RESUME, "utf8");
await fs.writeFile(path.join(root, "README.md"), "# Sandbox\n", "utf8");

const submissions = [];
const formCss = "body{font:16px system-ui;max-width:600px;margin:40px auto;padding:0 16px}label{display:block;margin:14px 0 4px}input,textarea{width:100%;padding:8px;box-sizing:border-box}button{margin-top:18px;padding:10px 18px}";
const formPage = () => `<!doctype html><meta charset=utf-8><title>Northwind | Candidate details</title>
<style>${formCss}</style><h1>Tell us about you</h1><p>Northwind is collecting candidate details for one role.</p>
<form method=post action=/submit enctype="multipart/form-data">
<label>Full name</label><input name=name id=name required>
<label>Email</label><input name=email id=email type=email required>
<label>How many years of experience?</label><input name=years id=years required>
<label>Current employer</label><input name=employer id=employer>
<label>Portfolio link</label><input name=city id=city>
<label>Your CV</label><input name=cv id=cv type=file>
<button type=submit id=submit>Send details</button></form>`;

function parseMultipart(raw) {
  const text = raw.toString("latin1");
  const fields = {};
  for (const match of text.matchAll(/name="([^"]+)"\r\n\r\n([\s\S]*?)(?=\r\n--)/g)) if (!fields[match[1]]) fields[match[1]] = match[2].trim();
  const fileMatch = text.match(/name="cv"; filename="([^"]*)"\r\n\r\n([\s\S]*?)(?=\r\n--)/);
  return { fields, fileName: fileMatch?.[1] || "", fileBody: fileMatch ? fileMatch[2] : "" };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "POST" && url.pathname === "/submit") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { fields, fileName, fileBody } = parseMultipart(Buffer.concat(chunks));
    const reference = crypto.randomBytes(4).toString("hex").toUpperCase();
    submissions.push({ fields, fileName, fileBody, reference });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset=utf-8><title>Details received</title><body style="font:16px system-ui;max-width:560px;margin:40px auto"><h1 id=confirmation>Details received</h1><p id=reference>Reference ${reference}</p><p id=file>Résumé on file: ${fileName || "none"}</p><p id=years>Years recorded: ${fields.years || "none"}</p></body>`);
    return;
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/form")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(formPage());
    return;
  }
  res.writeHead(404); res.end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
// The provider error only ever reaches the chat as a generic sentence, so keep the main
// process output to read what actually happened upstream.
const mainLog = [];
{
  const proc = app.process();
  const record = (chunk) => mainLog.push(String(chunk));
  proc.stdout?.on("data", record);
  proc.stderr?.on("data", record);
}
let page;
try {
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Record — and answer — the native confirmation exactly as the user would. Production code
  // is untouched; this only replaces the dialog the OS would have shown.
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogCalls = [];
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__dialogCalls.push({ title: options?.title, message: options?.message, detail: options?.detail });
      return { response: 0, checkboxChecked: false };
    };
  });

  await page.evaluate((dir) => {
    localStorage.setItem("calvras_projects", JSON.stringify([{ name: "User File Proof", path: dir }]));
    localStorage.setItem("calvras_active_project", JSON.stringify({ name: "User File Proof", path: dir }));
    localStorage.setItem("calvras_access_mode", "full");
    localStorage.removeItem("calvras_chat_messages");
  }, root);
  await page.reload();
  const input = page.getByRole("textbox", { name: "Prompt" });
  await input.waitFor({ timeout: 30_000 });

  await input.click({ force: true });
  await input.fill(`My CV is the file at ${resumePath} — it is not in this project. Open ${base}/form in the browser panel, attach that exact CV file to the form, then fill Full name, Email, years of experience and Current employer using only what the CV itself says, and submit. Read the confirmation back to me, including the reference.`);
  await input.press("Enter");
  await page.getByRole("button", { name: "Stop task" }).waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Stop task" }).waitFor({ state: "detached", timeout: RUN_TIMEOUT });
  await page.screenshot({ path: path.join(OUT, "turn.png"), animations: "disabled" }).catch(() => {});
  await fs.writeFile(path.join(OUT, "messages.json"), await page.evaluate(() => localStorage.getItem("calvras_chat_messages") || "[]")).catch(() => {});
  const transcript = await page.getByLabel("Conversation").innerText();

  const dialogs = await app.evaluate(() => globalThis.__dialogCalls || []);
  const [submission] = submissions;

  check("the named file was read from outside the project", Boolean(submission));
  check(`the native confirm dialog was raised for that path (${dialogs.map((d) => d.title).join("|") || "none"})`,
    dialogs.some((d) => /Allow Calvras/i.test(String(d.message)) && String(d.detail).includes(resumePath)));
  check(`the CV reached the site as a real upload (filename ${submission?.fileName || "none"})`,
    /resume\.txt$/i.test(String(submission?.fileName || "")));
  check(`the uploaded bytes are the résumé's own (${String(submission?.fileBody || "").slice(0, 40)})`,
    String(submission?.fileBody || "").includes(SENTINEL) && String(submission?.fileBody || "").includes("Iyana Okonkwo"));
  check(`the form's name came from the document (${submission?.fields?.name || "none"})`, submission?.fields?.name === "Iyana Okonkwo");
  check(`the years were read from the document, not invented (${submission?.fields?.years || "none"})`, /(^|\D)7(\D|$)/.test(String(submission?.fields?.years || "")));
  check(`the employer was read from the document (${submission?.fields?.employer || "none"})`, /Meridian Health/i.test(String(submission?.fields?.employer || "")));
  check(`the confirmation was read back (${(transcript.match(/Reference [0-9A-F]{8}/) || ["none"])[0]} vs ${submission?.reference || "none"})`,
    Boolean(submission) && transcript.includes(String(submission?.reference)));

  // The file must be staged inside the project, not merely referenced in place.
  const staged = await fs.readFile(path.join(root, ".calvras", "uploads", "resume.txt"), "utf8").catch(() => "");
  check(`the confirmed copy is staged under .calvras/uploads (${staged ? "yes" : "no"})`, staged.includes(SENTINEL));
  const untouched = await fs.readFile(resumePath, "utf8").catch(() => "");
  check("the user's original file was not moved or modified", untouched === RESUME);
} catch (error) {
  check(`harness completed without throwing (${String(error.message).split("\n")[0].slice(0, 140)})`, false);
  if (page) await page.screenshot({ path: path.join(OUT, "crash.png"), animations: "disabled" }).catch(() => {});
} finally {
  // A deleted folder must not stay selected as the workspace for the next run.
  await page?.evaluate(() => {
    try {
      localStorage.setItem("calvras_projects", "[]");
      localStorage.removeItem("calvras_active_project");
      localStorage.removeItem("calvras_chat_messages");
    } catch { /* storage is unavailable if the page never settled */ }
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
