// Samples exact pixel colors from the Codex reference screenshots so the
// rebuild matches tones instead of eyeballing them.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const DIR = "C:/Users/darka/.qoder/tmp/C--Users-darka-Desktop-New-Coding/images/402783b1-2c85-464b-8ae2-4f2707345cd6";
const SAMPLES = {
  "efc88311-804d-4323-80e0-b70ebc0763dc.png": {
    sidebarBg: [0.08, 0.60], sidebarSelected: [0.08, 0.35], mainBg: [0.45, 0.80],
    topbarBg: [0.5, 0.02], envCardBg: [0.90, 0.38], composerBg: [0.47, 0.895],
    codeChipBg: [0.27, 0.147], sendCircle: [0.712, 0.955], handlePill: [0.5, 0.983],
    navIcon: [0.012, 0.068],
  },
  "dcb88a41-8421-4627-b0a4-0ff414c2000d.png": {
    railBg: [0.06, 0.5], sidebarBg: [0.18, 0.6], sidebarSelected: [0.18, 0.337],
    mainBg: [0.6, 0.6], topbarBg: [0.5, 0.11], menubarBg: [0.5, 0.055],
    userBubbleBg: [0.68, 0.277], composerBg: [0.6, 0.85], workedRule: [0.6, 0.378],
    codeChip: [0.63, 0.415], sendWhite: [0.848, 0.895], dashedRail: [0.317, 0.5],
  },
};

const REGIONS = {
  "efc88311-804d-4323-80e0-b70ebc0763dc.png": {
    sidebar: [0.02, 0.55, 0.14, 0.75], sidebarSelected: [0.02, 0.335, 0.17, 0.365],
    main: [0.40, 0.78, 0.60, 0.83], envCard: [0.80, 0.30, 0.97, 0.40],
    composer: [0.30, 0.885, 0.65, 0.905], codeChip: [0.245, 0.140, 0.33, 0.155],
    topbar: [0.40, 0.01, 0.60, 0.035],
  },
  "dcb88a41-8421-4627-b0a4-0ff414c2000d.png": {
    rail: [0.045, 0.40, 0.075, 0.60], sidebar: [0.10, 0.50, 0.26, 0.70],
    sidebarSelected: [0.09, 0.325, 0.28, 0.350], main: [0.50, 0.55, 0.75, 0.70],
    userBubble: [0.56, 0.258, 0.86, 0.298], composer: [0.40, 0.83, 0.70, 0.86],
    sendCircle: [0.833, 0.878, 0.862, 0.912], topbar: [0.40, 0.10, 0.60, 0.125],
  },
};

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: ["main.cjs"], env, timeout: 60_000,
});
try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  for (const [file, points] of Object.entries(SAMPLES)) {
    const b64 = (await fs.readFile(path.join(DIR, file))).toString("base64");
    const out = await page.evaluate(async ({ b64, points, regions }) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const res = { size: [img.naturalWidth, img.naturalHeight] };
      for (const [name, [fx, fy]] of Object.entries(points)) {
        const x = Math.round(fx * img.naturalWidth), y = Math.round(fy * img.naturalHeight);
        const d = ctx.getImageData(x, y, 1, 1).data;
        res[name] = "#" + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, "0")).join("");
      }
      const mode = (x0, y0, x1, y1) => {
        const counts = new Map();
        for (let y = Math.round(y0 * img.naturalHeight); y < y1 * img.naturalHeight; y += 2) {
          for (let x = Math.round(x0 * img.naturalWidth); x < x1 * img.naturalWidth; x += 2) {
            const d = ctx.getImageData(x, y, 1, 1).data;
            const k = "#" + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, "0")).join("");
            counts.set(k, (counts.get(k) || 0) + 1);
          }
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
      };
      res.regions = {};
      for (const [name, rect] of Object.entries(regions)) {
        res.regions[name] = mode(...rect);
      }
      return res;
    }, { b64, points, regions: REGIONS[file] || {} });
    console.log(file, JSON.stringify({ size: out.size, regions: out.regions }));
  }
} finally {
  await app.close().catch(() => {});
}