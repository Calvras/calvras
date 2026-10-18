/**
 * Evidence for "does the render match the screenshot the user sent?".
 *
 * The maths runs inside the browser page (canvas is the only image decoder already
 * there). Everything that turns raw numbers into a verdict lives here so it can be
 * tested without a browser.
 *
 * The limits come from measuring real captures (scripts/probe-fidelity-metrics.mjs):
 * the same page re-captured on a 2x display scores palette 0.1 / structure 0.3, while
 * an accent recolour scores palette 1.1 and a reordered layout scores structure 7+.
 * A panel of a different SHAPE is the confound — the same design in a shorter window
 * scores structure 10 — so the structure term only counts when both images share an
 * aspect ratio; otherwise the numbers would report every resizable panel as broken.
 */

const GRID_COLS = 96;
const GRID_ROWS = 64;
const SAMPLE_WIDTH = 384;
const SAMPLE_HEIGHT = 256;
const SUPER_COLS = 6;
const SUPER_ROWS = 4;
/** Mean channel difference (0-100) above which the render is a different picture. */
export const FIDELITY_DIFF_LIMIT = 10;
/** Palette distance (0-100) above which the colours are not the ones sent. */
export const FIDELITY_PALETTE_LIMIT = 1;
/** Share of cells whose edge energy disagrees, when both screens have the same shape. */
export const FIDELITY_STRUCTURE_LIMIT = 6;
/** Aspect ratios within this factor are treated as the same shape. */
const ASPECT_TOLERANCE = 0.05;

const REGION_NAMES = [
  "top-left", "top-centre", "top-centre-right", "top-right", "top far right", "top edge",
  "upper-left", "upper-centre", "upper-centre-right", "upper-right", "upper far right", "upper edge",
  "middle-left", "centre", "centre-right", "middle-right", "middle far right", "middle edge",
  "lower-left", "lower-centre", "lower-centre-right", "lower-right", "lower far right", "lower edge",
];

export type FidelityHotspot = { region: string; diff: number };
export type FidelitySummary = {
  /** 0-100, where 100 is identical. */
  similarity: number;
  /** 0-100 mean channel difference — the number the agent has to drive down. */
  diff: number;
  /** Percentage of sampled cells whose colour visibly moved. */
  changedPercent: number;
  /** How far the two colour palettes sit apart, regardless of where things are. */
  palettePercent: number;
  /** Percentage of cells whose structure disagrees; only trusted when the shapes match. */
  structurePercent: number;
  /** False when the render and the screenshot have different shapes, so structure is skipped. */
  shapeComparable: boolean;
  matched: boolean;
  /** Which of the three checks said no, for the note the agent reads. */
  reasons: string[];
  hotspots: FidelityHotspot[];
  referenceSize: { width: number; height: number };
  renderedSize: { width: number; height: number };
  heatmap?: string;
};

/** Runs in the page context. Both arguments are data URLs, so nothing crosses origins. */
export function pixelDiffScript(referenceDataUrl: string, currentDataUrl: string): string {
  const reference = JSON.stringify(referenceDataUrl);
  const current = JSON.stringify(currentDataUrl);
  const regions = JSON.stringify(REGION_NAMES);
  return `(async () => {
    const COLS = ${GRID_COLS}, ROWS = ${GRID_ROWS}, SUPER_COLS = ${SUPER_COLS}, SUPER_ROWS = ${SUPER_ROWS};
    const W = ${SAMPLE_WIDTH}, H = ${SAMPLE_HEIGHT};
    const load = (src) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not decode one of the images for comparison."));
      image.src = src;
    });
    const sample = (image) => {
      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, W, H);
      const data = context.getImageData(0, 0, W, H).data;
      const gray = new Float32Array(W * H);
      for (let p = 0; p < W * H; p++) gray[p] = (0.299 * data[p * 4] + 0.587 * data[p * 4 + 1] + 0.114 * data[p * 4 + 2]) / 255;
      const rgb = new Float32Array(COLS * ROWS * 3);
      const edge = new Float32Array(COLS * ROWS);
      const palette = new Float32Array(16);
      let counted = 0;
      for (let p = 0; p < W * H; p++) {
        const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        let bin;
        if (mx - mn < 40) bin = Math.min(3, Math.round(((0.299 * r + 0.587 * g + 0.114 * b) / 255) * 3));
        else {
          let hue = r === mx ? (g - b) / (mx - mn) : g === mx ? 2 + (b - r) / (mx - mn) : 4 + (r - g) / (mx - mn);
          hue = ((hue * 60) + 360) % 360;
          bin = 4 + Math.min(11, Math.floor(hue / 30));
        }
        palette[bin] += 1; counted++;
      }
      for (let k = 0; k < 16; k++) palette[k] /= Math.max(1, counted);
      const bw = W / COLS, bh = H / ROWS;
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          let sr = 0, sg = 0, sb = 0, se = 0, n = 0;
          const y0 = Math.floor(row * bh), y1 = Math.floor((row + 1) * bh);
          const x0 = Math.floor(col * bw), x1 = Math.floor((col + 1) * bw);
          for (let y = Math.max(1, y0); y < Math.min(H - 1, y1); y++) {
            for (let x = Math.max(1, x0); x < Math.min(W - 1, x1); x++) {
              const i = y * W + x;
              sr += data[i * 4]; sg += data[i * 4 + 1]; sb += data[i * 4 + 2];
              const gx = gray[i + 1] - gray[i - 1], gy = gray[i + W] - gray[i - W];
              se += Math.sqrt(gx * gx + gy * gy);
              n++;
            }
          }
          const k = row * COLS + col;
          rgb[k * 3] = sr / Math.max(1, n) / 255;
          rgb[k * 3 + 1] = sg / Math.max(1, n) / 255;
          rgb[k * 3 + 2] = sb / Math.max(1, n) / 255;
          edge[k] = se / Math.max(1, n);
        }
      }
      return { rgb, edge, palette };
    };
    const panel = (source, width, height) => {
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d");
      context.fillStyle = "#101014"; context.fillRect(0, 0, width, height);
      const scale = Math.min(width / source.width, height / source.height);
      const w = Math.max(1, Math.round(source.width * scale));
      const h = Math.max(1, Math.round(source.height * scale));
      context.drawImage(source, 0, 0, source.width, source.height, Math.round((width - w) / 2), Math.round((height - h) / 2), w, h);
      return canvas;
    };
    const [referenceImage, currentImage] = await Promise.all([load(${reference}), load(${current})]);
    const a = sample(referenceImage), b = sample(currentImage);
    const cells = [];
    const structure = [];
    let total = 0;
    let changedCells = 0;
    for (let k = 0; k < COLS * ROWS; k++) {
      const value = (Math.abs(a.rgb[k * 3] - b.rgb[k * 3]) + Math.abs(a.rgb[k * 3 + 1] - b.rgb[k * 3 + 1]) + Math.abs(a.rgb[k * 3 + 2] - b.rgb[k * 3 + 2])) / 765;
      cells.push(value);
      total += value;
      if (value > 0.08) changedCells += 1;
    }
    let edgeEnergy = 0;
    for (let k = 0; k < COLS * ROWS; k++) edgeEnergy += a.edge[k];
    const edgeScale = Math.max(1e-4, edgeEnergy / (COLS * ROWS));
    for (let k = 0; k < COLS * ROWS; k++) structure.push(Math.abs(a.edge[k] - b.edge[k]) / edgeScale);
    let palette = 0;
    for (let k = 0; k < 16; k++) palette += Math.abs(a.palette[k] - b.palette[k]);
    const meanDiff = total / cells.length;
    const changedShare = changedCells / cells.length;
    const structureShare = structure.filter((v) => v > 3).length / structure.length;
    const bandX = COLS / SUPER_COLS, bandY = ROWS / SUPER_ROWS;
    const hotspots = [];
    for (let row = 0; row < SUPER_ROWS; row++) {
      for (let col = 0; col < SUPER_COLS; col++) {
        let sum = 0, count = 0;
        for (let y = Math.floor(row * bandY); y < Math.floor((row + 1) * bandY); y++) {
          for (let x = Math.floor(col * bandX); x < Math.floor((col + 1) * bandX); x++) {
            sum += Math.max(cells[y * COLS + x], structure[y * COLS + x] / 6);
            count += 1;
          }
        }
        const value = sum / Math.max(1, count);
        if (value > 0.12) hotspots.push({ region: ${regions}[row * SUPER_COLS + col], diff: Math.round(value * 1000) / 10 });
      }
    }
    const heatmap = (() => {
      try {
        const width = 380, height = 280, gap = 8;
        const strip = document.createElement("canvas");
        strip.width = width * 3 + gap * 2; strip.height = height + 22;
        const context = strip.getContext("2d");
        context.fillStyle = "#0b0b0e"; context.fillRect(0, 0, strip.width, strip.height);
        const labels = ["user screenshot", "your render", "difference"];
        const sources = [referenceImage, currentImage, null];
        let offset = 0;
        for (let i = 0; i < 3; i++) {
          let tile = sources[i];
          if (!tile) {
            const mask = document.createElement("canvas");
            mask.width = COLS; mask.height = ROWS;
            const maskContext = mask.getContext("2d");
            const image = maskContext.createImageData(COLS, ROWS);
            for (let c = 0; c < cells.length; c++) {
              const strength = Math.min(1, Math.max(cells[c], structure[c] / 6) * 2.2);
              image.data[c * 4] = 255; image.data[c * 4 + 1] = 40; image.data[c * 4 + 2] = 60;
              image.data[c * 4 + 3] = Math.round(strength * 235);
            }
            maskContext.putImageData(image, 0, 0);
            const base = panel(currentImage, width, height);
            const combined = document.createElement("canvas");
            combined.width = width; combined.height = height;
            const combinedContext = combined.getContext("2d");
            combinedContext.drawImage(base, 0, 0);
            combinedContext.imageSmoothingEnabled = true;
            combinedContext.drawImage(mask, 0, 0, width, height);
            tile = combined;
          }
          context.drawImage(tile, offset, 22);
          context.fillStyle = "#e8e8ee"; context.font = "12px system-ui, sans-serif";
          context.fillText(labels[i], offset + 6, 15);
          offset += width + gap;
        }
        return strip.toDataURL("image/png");
      } catch { return ""; }
    })();
    return {
      similarity: 1 - meanDiff,
      changedShare,
      paletteDiff: palette / 2,
      structureShare,
      referenceWidth: referenceImage.width, referenceHeight: referenceImage.height,
      currentWidth: currentImage.width, currentHeight: currentImage.height,
      hotspots,
      heatmap,
    };
  })()`;
}

/** Two screens can only be compared cell by cell when they are the same shape. */
function shapesMatch(width: number, height: number, otherWidth: number, otherHeight: number): boolean {
  if (!(width > 0 && height > 0 && otherWidth > 0 && otherHeight > 0)) return false;
  const ratio = (width / height) / (otherWidth / otherHeight);
  return Math.abs(ratio - 1) <= ASPECT_TOLERANCE;
}

/** Turns the raw page measurement into the verdict the agent and the gate both read. */
export function summarizeFidelity(raw: unknown): FidelitySummary {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const percent = (key: string, fallback: number) => {
    const number = Number(value[key]) * 100;
    return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number * 10) / 10)) : fallback;
  };
  const similarity = percent("similarity", 0);
  const diff = Math.round((100 - similarity) * 10) / 10;
  const changedPercent = percent("changedShare", 100);
  const palettePercent = percent("paletteDiff", 100);
  const structurePercent = percent("structureShare", 100);
  const number = (key: string) => Math.max(0, Math.round(Number(value[key])) || 0);
  const referenceSize = { width: number("referenceWidth"), height: number("referenceHeight") };
  const renderedSize = { width: number("currentWidth"), height: number("currentHeight") };
  const shapeComparable = shapesMatch(referenceSize.width, referenceSize.height, renderedSize.width, renderedSize.height);
  const reasons: string[] = [];
  if (diff > FIDELITY_DIFF_LIMIT) reasons.push("the picture itself is different");
  if (palettePercent > FIDELITY_PALETTE_LIMIT) reasons.push("the colours are not the ones in the screenshot");
  if (shapeComparable && structurePercent > FIDELITY_STRUCTURE_LIMIT) reasons.push("the layout or content is arranged differently");
  if (!shapeComparable) reasons.push("the render is a different shape than the screenshot");
  const hotspots = (Array.isArray(value["hotspots"]) ? value["hotspots"] : [])
    .map((item) => {
      const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return { region: String(entry["region"] ?? "the page"), diff: Number(entry["diff"]) || 0 };
    })
    .filter((item) => Number.isFinite(item.diff) && item.diff > 0)
    .sort((left, right) => right.diff - left.diff)
    .slice(0, 6);
  return {
    similarity,
    diff,
    changedPercent,
    palettePercent,
    structurePercent,
    shapeComparable,
    matched: reasons.length === 0,
    reasons,
    hotspots,
    referenceSize,
    renderedSize,
    ...(typeof value["heatmap"] === "string" && value["heatmap"].startsWith("data:image") ? { heatmap: value["heatmap"] } : {}),
  };
}

/** The numbers, in one sentence, for gates and error messages. */
export function describeFidelity(summary: FidelitySummary | null | undefined): string {
  if (!summary) return "no measurement could be taken";
  const areas = summary.hotspots.length ? `, worst areas: ${summary.hotspots.slice(0, 3).map((item) => `${item.region} ${item.diff}%`).join(", ")}` : "";
  return `${summary.similarity}% similar, difference ${summary.diff}%, palette ${summary.palettePercent}% apart, structure ${summary.structurePercent}% apart${areas}`;
}

/** The sentence the agent sees: the number, the worst areas, and what to do next. */
export function fidelityNote(summary: FidelitySummary, source = "the screenshot the user sent"): string {
  const areas = summary.hotspots.length
    ? `Worst areas: ${summary.hotspots.map((item) => `${item.region} (${item.diff}% different)`).join(", ")}.`
    : "No region stands out — the difference is spread across the page.";
  const size = `Reference ${summary.referenceSize.width}x${summary.referenceSize.height}, render ${summary.renderedSize.width}x${summary.renderedSize.height}.`;
  const numbers = `${summary.similarity}% similar, average difference ${summary.diff}%, colours ${summary.palettePercent}% apart${summary.shapeComparable ? `, layout ${summary.structurePercent}% off` : " (layout not comparable at these shapes)"}`;
  if (summary.matched) {
    return `Pixel comparison against ${source}: ${numbers} — the colours, the layout and the picture line up with the screen the user sent. ${size} Look at the three panels in the attached image before you claim the screen is right: the numbers say the screens agree overall, so any text or detail that still reads differently in the panels is what you have to fix. ${areas}`;
  }
  return `Pixel comparison against ${source}: ${numbers}, so this is NOT the screen the user sent (${summary.reasons.join("; ")}). ${size} ${areas} Compare the attached panels: fix what reads differently in text, order, spacing and colour, make the preview the same shape as the screenshot if the shapes differ, then call compare_to_reference again. Completion stays blocked while any check fails.`;
}
