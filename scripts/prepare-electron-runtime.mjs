import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const output = path.resolve(".output/server");
if (!fs.existsSync(path.join(output, "index.mjs"))) throw new Error("Build the Electron server first.");
// These stay out of the bundle and ship as real packages next to the server: the compiler needs its
// standard .d.ts libraries on disk, and the browser tool imports playwright at call time.
for (const name of ["typescript", "playwright", "playwright-core"]) {
  const source = path.dirname(require.resolve(`${name}/package.json`));
  const target = path.join(output, "node_modules", name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}
console.log("Prepared the TypeScript compiler and playwright for the desktop runtime.");
