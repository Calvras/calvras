// Builds the Windows installer end to end: wizard art from the app logo, the Electron payload,
// then the Inno Setup compile. `--skip-app-build` reuses the existing win-unpacked folder, which is
// what you want while iterating on the wizard itself.
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const skipAppBuild = process.argv.includes("--skip-app-build");

function run(command, args, label) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: true });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

function findCompiler() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Inno Setup 6", "ISCC.exe"),
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`Inno Setup was not found. Looked in:\n${candidates.map((c) => `  ${c}`).join("\n")}\nInstall it from https://jrsoftware.org/isdl.php`);
  }
  return found;
}

/** Install the built setup for real, then run the server out of the install folder. Inside the repo
 * a stray `node_modules` above the payload hides a missing runtime package, so only the installed
 * copy can prove the app will boot on someone's machine. */
async function verifyInstaller(setup) {
  const scratch = path.join(process.env.LOCALAPPDATA, "calvras-installer-check");
  const installDir = path.join(scratch, "Calvras");
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });

  run(`"${setup}"`, ["/VERYSILENT", "/NORESTART", `/DIR="${installDir}"`, "/SUPPRESSMSGBOXES"], "Silent install");
  try {
    const exe = path.join(installDir, "Calvras.exe");
    if (!fs.existsSync(exe)) throw new Error(`Silent install produced no ${exe}`);
    const entry = path.join(installDir, "resources", "server", "index.mjs");
    if (!fs.existsSync(entry)) throw new Error(`Installed payload has no server entry at ${entry}`);

    const port = 4700 + Math.floor(Math.random() * 200);
    const child = spawn(process.execPath, [entry], {
      cwd: path.dirname(entry),
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    try {
      let status = 0;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          const res = await fetch(`http://127.0.0.1:${port}/`);
          status = res.status;
          if (status === 200) break;
        } catch {
          /* still booting */
        }
      }
      if (status !== 200) throw new Error(`Installed server served / as ${status || "no response"}.\n${stderr.slice(-2000)}`);
      console.log("Installed server check: GET / -> 200");
    } finally {
      child.kill();
    }
  } finally {
    const uninstaller = path.join(installDir, "unins000.exe");
    if (fs.existsSync(uninstaller)) {
      run(`"${uninstaller}"`, ["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"], "Silent uninstall");
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json version is not x.y.z: ${version}`);

run("node", ["installer/make-assets/make.mjs"], "Wizard art");

// Windows holds a delete lock on win-unpacked\resources\app.asar for as long as any running app has it
// mapped, and electron-builder has to replace that file. So each build packs into its own folder and
// hands it to ISCC as /DAppPayload; older payload folders are removed best-effort.
const payloadRoot = path.join(root, "electron-dist");
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 14);
let payloadDir = `payload-${stamp}`;
let payload = path.join(payloadRoot, payloadDir, "win-unpacked");

if (skipAppBuild) {
  const existing = fs.readdirSync(payloadRoot).filter((name) => name.startsWith("payload-")).sort();
  if (!existing.length) throw new Error(`--skip-app-build needs an existing payload under ${payloadRoot}. Run it once without the flag.`);
  payloadDir = existing.at(-1);
  payload = path.join(payloadRoot, payloadDir, "win-unpacked");
} else {
  run("node", ["scripts/rebuild-app.mjs"], "Desktop bundle");
  run("npx", ["electron-builder", "--dir", "--win", "--x64", `--config.directories.output=electron-dist/${payloadDir}`], "Electron payload");
}

if (!fs.existsSync(path.join(payload, "Calvras.exe"))) throw new Error(`No payload exe at ${path.join(payload, "Calvras.exe")}.`);

for (const name of fs.readdirSync(payloadRoot).filter((entry) => entry.startsWith("payload-") && entry !== payloadDir)) {
  try { fs.rmSync(path.join(payloadRoot, name), { recursive: true, force: true }); } catch { /* a locked folder is left for the next run */ }
}

const iscc = findCompiler();
const relative = path.relative(path.join(root, "installer"), payload).split(path.sep).join("\\");
run(`"${iscc}"`, [`/DMyAppVersion=${version}`, `/DAppPayload=${relative}`, "installer/CalvrasSetup.iss"], "Inno Setup");

const output = path.join(root, "dist", "installer", "Calvras-Setup-win-x64.exe");
const stat = fs.statSync(output);
console.log(`\nInstaller: ${output}`);
console.log(`Version:   ${version}`);
console.log(`Size:      ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

await verifyInstaller(output);

