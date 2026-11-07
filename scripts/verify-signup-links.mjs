// Proves the two things asked for on the rendered app: the sign-in screen is flat like the
// splash with no tagline and real legal links, and a link pasted into the composer shows up
// underlined with its icon instead of as plain text.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const OUT = ".agents/artifacts/signup-links";
await fs.mkdir(OUT, { recursive: true });
const checks = [];
const check = (label, ok) => { checks.push([label, Boolean(ok)]); console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); };

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let app;
let signedInAs = null;

try {
  app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  signedInAs = await page.evaluate(() => localStorage.getItem("calvras_user"));
  await page.evaluate(() => { localStorage.removeItem("calvras_user"); sessionStorage.removeItem("calvras_session_started"); });
  await page.reload();

  await page.getByRole("heading", { name: "Welcome to Calvras" }).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.join(OUT, "sign-in.png"), animations: "disabled" });

  check("the sign-in screen no longer sells itself with a tagline", !(await page.getByText(/Sign in to keep your projects/).count()));
  const emailControls = await page.getByRole("button", { name: /Continue with email/ }).count()
    + await page.getByLabel("Email", { exact: true }).count()
    + await page.getByRole("heading", { name: "Check your email" }).count();
  check(`Google is the only way in (${emailControls} email sign-up controls left)`, emailControls === 0);
  const terms = page.getByRole("link", { name: "terms" });
  const privacy = page.getByRole("link", { name: "privacy policy" });
  check(`terms links to ${await terms.getAttribute("href")}`, await terms.getAttribute("href") === "https://calvras.com/terms");
  check(`privacy links to ${await privacy.getAttribute("href")}`, await privacy.getAttribute("href") === "https://calvras.com/privacy");
  const painted = await page.evaluate(() => {
    const screen = document.querySelector("button[aria-label='Continue with Google']").closest(".fixed.inset-0");
    const probe = document.createElement("div");
    probe.style.background = "var(--background)";
    document.body.append(probe);
    const result = {
      background: getComputedStyle(screen).backgroundColor,
      splash: getComputedStyle(probe).backgroundColor,
      gradients: [...screen.querySelectorAll("*")].filter((el) => /gradient/.test(getComputedStyle(el).backgroundImage)).length,
      termsDecoration: getComputedStyle(screen.querySelector("a[href='https://calvras.com/terms']")).textDecorationLine,
    };
    probe.remove();
    return result;
  });
  check(`the page is painted one flat colour (${painted.background})`, !/gradient/.test(painted.background));
  check(`it is the splash background (${painted.splash})`, painted.background === painted.splash);
  check(`no gradient layer is drawn over it (${painted.gradients} found)`, painted.gradients === 0);
  check(`the terms link is underlined (${painted.termsDecoration})`, painted.termsDecoration.includes("underline"));

  // The app's own title bar is still in the DOM under the overlay, so name the overlay.
  const overlay = page.locator(".fixed.inset-0").filter({ has: page.locator("button[aria-label='Continue with Google']") });
  const close = overlay.getByRole("button", { name: "Close" });
  const box = await close.boundingBox();
  check("the sign-in window carries minimize, maximize and close", (await overlay.getByRole("button", { name: "Minimize" }).count()) === 1 && (await overlay.getByRole("button", { name: "Maximize" }).count()) === 1 && Boolean(box));
  const width = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().width);
  check(`they sit in the top-right corner (close at ${Math.round(box?.x ?? 0)},${Math.round(box?.y ?? 0)} of a ${width}px window)`, Boolean(box) && box.y < 30 && box.x > width - 140);
  await overlay.getByRole("button", { name: "Minimize" }).click();
  await new Promise((done) => setTimeout(done, 800));
  check("minimise really minimises", await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()) === true);
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.restore(); w.focus(); });
  await new Promise((done) => setTimeout(done, 800));
  check("and the window comes back", await app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isMinimized()));

  // Clicking the real button now would open Chrome on a client Google does not recognise, so
  // the rest of the run starts from the account record that flow writes rather than the flow.
  const photo = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#e8590c"/><circle cx="32" cy="32" r="18" fill="#fff3bf"/></svg>').toString("base64")}`;
  await page.evaluate((picture) => localStorage.setItem("calvras_user", JSON.stringify({ provider: "google", email: "hello@calvras.com", name: "Shikari", picture, joinedAt: Date.now() })), photo);
  await page.reload();
  const input = page.getByRole("textbox", { name: "Prompt" });
  await input.waitFor({ timeout: 30_000 });
  await input.click({ force: true });
  await input.fill("read https://calvras.com/terms and tell me what changed");
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "composer-link.png"), animations: "disabled" });

  const chip = page.locator("a[href='https://calvras.com/terms']").last();
  check("the composer shows the pasted address as a link", await chip.count() > 0);
  const styled = await chip.evaluate((el) => {
    const text = [...el.querySelectorAll("span")].find((s) => /calvras/.test(s.textContent));
    const svg = el.querySelector("svg");
    return {
      underline: text ? getComputedStyle(text).textDecorationLine : "none",
      icon: Boolean(svg),
      color: text ? getComputedStyle(text).color : "",
      target: el.getAttribute("target"),
    };
  });
  check(`its address is underlined (${styled.underline})`, styled.underline.includes("underline"));
  check("it carries an icon", styled.icon);
  check(`it opens in the real browser (target=${styled.target})`, styled.target === "_blank");
  check(`it is coloured as a link (${styled.color})`, styled.color !== "rgb(26, 21, 18)");

  await page.getByRole("button", { name: "Settings" }).click();
  const avatar = page.getByRole("button", { name: "Account" }).locator("img");
  await avatar.waitFor({ timeout: 15_000 });
  const shown = await avatar.evaluate((el) => ({ src: el.getAttribute("src"), loaded: el.complete && el.naturalWidth > 0, radius: getComputedStyle(el).borderRadius }));
  check(`Settings shows the account's own photo (${shown.src.slice(0, 34)}…)`, shown.src === photo);
  check(`and it actually paints (${shown.loaded}, ${shown.radius})`, shown.loaded);
  await page.screenshot({ path: path.join(OUT, "settings-avatar.png"), animations: "disabled" });
} catch (error) {
  check(`stopped at: ${String(error.message).split("\n")[0].slice(0, 180)}`, false);
} finally {
  const page = app ? await app.firstWindow().catch(() => null) : null;
  if (page) await page.evaluate((user) => { if (user) localStorage.setItem("calvras_user", user); }, signedInAs).catch(() => {});
  await app?.close();
}

const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks: checks.length, failed: failed.length }));
process.exit(failed.length ? 1 : 0);
