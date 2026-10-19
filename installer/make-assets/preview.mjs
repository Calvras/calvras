import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const dir = path.resolve(import.meta.dirname, "..");
const out = path.join(process.env.TEMP ?? process.env.TMP ?? dir, "calvras-installer-preview");
fs.mkdirSync(out, { recursive: true });
for (const name of ["wizard_sidebar.bmp", "wizard_sidebar_2x.bmp", "wizard_small.bmp", "wizard_small_2x.bmp"]) {
  const buf = fs.readFileSync(path.join(dir, name));
  const offset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const height = buf.readInt32LE(22);
  const stride = Math.ceil((width * 3) / 4) * 4;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = offset + (height - 1 - y) * stride + x * 3;
      const d = (y * width + x) * 4;
      png.data[d] = buf[s + 2];
      png.data[d + 1] = buf[s + 1];
      png.data[d + 2] = buf[s];
      png.data[d + 3] = 255;
    }
  }
  // Enlarge the 1x art so it is legible when the preview is shown in a chat.
  const scale = Math.max(1, Math.round(360 / width));
  const big = new PNG({ width: width * scale, height: height * scale });
  for (let y = 0; y < height * scale; y++) {
    for (let x = 0; x < width * scale; x++) {
      const s = ((Math.floor(y / scale) * width) + Math.floor(x / scale)) * 4;
      const d = (y * big.width + x) * 4;
      big.data[d] = png.data[s];
      big.data[d + 1] = png.data[s + 1];
      big.data[d + 2] = png.data[s + 2];
      big.data[d + 3] = 255;
    }
  }
  fs.writeFileSync(path.join(out, `${name.replace(".bmp", ".png")}`), PNG.sync.write(big));
}
const ico = fs.readFileSync(path.join(dir, "app.ico"));
const count = ico.readUInt16LE(4);
for (let i = 0; i < count; i++) {
  const o = 6 + i * 16;
  const size = ico[o] || 256;
  fs.writeFileSync(path.join(out, `app-${size}.png`), ico.subarray(ico.readUInt32LE(o + 12), ico.readUInt32LE(o + 12) + ico.readUInt32LE(o + 8)));
}
console.log(out, fs.readdirSync(out).join(", "));
