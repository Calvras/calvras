// Rebuilds the desktop bundle. Windows keeps a delete lock on the electron
// runtime copy inside .output, so each build targets a fresh directory and is mirrored in.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TMP = `.build-${Date.now()}`;
const write = (file, text) => fs.writeFileSync(file, text);
const sh = (command, args, env = {}) => spawnSync(command, args, { stdio: "inherit", shell: true, env: { ...process.env, ...env } });

if (!fs.existsSync("nitro.config.ts")) write("nitro.config.ts", `export default { output: { dir: "${TMP}" } };\n`);
const temporary = fs.readFileSync("nitro.config.ts", "utf8").includes(TMP);
if (!temporary) throw new Error("nitro.config.ts already exists; refusing to overwrite it.");

const built = sh("npx", ["cross-env", "NITRO_PRESET=node-server", "vite", "build"]);
fs.rmSync("nitro.config.ts", { force: true });
if (built.status !== 0) process.exit(built.status ?? 1);
if (!fs.existsSync(path.join(TMP, "server", "index.mjs"))) throw new Error("Build produced no server entry.");

fs.mkdirSync(".output/server", { recursive: true });
fs.rmSync(".output/public", { recursive: true, force: true });
fs.cpSync(path.join(TMP, "public"), ".output/public", { recursive: true });
for (const name of fs.readdirSync(path.join(TMP, "server"))) {
  if (name === "node_modules") continue;
  try { fs.rmSync(path.join(".output/server", name), { recursive: true, force: true }); } catch { /* locked by a running app */ }
  fs.cpSync(path.join(TMP, "server", name), path.join(".output/server", name), { recursive: true });
}
fs.copyFileSync(path.join(TMP, "nitro.json"), ".output/nitro.json");
const prepared = sh("node", ["scripts/prepare-electron-runtime.mjs"]);
if (prepared.status !== 0) process.exit(prepared.status ?? 1);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* the locked electron copy stays behind */ }
console.log("Desktop bundle mirrored into .output.");
