// Opt-in proof that the plumbing a real-world web task needs actually works end to end:
// open a site, read a form, fill every field kind, attach a file, submit, and read the
// site's own confirmation back. Run with RUN_WEB_TASK=1 npx vitest run src/test/web-task.test.ts
// It is skipped by default because it launches a real browser.
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeBrowserSessions, executeBrowserTool } from "../lib/runtime/browser-tools";

const enabled = process.env["RUN_WEB_TASK"] === "1";
const formMarkup = [
  "<!doctype html><meta charset=utf-8><title>Acme — Backend Engineer</title>",
  "<body style='font-family:system-ui'><h1>Apply: Backend Engineer</h1>",
  "<p>We read every application. Fields marked required must be filled.</p>",
  '<form id="f"><label>Full name <input name="name" id="name" required></label>',
  '<label>Email <input name="email" type="email" id="email" required></label>',
  '<label>Notice period <select id="notice"><option>Immediately</option><option>2 weeks</option><option>1 month</option></select></label>',
  '<label>Why this role? <textarea id="why" rows="4"></textarea></label>',
  '<label>CV <input type="file" id="cv"></label>',
  '<label><input type="checkbox" id="agree"> I confirm the details are accurate</label>',
  '<button type="submit" id="submit">Submit application</button></form>',
  "<script>",
  "document.getElementById('f').addEventListener('submit', (event) => {",
  "  event.preventDefault();",
  "  const name = document.getElementById('name').value;",
  "  const email = document.getElementById('email').value;",
  "  const notice = document.getElementById('notice').value;",
  "  const file = document.getElementById('cv').files[0];",
  "  document.getElementById('f').remove();",
  "  const done = document.createElement('div');",
  "  done.id = 'confirmation';",
  "  done.textContent = 'Application received for ' + name + ' (' + email + '), start: ' + notice + ', CV: ' + (file ? file.name : 'missing') + '. Reference ACME-4471.';",
  "  document.body.appendChild(done);",
  "});",
  "</script></body>",
].join("\n");

describe("real-world web task tool chain", { timeout: 120_000 }, () => {
  let project = "";
  let url = "";
  let server: http.Server | null = null;

  beforeAll(async () => {
    if (!enabled) return;
    project = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-webtask-"));
    await fs.writeFile(path.join(project, "cv.txt"), "Shikari — backend engineer, 6 years.\n");
    await fs.writeFile(path.join(project, "apply.html"), formMarkup);
    // The browser tools accept http(s) only, so the fixture is served, not opened from disk.
    server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(formMarkup);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    url = `http://127.0.0.1:${port}/apply`;
  });

  afterAll(async () => {
    if (!enabled) return;
    await closeBrowserSessions(project).catch(() => {});
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (project) await fs.rm(project, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  const run = (type: string, args: Record<string, unknown> = {}) => executeBrowserTool(type, args, project);
  const failed = (result: any) => result?.ok === false || Boolean(result?.error);

  it.skipIf(!enabled)("opens the site and reads the form before touching it", async () => {
    expect(failed(await run("open_browser", { url }))).toBe(false);
    const page = JSON.stringify(await run("read_page"));
    expect(page).toContain("Backend Engineer");
    expect(page).toContain("Notice period");
  });

  it.skipIf(!enabled)("fills every kind of field, attaches the CV and submits", async () => {
    expect(failed(await run("fill_input", { selector: "#name", value: "Shikari Adesanya" }))).toBe(false);
    expect(failed(await run("fill_input", { selector: "#email", value: "shikari@example.com" }))).toBe(false);
    expect(failed(await run("fill_input", { selector: "#why", value: "Six years shipping distributed job queues." }))).toBe(false);

    const choice = await run("run_page_script", { code: "const select = document.getElementById('notice'); select.value = '2 weeks'; return select.value;" });
    expect(JSON.stringify(choice)).toContain("2 weeks");
    const consent = await run("run_page_script", { code: "const box = document.getElementById('agree'); box.click(); return box.checked;" });
    expect(JSON.stringify(consent)).toContain("true");

    expect(failed(await run("upload_file_to_page", { selector: "#cv", path: "cv.txt" }))).toBe(false);
    expect(failed(await run("click_element", { selector: "#submit" }))).toBe(false);
    expect(failed(await run("wait_for_element", { selector: "#confirmation", timeoutMs: 8_000 }))).toBe(false);
  });

  it.skipIf(!enabled)("reads the site's own confirmation instead of assuming success", async () => {
    const receipt = JSON.stringify(await run("read_page"));
    expect(receipt).toContain("Application received for Shikari Adesanya");
    expect(receipt).toContain("ACME-4471");
    expect(receipt).toContain("cv.txt");
    const shot = await run("take_screenshot", { fullPage: false });
    expect(typeof shot?.image).toBe("string");
    expect((shot?.image || "").length).toBeGreaterThan(1000);
  });
});
