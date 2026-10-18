import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const output = path.resolve(".output/server");
if (!fs.existsSync(path.join(output, "index.mjs"))) throw new Error("Build the Electron server first.");
// The compiler is CommonJS and requires its standard .d.ts libraries on disk.
// Keep it as a real package instead of rewriting its runtime into an ESM bundle.
const source = path.dirname(require.resolve("typescript/package.json"));
const target = path.join(output, "node_modules", "typescript");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, { recursive: true });
console.log("Prepared TypeScript compiler and standard libraries for the desktop runtime.");
