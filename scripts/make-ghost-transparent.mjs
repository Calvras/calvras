import fs from 'node:fs';
import { PNG } from 'pngjs';

const src = process.argv[2];
const dst = process.argv[3];
const png = PNG.sync.read(fs.readFileSync(src));
const { width, height, data } = png;
const bg = [245, 247, 250];
const tol = 40;
const isBg = (i) => {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  return Math.abs(r - bg[0]) <= tol && Math.abs(g - bg[1]) <= tol && Math.abs(b - bg[2]) <= tol;
};
const seen = new Uint8Array(width * height);
const stack = [];
for (let x = 0; x < width; x++) { stack.push(x, (height - 1) * width + x); }
for (let y = 0; y < height; y++) { stack.push(y * width, y * width + width - 1); }
while (stack.length) {
  const p = stack.pop();
  if (seen[p]) continue;
  seen[p] = 1;
  const i = p * 4;
  if (!isBg(i)) continue;
  data[i + 3] = 0;
  const x = p % width, y = (p / width) | 0;
  if (x > 0) stack.push(p - 1);
  if (x < width - 1) stack.push(p + 1);
  if (y > 0) stack.push(p - width);
  if (y < height - 1) stack.push(p + width);
}
fs.writeFileSync(dst, PNG.sync.write(png));
console.log('wrote', dst);