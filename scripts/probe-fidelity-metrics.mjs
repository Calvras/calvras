// Probe: which image metric separates "same design, different size" from "different design"?
// Prints raw per-cell arrays so thresholds can be chosen from data, not guesses.
import { chromium } from "playwright";

const row = (title, index, accent) => [
  '<div style="display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid #23232b">',
  '<span style="width:10px;height:10px;border-radius:50%;background:' + (index % 2 ? accent : "#3a3a45") + '"></span>',
  '<b style="flex:1;color:#e8e8ee">' + title + "</b>",
  '<span style="color:#8b8b98">' + (12 + index * 3) + "</span>",
  '<button style="background:' + (index % 3 ? "#22222b" : accent) + ';color:#fff;border:1px solid #34343f;padding:6px 14px;border-radius:8px">' + (index % 3 ? "Open" : "Send") + "</button>",
  "</div>",
].join("");

const ORIGINAL = ["Applications", "Bookings", "Listings", "Invoices", "Reports", "Signatures", "Queue"];
const REORDERED = ["Queue", "Invoices", "Signatures", "Bookings", "Applications", "Listings", "Reports"];
const RENAMED = ["Candidates", "Interviews", "Offers", "Placements", "Payroll", "Contracts", "Archive"];

function pageMarkup(accent, variant) {
  const titles = variant === "restructured" ? REORDERED : variant === "renamed" ? RENAMED : ORIGINAL;
  const rows = titles.map((title, index) => row(title, index, accent)).join("");
  const extra = variant === "restructured"
    ? '<div style="padding:14px 16px;background:#191920;color:#ffd166">Bulk actions <button style="margin-left:8px;background:' + accent + ';color:#0b0b0e;border:0;padding:6px 12px;border-radius:8px">Apply to all</button></div>'
    : "";
  return "<!doctype html><meta charset=utf-8>"
    + '<body style="margin:0;font-family:system-ui;background:#101014">'
    + '<h1 style="padding:20px 16px 6px;margin:0;font-size:26px;color:#f4f4f6">' + (variant === "restructured" ? "Library" : "Workspace") + "</h1>"
    + '<div style="display:flex;gap:10px;padding:6px 16px 14px">'
    + '<button style="background:' + accent + ';color:#fff;border:0;padding:8px 16px;border-radius:10px">New</button>'
    + '<button style="background:#1c1c22;color:#e8e8ee;border:1px solid #2f2f38;padding:8px 16px;border-radius:10px">Filter</button>'
    + '<button style="background:#1c1c22;color:#e8e8ee;border:1px solid #2f2f38;padding:8px 16px;border-radius:10px">Export</button>'
    + "</div>" + extra + rows
    + '<div style="padding:16px;color:#7c7c88">Synced a few seconds ago</div>'
    + "</body>";
}

const COLS = 96, ROWS = 64, FULL_W = 384, FULL_H = 256;
const metricScript = (aN, bN) => `(async () => {
  const COLS = ${COLS}, ROWS = ${ROWS}, FULL_W = ${FULL_W}, FULL_H = ${FULL_H};
  const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const [ia, ib] = await Promise.all([load(${JSON.stringify(aN)}), load(${JSON.stringify(bN)})]);
  const grid = (image) => {
    const c = document.createElement("canvas"); c.width = FULL_W; c.height = FULL_H;
    const x = c.getContext("2d"); x.drawImage(image, 0, 0, FULL_W, FULL_H);
    const d = x.getImageData(0, 0, FULL_W, FULL_H).data;
    const gray = new Float32Array(FULL_W * FULL_H);
    for (let p = 0; p < FULL_W * FULL_H; p++) gray[p] = (0.299 * d[p * 4] + 0.587 * d[p * 4 + 1] + 0.114 * d[p * 4 + 2]) / 255;
    const rgb = new Float32Array(COLS * ROWS * 3);
    const edge = new Float32Array(COLS * ROWS);
    const bw = FULL_W / COLS, bh = FULL_H / ROWS;
    for (let r = 0; r < ROWS; r++) {
      for (let cI = 0; cI < COLS; cI++) {
        let sr = 0, sg = 0, sb = 0, se = 0, n = 0;
        const y0 = Math.floor(r * bh), y1 = Math.floor((r + 1) * bh);
        const x0 = Math.floor(cI * bw), x1 = Math.floor((cI + 1) * bw);
        for (let y = Math.max(1, y0); y < Math.min(FULL_H - 1, y1); y++) {
          for (let xI = Math.max(1, x0); xI < Math.min(FULL_W - 1, x1); xI++) {
            const i1 = y * FULL_W + xI;
            sr += d[i1 * 4]; sg += d[i1 * 4 + 1]; sb += d[i1 * 4 + 2];
            const gx = gray[i1 + 1] - gray[i1 - 1], gy = gray[i1 + FULL_W] - gray[i1 - FULL_W];
            se += Math.sqrt(gx * gx + gy * gy);
            n++;
          }
        }
        const k = r * COLS + cI;
        rgb[k * 3] = sr / Math.max(1, n) / 255;
        rgb[k * 3 + 1] = sg / Math.max(1, n) / 255;
        rgb[k * 3 + 2] = sb / Math.max(1, n) / 255;
        edge[k] = se / Math.max(1, n);
      }
    }
    return { rgb, edge, data: d };
  };
  const A = grid(ia), B = grid(ib);
  const dA = A.data, dB = B.data;
  const color = new Array(COLS * ROWS), ed = new Array(COLS * ROWS);
  let strongPixels = 0, chromaPixels = 0, totalPixels = 0;
  for (let p = 0; p < FULL_W * FULL_H; p++) {
    const v = (Math.abs(dA[p * 4] - dB[p * 4]) + Math.abs(dA[p * 4 + 1] - dB[p * 4 + 1]) + Math.abs(dA[p * 4 + 2] - dB[p * 4 + 2])) / 765;
    if (v > 0.15) strongPixels++;
    const ca = Math.max(dA[p * 4], dA[p * 4 + 1], dA[p * 4 + 2]) - Math.min(dA[p * 4], dA[p * 4 + 1], dA[p * 4 + 2]);
    const cb = Math.max(dB[p * 4], dB[p * 4 + 1], dB[p * 4 + 2]) - Math.min(dB[p * 4], dB[p * 4 + 1], dB[p * 4 + 2]);
    if (v > 0.15 && Math.max(ca, cb) > 50) chromaPixels++;
    totalPixels++;
  }
  for (let k = 0; k < COLS * ROWS; k++) {
    color[k] = (Math.abs(A.rgb[k * 3] - B.rgb[k * 3]) + Math.abs(A.rgb[k * 3 + 1] - B.rgb[k * 3 + 1]) + Math.abs(A.rgb[k * 3 + 2] - B.rgb[k * 3 + 2])) / 3;
    ed[k] = Math.abs(A.edge[k] - B.edge[k]);
  }
  const histOf = (data) => {
    const bins = new Float32Array(16);
    let counted = 0;
    for (let p = 0; p < FULL_W * FULL_H; p++) {
      const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      let bin;
      if (mx - mn < 40) bin = Math.round(lum * 3) + (lum > 0.6 ? 12 : 0);
      else {
        let h = r === mx ? (g - b) / (mx - mn) : g === mx ? 2 + (b - r) / (mx - mn) : 4 + (r - g) / (mx - mn);
        h = ((h * 60) + 360) % 360;
        bin = 3 + Math.min(9, Math.floor(h / 36));
      }
      bins[Math.min(15, Math.max(0, bin))] += 1; counted++;
    }
    for (let k = 0; k < 16; k++) bins[k] /= Math.max(1, counted);
    return bins;
  };
  const hA = histOf(dA), hB = histOf(dB);
  let palette = 0;
  for (let k = 0; k < 16; k++) palette += Math.abs(hA[k] - hB[k]);
  const rawEdge = new Array(COLS * ROWS);
  for (let k = 0; k < COLS * ROWS; k++) rawEdge[k] = A.edge[k];
  return { color, edge: ed, rawEdge, strongShare: strongPixels / totalPixels, chromaShare: chromaPixels / totalPixels, palette: palette / 2, refSize: [ia.width, ia.height], curSize: [ib.width, ib.height] };
})()`;

const stats = (arr, t) => ({
  mean: Math.round(arr.reduce((s, v) => s + v, 0) / arr.length * 1000) / 10,
  share: Math.round(arr.filter((v) => v > t).length / arr.length * 1000) / 10,
});

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
const capture = async () => "data:image/png;base64," + (await page.screenshot()).toString("base64");

const shot = async (accent, variant, size, scroll) => {
  await page.setContent(pageMarkup(accent, variant));
  await page.setViewportSize(size || { width: 1000, height: 700 });
  if (scroll) await page.evaluate((offset) => window.scrollTo(0, offset), scroll);
  return capture();
};

const reference = await shot("#2f6df6", "original");

// Realistic noise floor: the SAME page rendered on a 2x display, which is what a user's
// screenshot vs the app's own capture really looks like.
const hiresContext = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });
const hiresPage = await hiresContext.newPage();
await hiresPage.setContent(pageMarkup("#2f6df6", "original"));
const samePageHires = "data:image/png;base64," + (await hiresPage.screenshot()).toString("base64");
await hiresContext.close();

// The same design in a panel of a different height: normal for a resizable preview.
const shorter = await shot("#2f6df6", "original", { width: 1000, height: 560 });
await page.setViewportSize({ width: 1000, height: 700 });

const scenarios = [
  ["identical", reference],
  ["same page DPR2", samePageHires],
  ["same page shorter", shorter],
  ["recoloured", await shot("#e63946", "original")],
  ["resized 900x640", await shot("#2f6df6", "original", { width: 900, height: 640 })],
  ["reordered rows", await shot("#2f6df6", "restructured")],
  ["renamed rows", await shot("#2f6df6", "renamed")],
  ["scroll 25px", await shot("#2f6df6", "original", null, 25)],
];

for (const [label, current] of scenarios) {
  const m = await page.evaluate(metricScript(reference, current));
  const color = stats(m.color, 0.08);
  const sumDelta = m.edge.reduce((s, v) => s + v, 0);
  const sumEnergy = m.rawEdge.reduce((s, v) => s + v, 0);
  const cellScale = sumEnergy / m.rawEdge.length;
  const adaptive = m.edge.map((v) => v / (cellScale + 1e-6));
  const ad3 = stats(adaptive, 3);
  const strong = Math.round(m.strongShare * 1000) / 10;
  const chroma = Math.round(m.chromaShare * 1000) / 10;
  const palette = Math.round(m.palette * 1000) / 10;
  console.log(
    label.padEnd(16),
    "colorMean", String(color.mean).padStart(5),
    "pixelStrong", String(strong).padStart(5),
    "chroma", String(chroma).padStart(5),
    "cellColor", String(color.share).padStart(5),
    "palette", String(palette).padStart(5),
    "structure", String(ad3.share).padStart(5),
    "| render", m.curSize.join("x"),
  );
}
await browser.close();
