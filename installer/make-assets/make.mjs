// Regenerates every wizard asset Calvras Setup ships with, from the app logo and nothing else:
// the dark sidebar image, the small page image, both 2x high-DPI variants, and the multi-size
// application icon. Run with `node installer/make-assets/make.mjs` (or `npm run installer:assets`).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const outDir = path.resolve(repo, "installer");
const logo = PNG.sync.read(fs.readFileSync(path.resolve(repo, "public/calvras-logo.png")));

const BACKGROUND = { r: 0x11, g: 0x11, b: 0x11 };
const GLOW = { r: 0xf5, g: 0xf0, b: 0xe8 };

/** Area-average resize: the logo is always shrunk here, and a box filter over the exact source
 * footprint is what keeps the small sizes from aliasing or losing weight. */
function resize(src, sw, sh, tw, th) {
  const out = Buffer.alloc(tw * th * 4);
  const xRatio = sw / tw;
  const yRatio = sh / th;
  for (let y = 0; y < th; y++) {
    const y0 = y * yRatio;
    const y1 = Math.min(sh, y0 + yRatio);
    for (let x = 0; x < tw; x++) {
      const x0 = x * xRatio;
      const x1 = Math.min(sw, x0 + xRatio);
      let r = 0, g = 0, b = 0, a = 0, weight = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const cy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (cy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const cx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          const coverage = cx * cy;
          if (coverage <= 0) continue;
          const i = (sy * sw + sx) * 4;
          const alpha = src[i + 3];
          // Premultiply so fully transparent pixels never darken the colour of their neighbours.
          r += (src[i] / 255) * alpha * coverage;
          g += (src[i + 1] / 255) * alpha * coverage;
          b += (src[i + 2] / 255) * alpha * coverage;
          a += alpha * coverage;
          weight += coverage;
        }
      }
      const o = (y * tw + x) * 4;
      if (a === 0 || weight === 0) continue;
      out[o] = Math.round((r / a) * 255);
      out[o + 1] = Math.round((g / a) * 255);
      out[o + 2] = Math.round((b / a) * 255);
      out[o + 3] = Math.round(a / weight);
    }
  }
  return out;
}

/** Box blur on the alpha plane only, since the glow needs the logo's silhouette and nothing else.
 * Three rounds of horizontal-then-vertical keeps the halo round instead of smeared sideways. */
function blurAlpha(plane, width, height, radius) {
  const scratch = new Float32Array(plane.length);
  const sweep = (from, to, vertical) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0, count = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = vertical ? x : x + k;
          const sy = vertical ? y + k : y;
          if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
          sum += from[sy * width + sx];
          count++;
        }
        to[y * width + x] = sum / count;
      }
    }
  };
  for (let pass = 0; pass < 3; pass++) {
    sweep(plane, scratch, false);
    sweep(scratch, plane, true);
  }
  return plane;
}

function newCanvas(width, height, color) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = color.r;
    data[i * 4 + 1] = color.g;
    data[i * 4 + 2] = color.b;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** `screen` keeps the glow a light haze over the near-black sidebar instead of a grey smudge.
 * The silhouette is blurred on a padded plane: blurring in place would normalise away the missing
 * neighbours at the sprite border and print a hard square around the mark. */
function glowOnto(canvas, canvasWidth, canvasHeight, sprite, spriteWidth, spriteHeight, centerX, centerY, color, strength) {
  const radius = Math.max(2, Math.round(spriteWidth * 0.18));
  const pad = radius * 3;
  const wide = spriteWidth + pad * 2;
  const tall = spriteHeight + pad * 2;
  const halo = new Float32Array(wide * tall);
  for (let y = 0; y < spriteHeight; y++) {
    for (let x = 0; x < spriteWidth; x++) {
      halo[(y + pad) * wide + (x + pad)] = sprite[(y * spriteWidth + x) * 4 + 3];
    }
  }
  blurAlpha(halo, wide, tall, radius);
  const left = Math.round(centerX - wide / 2);
  const top = Math.round(centerY - tall / 2);
  for (let y = 0; y < tall; y++) {
    const cy = y + top;
    if (cy < 0 || cy >= canvasHeight) continue;
    for (let x = 0; x < wide; x++) {
      const cx = x + left;
      if (cx < 0 || cx >= canvasWidth) continue;
      const amount = (halo[y * wide + x] / 255) * strength;
      if (amount <= 0) continue;
      const o = (cy * canvasWidth + cx) * 4;
      canvas[o] = Math.min(255, Math.round(canvas[o] + (color.r - (canvas[o] * color.r) / 255) * amount));
      canvas[o + 1] = Math.min(255, Math.round(canvas[o + 1] + (color.g - (canvas[o + 1] * color.g) / 255) * amount));
      canvas[o + 2] = Math.min(255, Math.round(canvas[o + 2] + (color.b - (canvas[o + 2] * color.b) / 255) * amount));
    }
  }
}

function spriteOnto(canvas, canvasWidth, canvasHeight, sprite, spriteWidth, spriteHeight, centerX, centerY) {
  const left = Math.round(centerX - spriteWidth / 2);
  const top = Math.round(centerY - spriteHeight / 2);
  for (let y = 0; y < spriteHeight; y++) {
    const cy = y + top;
    if (cy < 0 || cy >= canvasHeight) continue;
    for (let x = 0; x < spriteWidth; x++) {
      const cx = x + left;
      if (cx < 0 || cx >= canvasWidth) continue;
      const s = (y * spriteWidth + x) * 4;
      const alpha = sprite[s + 3] / 255;
      if (alpha === 0) continue;
      const o = (cy * canvasWidth + cx) * 4;
      for (let channel = 0; channel < 3; channel++) {
        canvas[o + channel] = Math.round(sprite[s + channel] * alpha + canvas[o + channel] * (1 - alpha));
      }
    }
  }
}

/** The mark is graphite-to-silver, so its shadows disappear on a near-black sidebar: lift the whole
 * ramp into a brighter chrome range and keep the gradient that gives it the 3D read. The source
 * also carries a faint full-canvas haze at alpha 1-31, which would print as a visible square once
 * brightened, so anything below the real edge is knocked out first. */
function prepForDark(data) {
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 32) {
      data[i + 3] = 0;
      continue;
    }
    data[i + 3] = Math.min(255, Math.round(((alpha - 32) * 255) / 223) + 32);
    for (let channel = 0; channel < 3; channel++) {
      data[i + channel] = Math.min(255, Math.round(data[i + channel] * 1.15 + 60));
    }
  }
  return data;
}

/** 24-bit, bottom-up, row-padded BMP: what Inno's wizard images must be. */
function writeBmp(file, data, width, height) {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + stride * height;
  const header = Buffer.alloc(54);
  header.write("BM", 0, "latin1");
  header.writeUInt32LE(size, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(0, 30);
  header.writeUInt32LE(stride * height, 34);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = ((height - 1 - y) * width + x) * 4;
      const o = y * stride + x * 3;
      pixels[o] = data[s + 2];
      pixels[o + 1] = data[s + 1];
      pixels[o + 2] = data[s];
    }
  }
  fs.writeFileSync(file, Buffer.concat([header, pixels]));
}

/** PNG payloads inside the ICO container: supported since Vista and keeps 256px crisp. */
function writeIco(file, frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = 6 + frames.length * 16;
  const entries = [];
  const bodies = [];
  for (const frame of frames) {
    const png = PNG.sync.write(frame.png);
    const entry = Buffer.alloc(16);
    // A zero byte means 256, and the bitmap is drawn at its true edge no matter how tall it is.
    entry[0] = frame.size >= 256 ? 0 : frame.size;
    entry[1] = frame.size >= 256 ? 0 : frame.size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    bodies.push(png);
    offset += png.length;
  }
  fs.writeFileSync(file, Buffer.concat([header, ...entries, ...bodies]));
}

function pngFrame(data, width, height) {
  const png = new PNG({ width, height });
  data.copy(png.data);
  return png;
}

function build() {
  const logoAspect = logo.height / logo.width;
  for (const scale of [1, 2]) {
    const width = 164 * scale;
    const height = 314 * scale;
    const markWidth = Math.round(90 * scale);
    const markHeight = Math.round(markWidth * logoAspect);
    const sprite = prepForDark(resize(logo.data, logo.width, logo.height, markWidth, markHeight));
    const canvas = newCanvas(width, height, BACKGROUND);
    const centerX = width / 2;
    const centerY = height * 0.4;
    glowOnto(canvas, width, height, sprite, markWidth, markHeight, centerX, centerY, GLOW, 0.34);
    spriteOnto(canvas, width, height, sprite, markWidth, markHeight, centerX, centerY);
    writeBmp(path.join(outDir, scale === 1 ? "wizard_sidebar.bmp" : "wizard_sidebar_2x.bmp"), canvas, width, height);

    const smallEdge = 55 * scale;
    const smallMark = Math.round(smallEdge * 0.74);
    const smallSprite = prepForDark(resize(logo.data, logo.width, logo.height, smallMark, Math.round(smallMark * logoAspect)));
    const small = newCanvas(smallEdge, smallEdge, { r: 0, g: 0, b: 0 });
    spriteOnto(small, smallEdge, smallEdge, smallSprite, smallMark, Math.round(smallMark * logoAspect), smallEdge / 2, smallEdge / 2);
    writeBmp(path.join(outDir, scale === 1 ? "wizard_small.bmp" : "wizard_small_2x.bmp"), small, smallEdge, smallEdge);
  }

  const iconSizes = [16, 24, 32, 48, 64, 128, 256];
  const iconMarks = iconSizes.map((size) => {
    const height = Math.round(size * logoAspect);
    return { size, height, data: resize(logo.data, logo.width, logo.height, size, height) };
  });
  writeIco(
    path.join(outDir, "app.ico"),
    iconMarks.map((mark) => ({ size: mark.size, png: pngFrame(mark.data, mark.size, mark.height) })),
  );

  const names = ["wizard_sidebar.bmp", "wizard_sidebar_2x.bmp", "wizard_small.bmp", "wizard_small_2x.bmp", "app.ico"];
  for (const name of names) {
    const stat = fs.statSync(path.join(outDir, name));
    console.log(`${name.padEnd(22)} ${stat.size} bytes`);
  }
  for (const mark of iconMarks) console.log(`app.ico frame ${mark.size}x${mark.height} png ${mark.data.length} raw bytes`);
}

build();
