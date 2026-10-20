// Proves the desktop shell renders as the reference does: a flat lighter chrome carrying the rail
// and the history strip, with the conversation inset on top of it as a darker rounded card.
// Everything is measured from real captured pixels, not from the stylesheet.
import { _electron as electron } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";

const OUT = ".agents/artifacts/shell-card";
await fs.mkdir(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 220) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 90_000 });
let page = await app.firstWindow();
await page.waitForLoadState("domcontentloaded");
await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 90_000 });

// A pixel probe that runs in the main process, where the captured bitmap lives.
const probe = (fn) => app.evaluate(({ BrowserWindow }, src) => {
  const win = BrowserWindow.getAllWindows()[0];
  return win.webContents.capturePage().then((image) => {
    const bmp = image.getBitmap();
    const size = image.getSize();
    const css = win.getContentSize();
    const scale = size.width / css[0];
    const at = (x, y) => {
      const i = ((Math.round(y * scale) * size.width) + Math.round(x * scale)) * 4;
      return [bmp[i + 2], bmp[i + 1], bmp[i]];
    };
    const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
    return new Function("at", "lum", "size", "css", "scale", src)(at, lum, size, css, scale);
  });
}, fn.toString());

const lumOf = (s) => { const [r, g, b] = s.split(",").map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
// Computed styles keep the oklch the stylesheet asked for, so tones are compared on one scale.
const toneOf = (s) => {
  const oklch = /^oklch\(([\d.]+)/.exec(s);
  if (oklch) { const y = Number(oklch[1]) ** 3; return Math.max(0, Math.min(255, (1.055 * y ** (1 / 2.4) - 0.055) * 255)); }
  return lumOf(s);
};

// ── 1. the computed shell, with the history strip open ────────────────────────────────────────
await page.getByRole("button", { name: "Chat history", exact: true }).click();
await page.getByRole("complementary", { name: "History sidebar" }).waitFor({ timeout: 15_000 });
await page.waitForTimeout(700);

const styles = await page.evaluate(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const rail = document.querySelector(".app-rail");
  const side = document.querySelector(".app-sidebar");
  const chat = document.querySelector(".chat-page");
  const rs = getComputedStyle(rail), ss = getComputedStyle(side), cs = getComputedStyle(chat);
  return {
    viewport: { w: innerWidth, h: innerHeight },
    gap: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-shell-gap")),
    body: getComputedStyle(document.body).backgroundColor,
    rail: { ...box(rail), bg: rs.backgroundColor, shadow: rs.boxShadow, radius: rs.borderRadius },
    side: { ...box(side), bg: ss.backgroundColor, shadow: ss.boxShadow, radius: ss.borderRadius },
    chat: { ...box(chat), bg: cs.backgroundColor, radius: cs.borderRadius, borderWidth: cs.borderTopWidth, borderColor: cs.borderTopColor, shadow: cs.boxShadow, clip: cs.overflow },
  };
});

check("window canvas is the lighter chrome", toneOf(styles.body) - toneOf(styles.chat.bg) > 3, `canvas ${styles.body} vs card ${styles.chat.bg}`);
check("rail is flat on the chrome", styles.rail.bg === "rgba(0, 0, 0, 0)" && styles.rail.shadow === "none", `${styles.rail.bg} / ${styles.rail.shadow}`);
check("history strip is flat on the chrome", styles.side.bg === "rgba(0, 0, 0, 0)" && styles.side.shadow === "none" && styles.side.radius === "0px", `${styles.side.bg} / ${styles.side.radius}`);
check("rail starts at the window edge", styles.rail.x === 0 && styles.rail.y <= 34, JSON.stringify(styles.rail));
check("history strip butts against the rail", styles.side.x === styles.rail.w, JSON.stringify({ side: styles.side.x, rail: styles.rail.w }));
check("conversation is an inset rounded card", styles.chat.radius === "10px" && styles.chat.clip === "hidden", JSON.stringify({ radius: styles.chat.radius, border: `${styles.chat.borderWidth} ${styles.chat.borderColor}`, shadow: styles.chat.shadow }));
check("card has a hairline edge, not a drop shadow", parseFloat(styles.chat.borderWidth) >= 0.5 && parseFloat(styles.chat.borderWidth) <= 1.5 && styles.chat.shadow === "none" && toneOf(styles.chat.borderColor) - toneOf(styles.chat.bg) > 3, `${styles.chat.borderWidth} ${styles.chat.borderColor} / ${styles.chat.shadow}`);
check("card is inset on all four sides", styles.chat.x > styles.side.x + styles.side.w && Math.abs(styles.chat.y - (styles.rail.y + styles.gap)) <= 1 && Math.abs(styles.viewport.w - (styles.chat.x + styles.chat.w) - styles.gap) <= 1 && Math.abs(styles.viewport.h - (styles.chat.y + styles.chat.h) - styles.gap) <= 1,
  JSON.stringify({ chat: styles.chat, side: styles.side, rail: styles.rail, viewport: styles.viewport, gap: styles.gap }));

// ── 2. the same claims from captured pixels ───────────────────────────────────────────────────
const px = await probe(`
  const mid = Math.round(css[1] * 0.55);
  const cardLeft = ${styles.chat.x};
  const row = [];
  for (let x = cardLeft - 14; x < cardLeft + 14; x++) row.push([x, Math.round(lum(at(x, mid))), at(x, mid).join(",")]);
  const corner = [];
  for (let y = ${styles.chat.y}; y < ${styles.chat.y} + 26; y++) {
    let edge = -1;
    for (let x = cardLeft - 6; x < cardLeft + 26; x++) { if (lum(at(x, y)) < 20) { edge = x; break; } }
    corner.push([y, edge]);
  }
  return {
    chrome: at(Math.round(css[0] * 0.18), mid).join(","),
    gutter: at(cardLeft - 5, mid).join(","),
    card: at(cardLeft + 90, mid).join(","),
    railTop: at(28, ${styles.rail.y + 60}).join(","),
    row, corner,
  };
`);
check("captured chrome is lighter than the captured card", lumOf(px.chrome) - lumOf(px.card) > 3, `chrome ${px.chrome} vs card ${px.card}`);
check("no second card hides behind the rail", lumOf(px.railTop) - lumOf(px.chrome) < 3, `rail ${px.railTop} vs chrome ${px.chrome}`);
const hairline = px.row.map(([, l]) => l);
check("a brighter hairline sits on the card edge", Math.max(...hairline) - lumOf(px.chrome) >= 3 && Math.max(...hairline) - lumOf(px.card) >= 8, px.row.map(([x, l]) => `${x}:${l}`).join(" "));
const edges = px.corner.filter(([, e]) => e > 0).map(([, e]) => e);
check("the card corner curves", edges.length > 3 && edges[0] - edges[edges.length - 1] >= 2, px.corner.map(([y, e]) => `${y}:${e}`).join(" "));

await fs.writeFile(path.join(OUT, "history.png"), await page.screenshot());
await fs.writeFile(path.join(OUT, "measures.json"), JSON.stringify({ styles, px }, null, 2));

// ── 2b. with no section open the strip is gone, so the card takes the width back ───────────────
await page.getByRole("button", { name: "Close sidebar" }).click();
await page.getByRole("complementary", { name: "History sidebar" }).waitFor({ state: "detached", timeout: 10_000 });
await page.waitForTimeout(600);
const closed = await page.evaluate(() => {
  const r = document.querySelector(".chat-page").getBoundingClientRect();
  return { x: Math.round(r.x), w: Math.round(r.width), strip: Boolean(document.querySelector(".app-sidebar")), rail: Math.round(document.querySelector(".app-rail").getBoundingClientRect().width) };
});
check("an empty strip reserves no width", !closed.strip && closed.x === closed.rail + styles.gap && closed.w > styles.chat.w, JSON.stringify({ closed, gap: styles.gap, openCard: styles.chat }));
await fs.writeFile(path.join(OUT, "closed.png"), await page.screenshot());

// ── 3. the terminal dock stays inside the card ────────────────────────────────────────────────
await page.getByRole("button", { name: "Show terminal" }).click();
await page.locator(".terminal-panel").waitFor({ timeout: 20_000 });
await page.waitForTimeout(1200);
const term = await page.evaluate(() => {
  const t = document.querySelector(".terminal-panel").getBoundingClientRect();
  const c = document.querySelector(".chat-page").getBoundingClientRect();
  return { t: { x: Math.round(t.x), y: Math.round(t.y), w: Math.round(t.width), h: Math.round(t.height) }, c: { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) } };
});
check("terminal docks to the bottom of the card", Math.abs(term.t.x - term.c.x) <= 2 && Math.abs(term.t.w - term.c.w) <= 2 && Math.abs((term.t.y + term.t.h) - (term.c.y + term.c.h)) <= 2, JSON.stringify(term));
const termPx = await probe(`
  const c = ${JSON.stringify(term.c)};
  return { inside: at(c.x + Math.round(c.w / 2), c.y + c.h - 6).join(","), below: at(c.x + Math.round(c.w / 2), c.y + c.h + 5).join(",") };
`);
check("the card clips its own bottom edge", lumOf(termPx.below) > lumOf(termPx.inside), JSON.stringify(termPx));
await fs.writeFile(path.join(OUT, "terminal.png"), await page.screenshot());
await page.getByRole("button", { name: "Close terminal" }).click();
await page.locator(".terminal-panel").waitFor({ state: "detached", timeout: 10_000 });

// ── 4. the browser dock clips to the rounded card too ──────────────────────────────────────────
await page.getByRole("button", { name: "Workspace files" }).click();
await page.locator(".browser-dock[data-open=\"true\"]").waitFor({ timeout: 15_000 });
await page.waitForTimeout(900);
const dock = await page.evaluate(() => {
  const el = document.querySelector(".browser-dock");
  if (!el) return null;
  const d = el.getBoundingClientRect(); const c = document.querySelector(".chat-page").getBoundingClientRect();
  return { d: { x: Math.round(d.x), y: Math.round(d.y), w: Math.round(d.width), h: Math.round(d.height) }, c: { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) }, open: el.dataset.open };
});
check("workspace panel exists", Boolean(dock), JSON.stringify(dock));
if (dock) {
  check("panel is flush with the card's right edge", Math.abs((dock.d.x + dock.d.w) - (dock.c.x + dock.c.w)) <= 2 && Math.abs(dock.d.y - dock.c.y) <= 2, JSON.stringify(dock));
  await fs.writeFile(path.join(OUT, "dock.png"), await page.screenshot());
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await app.close();
process.exitCode = failed.length ? 1 : 0;
