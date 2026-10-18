import { _electron as electron } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import assert from "node:assert/strict";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-nofolder-"));
const profile = path.join(tmp, "profile");
const vault = path.join(tmp, "vault");
await fs.mkdir(profile, { recursive: true });
env.CALVRAS_ATTACHMENTS_DIR = vault;

function makePdf(lines) {
  const esc = (value) => value.replace(/([\\()])/g, "\\$1");
  const content = ["BT", "/F1 12 Tf", "72 732 Td", ...lines.map((line, index) => (index === 0 ? `(${esc(line)}) Tj` : `0 -18 Td (${esc(line)}) Tj`)), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index++) pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const cvPath = path.join(tmp, "Emmanuel_Daniel_CV.pdf");
await fs.writeFile(cvPath, makePdf([
  "Emmanuel Daniel",
  "Product Engineer - React, TypeScript, Node.js",
  "emmanuel.daniel@example.com | Berlin, Germany",
  "",
  "SUMMARY",
  "Product engineer with 6 years of experience shipping web applications end to end,",
  "from design systems and typed APIs to production deployment and observability.",
  "",
  "EXPERIENCE",
  "Senior Frontend Engineer, Northwind (2023 - present)",
  "Led a design-system migration across 14 product teams and cut page load time by 38%.",
  "Built a streaming AI assistant with tool calling, persistence, and offline recovery.",
  "Software Engineer, Blue Harbor (2020 - 2023)",
  "Delivered billing, onboarding, and analytics features with React and Node services.",
  "",
  "SKILLS",
  "TypeScript, React, Node.js, PostgreSQL, Playwright, accessibility, CI/CD",
  "",
  "EDUCATION",
  "BSc Computer Science, University of Ghana, 2019",
]));

const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: [".", `--user-data-dir=${profile}`],
  env,
  timeout: 60000,
});
const results = {};
const logs = [];
const artifactDir = ".agents/artifacts/runtime";
await fs.mkdir(artifactDir, { recursive: true });

try {
  const page = await app.firstWindow();
  page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => logs.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ""}`));
  page.on("response", (response) => { if (response.status() >= 400) logs.push(`http ${response.status()}: ${response.url()}`); });
  results.logs = logs;
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => {
    localStorage.setItem("calvras_access_mode", "full");
    localStorage.removeItem("calvras_chat_messages");
    localStorage.removeItem("calvras_session_memory");
  });
  await page.reload();
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.waitFor({ timeout: 45000 });
  const conversation = page.getByLabel("Conversation", { exact: true });

  const send = async (text) => {
    const before = await conversation.innerText();
    await prompt.fill(text);
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    const stop = page.getByRole("button", { name: "Stop task", exact: true });
    try {
      await stop.waitFor({ timeout: 6000 });
      await stop.waitFor({ state: "detached", timeout: 180000 });
    } catch {
      await page.waitForFunction((previous) => {
        const node = document.querySelector('[aria-label="Conversation"]');
        return node && node.innerText.length > previous.length + 40 && !document.querySelector('[aria-label="Conversation"]')?.innerText.includes("Working…");
      }, before, { timeout: 180000 });
    }
    await page.waitForTimeout(1200);
    const after = await conversation.innerText();
    return after.slice(before.length);
  };

  const HEADER = /(?:Worked for\s+\d+\s*seconds?|Thought for\s+\d+s)/gi;
  const headerCount = (text) => (text.match(HEADER) || []).length;
  const answer = (turn) => {
    const matches = [...turn.matchAll(HEADER)];
    const last = matches[matches.length - 1];
    return last ? turn.slice(last.index + last[0].length).trim() : turn.trim();
  };

  // 1. Conversational turn: one Thinking header, no project pivot.
  const greeting = await send("hey");
  results.greeting = greeting;
  const greetingAnswer = answer(greeting);
  assert.equal(headerCount(greeting), 1, "A chat turn must show exactly one merged trace header");
  assert.match(greeting, /Thought for\s+\d+s/i, "Chat without tools must finish as Thought for");
  assert.doesNotMatch(greeting, /Working…|Thinking…/, "No live label may remain after completion");
  assert.doesNotMatch(greetingAnswer, /project|folder|workspace|file access|select a folder/i, "Casual chat must not pivot to project mode");
  assert.doesNotMatch(greetingAnswer, /what (?:would you like to )?work|what work|tasks?|anything you(?:'d| would) like/i, "A greeting must not solicit a task");
  assert.ok(greetingAnswer.length > 20, "Greeting must get a real answer");
  await page.screenshot({ path: path.join(artifactDir, "nofolder-greeting.png"), animations: "disabled" });

  // 2. Fresh chat, attach a PDF CV with no folder, ask for a review.
  await page.evaluate(() => { localStorage.removeItem("calvras_chat_messages"); localStorage.removeItem("calvras_session_memory"); });
  await page.reload();
  await prompt.waitFor({ timeout: 30000 });
  await page.locator('input[type="file"]').first().setInputFiles(cvPath);
  await page.waitForTimeout(1500);
  results.attachmentPreview = await page.locator('[aria-label*="Emmanuel_Daniel_CV.pdf"]').count();
  assert.ok(results.attachmentPreview > 0, "The PDF must appear as an attachment in the composer");

  const review = await send("is this good enough to get me job?");
  results.review = review;
  const reviewAnswer = answer(review);
  await page.screenshot({ path: path.join(artifactDir, "nofolder-cv-review.png"), animations: "disabled", fullPage: true });
  assert.equal(headerCount(review), 1, "The CV turn must show exactly one merged trace header");
  assert.match(review, /Thought for|Worked for/i, "The completed turn must carry a measured header");
  assert.doesNotMatch(reviewAnswer, /Select a project folder|project folder first|Upload a folder to|requires? a (?:project )?(?:folder|workspace)|no project folder is selected/i, "Attachments must never demand a project folder");
  assert.doesNotMatch(reviewAnswer, /cannot (?:see|read)|could not be read|paste the text|formatted correctly/i, "The PDF must actually be readable in the app");
  assert.ok(reviewAnswer.length > 250, "The CV must get a substantive review");
  assert.match(reviewAnswer, /experience|skills?|qualif|r[eé]sum[eé]|CV|role|job/i, "The review must reference the attached CV content");
  assert.match(reviewAnswer, /Emmanuel|6 years|React|TypeScript|Northwind|Ghana/i, "The review must use real details from the PDF");

  const vaultFiles = await fs.readdir(vault).catch(() => []);
  results.vaultFiles = vaultFiles;
  console.error("VAULT", JSON.stringify(vaultFiles));
  assert.ok(vaultFiles.some((name) => /Emmanuel_Daniel_CV\.pdf$/.test(name)), "The PDF must be stored in the global vault with no folder");
  const sidecar = vaultFiles.find((name) => /Emmanuel_Daniel_CV\.pdf\.txt$/.test(name));
  assert.ok(sidecar, `The extracted CV text must be stored beside the PDF (vault: ${vaultFiles.join(", ")})`);
  const extracted = await fs.readFile(path.join(vault, sidecar), "utf8");
  assert.match(extracted, /Emmanuel Daniel/, "The vault sidecar must contain the real PDF text");

  // 3. Seed an older session so compression runs on the next turn.
  await page.evaluate(() => {
    const now = Date.now();
    const seeded = [];
    for (let index = 0; index < 6; index++) {
      seeded.push({ id: index * 2 + 1, role: "user", text: `Turn ${index + 1}: please remember requirement number ${index + 1} for the onboarding redesign.`, phases: [], done: true, startedAt: now - (60 - index) * 1000, endedAt: now - (59 - index) * 1000 });
      seeded.push({ id: index * 2 + 2, role: "assistant", text: `Requirement ${index + 1} noted: keep the onboarding flow calm and minimal.`, phases: [{ trace: [], message: `Requirement ${index + 1} noted: keep the onboarding flow calm and minimal.`, startedAt: now - (59 - index) * 1000, endedAt: now - (58 - index) * 1000 }], done: true, status: "finished", startedAt: now - (59 - index) * 1000, endedAt: now - (58 - index) * 1000 });
    }
    localStorage.setItem("calvras_chat_messages", JSON.stringify(seeded));
    localStorage.removeItem("calvras_session_memory");
  });
  await page.reload();
  await prompt.waitFor({ timeout: 30000 });
  await page.waitForTimeout(1200);
  const compressor = await send("Before we continue, what were the requirements we agreed on?");
  results.compressionTurn = compressor;
  await page.screenshot({ path: path.join(artifactDir, "nofolder-compressed.png"), animations: "disabled", fullPage: true });
  const memory = await page.evaluate(() => JSON.parse(localStorage.getItem("calvras_session_memory") || "null"));
  results.sessionMemory = memory ? { covered: memory.covered, summaryLength: memory.summary?.length || 0, summary: memory.summary?.slice(0, 400) } : null;
  assert.equal(await page.getByRole("separator", { name: "Context compressed" }).count(), 1, "The compressed divider must remain visible in the turn");
  assert.ok(memory && memory.covered === 6, "Compression must cover exactly the six older turns");
  assert.ok((memory.summary?.length || 0) > 40, "The compressed session memory must contain a real summary");
  assert.match(memory.summary, /requirement|onboarding/i, "The summary must preserve the earlier task");
  assert.doesNotMatch(compressor, /Compressing…/, "The divider must settle on Context compressed after the turn");
  assert.equal(headerCount(compressor), 1, "Compression and the resumed reply must share one measured header");

  console.log(JSON.stringify({ ok: true, results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, results }, null, 2));
  throw error;
} finally {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
