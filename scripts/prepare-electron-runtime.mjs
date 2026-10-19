import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const output = path.resolve(".output/server");
if (!fs.existsSync(path.join(output, "index.mjs"))) throw new Error("Build the Electron server first.");
// These stay out of the bundle and ship as real packages next to the server: the compiler needs its
// standard .d.ts libraries on disk, the browser tool imports playwright at call time, and the radix
// chunks import tslib at runtime. Outside this repo there is no parent node_modules to fall back on,
// so anything the server imports by bare name has to be copied here.
for (const name of ["typescript", "playwright", "playwright-core", "tslib"]) {
  const source = path.dirname(require.resolve(`${name}/package.json`));
  const target = path.join(output, "node_modules", name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}
console.log("Prepared the TypeScript compiler and playwright for the desktop runtime.");
