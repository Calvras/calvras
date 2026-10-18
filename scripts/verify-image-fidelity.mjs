// Verifies the desktop agent duplicates only what an attached screenshot actually shows.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OUT = ".agents/artifacts/image-fidelity";
const RUN_TIMEOUT = Number(process.env.RUN_TIMEOUT || 8 * 60_000);
const checks = [];
const check = (label, ok) => checks.push([label, Boolean(ok)]);
const shot = (name) => page.screenshot({ path: path.join(OUT, name), animations: "disabled" }).catch(() => {});

const root = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-image-"));
await fs.writeFile(path.join(root, "README.md"), "# Vault clone\n\nEmpty project. Node 24, no dependencies.\n");
const reference = path.resolve(OUT, "reference.png");

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
let page;
try {
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate((dir) => {
    localStorage.setItem("calvras_projects", JSON.stringify([{ name: "Image Proof", path: dir }]));
    localStorage.setItem("calvras_active_project", JSON.stringify({ name: "Image Proof", path: dir }));
    localStorage.setItem("calvras_access_mode", "full");
    localStorage.removeItem("calvras_chat_messages");
  }, root);
  await page.reload();
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });

  await page.locator('input[type="file"]').first().setInputFiles(reference);
  await page.waitForTimeout(1_500);
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.click({ force: true });
  await prompt.fill("Rebuild this exact screen as index.html in the project. Reproduce only what the screenshot shows, nothing extra.");
  await prompt.press("Enter");
  await page.getByRole("button", { name: "Stop task" }).waitFor({ timeout: 60_000 });
  await shot("running.png");
  await page.getByRole("button", { name: "Stop task" }).waitFor({ state: "detached", timeout: RUN_TIMEOUT });
  await shot("done.png");

  const files = (await fs.readdir(root, { recursive: true })).map(String);
  const htmlFiles = files.filter((f) => f.endsWith(".html"));
  check(`it wrote a page (${files.slice(0, 12).join(", ")})`, htmlFiles.length > 0);
  const html = (await Promise.all(htmlFiles.map((f) => fs.readFile(path.join(root, f), "utf8").catch(() => "")))).join("\n").toLowerCase();

  const invented = ["features", "pricing", "testimonial", "newsletter", "footer", "navbar", "nav ", "sign up", "get started", "learn more", "contact", "blog", "faq", "hero", "pricing", "subscribe", "about us", "cookie", "dark mode toggle", "search bar"]
    .filter((word) => html.includes(word));
  check(`it added nothing the screenshot lacks (${invented.join(", ") || "clean"})`, invented.length === 0);
  check("it reproduced what the screenshot shows", /vault/.test(html) && /paste a secret/.test(html) && /hide/.test(html));

  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean);
  check(`heading count matches the one-title screen (${headings.join(" | ")})`, headings.length <= 2);

  const reply = await page.getByLabel("Conversation").innerText();
  check(`run measured the render against the screenshot (${/Comparing the page to your screenshot/i.test(reply) ? "compared" : "no comparison node"})`,
    /Comparing the page to your screenshot/i.test(reply));
  check(`reply is specific, not a status bot (${reply.replace(/\s+/g, " ").slice(-120)})`,
    !/successfully completed|i hope this helps|great question|as an ai/i.test(reply));
} catch (error) {
  check(`stopped at: ${String(error.message).split("\n")[0].slice(0, 180)}`, false);
  if (page) await shot("failure.png");
} finally {
  await app.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
process.exit(failed.length ? 1 : 0);
