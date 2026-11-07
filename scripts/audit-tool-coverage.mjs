// Lists every tool named in the catalog that no dispatcher can actually run.
// A tool the model can call but the runtime cannot execute is a false capability, so this is a
// gate, not a report: it exits non-zero when the catalog promises something unimplemented.
import fs from "node:fs/promises";

const catalog = await fs.readFile("src/lib/tool-catalog.ts", "utf8");
const groupsBlock = /const groups = \{([\s\S]*?)\n\} as const;/.exec(catalog)?.[1] || "";
const catalogued = [...groupsBlock.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);

const sources = {
  "runtime/agent-runtime": await fs.readFile("src/lib/runtime/agent-runtime.ts", "utf8"),
  "runtime/file-tools": await fs.readFile("src/lib/runtime/file-tools.ts", "utf8"),
  "runtime/command-tools": await fs.readFile("src/lib/runtime/command-tools.ts", "utf8"),
  "runtime/browser-tools": await fs.readFile("src/lib/runtime/browser-tools.ts", "utf8"),
  "runtime/computer-tools": await fs.readFile("src/lib/runtime/computer-tools.ts", "utf8"),
  "runtime/code-intelligence": await fs.readFile("src/lib/runtime/code-intelligence.ts", "utf8"),
};
const implemented = new Set();
for (const text of Object.values(sources)) {
  for (const match of text.matchAll(/case "([a-z0-9_]+)"/g)) implemented.add(match[1]);
  // Named arrays of tool verbs: export const FILE_TOOLS = ["read_file", …]
  for (const match of text.matchAll(/(?:const|export const) [A-Z_]+ *= *(?:\[|[\s\S]{0,40}?\[)([\s\S]*?)\]/g)) {
    for (const name of match[1].matchAll(/['"]([a-z0-9_]+)['"]/g)) implemented.add(name[1]);
  }
  for (const match of text.matchAll(/case '([a-z0-9_]+)'/g)) implemented.add(match[1]);
}
const missing = catalogued.filter((name) => !implemented.has(name));
console.log(`catalog: ${catalogued.length} tools, dispatchers recognise ${implemented.size}`);
console.log(missing.length ? `UNIMPLEMENTED (${missing.length}):\n  ${missing.join("\n  ")}` : "every catalogued tool has a dispatcher");
process.exit(missing.length ? 1 : 0);
