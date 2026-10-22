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

// ── 1. the shell with the drawer shut: the card owns the whole window ─────────────────────────
const readStyles = () => page.evaluate(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const drawer = document.querySelector(".app-drawer");
  const rail = document.querySelector(".app-rail");
  const side = document.querySelector(".app-sidebar");
  const chat = document.querySelector(".chat-page");
  const ds = getComputedStyle(drawer), rs = getComputedStyle(rail), cs = getComputedStyle(chat);
  return {
    viewport: { w: innerWidth, h: innerHeight },
    gap: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-shell-gap")),
    title: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-title-height")),
    body: getComputedStyle(document.body).backgroundColor,
    open: drawer.classList.contains("is-open"),
    drawer: { ...box(drawer), bg: ds.backgroundColor, visibility: ds.visibility, borderRight: ds.borderRightWidth },
    rail: { ...box(rail), bg: rs.backgroundColor },
    side: side ? { ...box(side) } : null,
    chat: { ...box(chat), bg: cs.backgroundColor, radius: cs.borderRadius, top: cs.borderTopWidth, left: cs.borderLeftWidth, right: cs.borderRightWidth, bottom: cs.borderBottomWidth, borderColor: cs.borderTopColor, shadow: cs.boxShadow, clip: cs.overflow },
  };
});

const shut = await readStyles();
check("window canvas is the lighter chrome", toneOf(shut.body) - toneOf(shut.chat.bg) > 3, `canvas ${shut.body} vs card ${shut.chat.bg}`);
check("the drawer is shut and holds nothing on screen", !shut.open && shut.drawer.visibility === "hidden", JSON.stringify(shut.drawer));
check("rail lives inside the drawer, not on the window edge", shut.rail.bg === "rgba(0, 0, 0, 0)" && shut.drawer.x === 0 && shut.rail.x === 0, JSON.stringify({ rail: shut.rail, drawer: shut.drawer.x }));
check("conversation is an inset rounded card", shut.chat.radius === "10px" && shut.chat.clip === "hidden", JSON.stringify({ radius: shut.chat.radius }));
check("card keeps a hairline on its top and left only", parseFloat(shut.chat.top) >= 0.5 && parseFloat(shut.chat.left) >= 0.5 && parseFloat(shut.chat.right) === 0 && parseFloat(shut.chat.bottom) === 0 && shut.chat.shadow === "none" && toneOf(shut.chat.borderColor) - toneOf(shut.chat.bg) > 3, JSON.stringify({ top: shut.chat.top, left: shut.chat.left, right: shut.chat.right, bottom: shut.chat.bottom, color: shut.chat.borderColor }));
check("a shut drawer gives the card the whole width", shut.chat.x === shut.gap && Math.abs(shut.viewport.w - (shut.chat.x + shut.chat.w) - shut.gap) <= 1 && Math.abs(shut.chat.y - (shut.title + shut.gap)) <= 1 && Math.abs(shut.viewport.h - (shut.chat.y + shut.chat.h) - shut.gap) <= 1,
  JSON.stringify({ chat: shut.chat, title: shut.title, gap: shut.gap, viewport: shut.viewport }));
check("the top bar is a slim strip", shut.title <= 22 && shut.chat.y === shut.title + shut.gap, `--app-title-height ${shut.title}px`);

// ── 2. the same claims from captured pixels ───────────────────────────────────────────────────
const px = await probe(`
  const mid = Math.round(css[1] * 0.55);
  const cardLeft = ${shut.chat.x};
  const row = [];
  for (let x = cardLeft - 6; x < cardLeft + 14; x++) row.push([x, Math.round(lum(at(x, mid))), at(x, mid).join(",")]);
  const corner = [];
  for (let y = ${shut.chat.y}; y < ${shut.chat.y} + 26; y++) {
    let edge = -1;
    for (let x = cardLeft - 6; x < cardLeft + 26; x++) { if (lum(at(x, y)) < 20) { edge = x; break; } }
    corner.push([y, edge]);
  }
  const rightEdge = [];
  for (let y = ${shut.chat.y} + 40; y < ${shut.chat.y} + ${shut.chat.h} - 40; y += 90) rightEdge.push(at(${shut.chat.x + shut.chat.w} - 1, y).join(","));
  return {
    chrome: at(Math.round(css[0] * 0.18), mid).join(","),
    gutter: at(cardLeft - 3, mid).join(","),
    card: at(cardLeft + 90, mid).join(","),
    leftOfCard: at(cardLeft - 20, mid).join(","),
    row, corner, rightEdge,
  };
`);
check("captured chrome is lighter than the captured card", lumOf(px.chrome) - lumOf(px.card) > 3, `chrome ${px.chrome} vs card ${px.card}`);
const hairline = px.row.map(([, l]) => l);
check("a brighter hairline sits on the card's left edge", Math.max(...hairline) - lumOf(px.chrome) >= 3 && Math.max(...hairline) - lumOf(px.card) >= 8, px.row.map(([x, l]) => `${x}:${l}`).join(" "));
const edges = px.corner.filter(([, e]) => e > 0).map(([, e]) => e);
check("the card corner curves", edges.length > 3 && edges[0] - edges[edges.length - 1] >= 2, px.corner.map(([y, e]) => `${y}:${e}`).join(" "));
check("no hairline is painted on the card's right edge", px.rightEdge.every((p) => lumOf(p) < 22), px.rightEdge.join(" "));
await fs.writeFile(path.join(OUT, "closed.png"), await page.screenshot());

// ── 2b. opening the drawer slides it over the card, which keeps its width ─────────────────────
await page.getByRole("button", { name: "Toggle sidebar" }).click();
await page.waitForSelector(".app-drawer.is-open", { timeout: 15_000 });
await page.getByRole("complementary", { name: /sidebar/ }).waitFor({ timeout: 15_000 });
await page.waitForTimeout(700);
const open = await readStyles();
check("the drawer slides in over the card", open.open && open.drawer.visibility === "visible" && open.drawer.x === 0 && open.drawer.w === open.rail.w + (open.side?.w ?? 0), JSON.stringify({ drawer: open.drawer, rail: open.rail.w, side: open.side?.w }));
check("the card gives up no width to the drawer", open.chat.x === shut.chat.x && open.chat.w === shut.chat.w, JSON.stringify({ open: open.chat, shut: shut.chat }));
check("the drawer is a flat panel with one edge rule", toneOf(open.drawer.bg) - toneOf(open.chat.bg) > 3 && parseFloat(open.drawer.borderRight) === 1, JSON.stringify({ bg: open.drawer.bg, border: open.drawer.borderRight }));
await fs.writeFile(path.join(OUT, "history.png"), await page.screenshot());
await fs.writeFile(path.join(OUT, "measures.json"), JSON.stringify({ shut, open, px }, null, 2));
await page.getByRole("button", { name: "Toggle sidebar" }).click();
await page.waitForTimeout(600);
const reclosed = await readStyles();
check("the same control shuts it again", !reclosed.open && reclosed.chat.x === shut.chat.x, JSON.stringify({ open: reclosed.open, x: reclosed.chat.x }));

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
