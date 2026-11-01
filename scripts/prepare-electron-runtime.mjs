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

// Sign-in values for the shipped app. A Google desktop client id/secret and a GitHub OAuth App
// id/secret are install media, not credentials: PKCE proves the browser and this process are the
// same app, and the redirect is a fixed loopback address, so an extracted copy cannot sign anyone
// into anything. They live in this machine's Calvras folder, and every laptop that installs the app
// needs the same pair — without this copy each new machine answered "not configured on this
// computer". Read from there, written beside the shell code that reads it back, and gitignored so
// the values never reach the repository. A machine with no config simply ships no sign-in.
const oauthSourceDir = process.env.CALVRAS_OAUTH_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(process.env.HOME || "", ".local/share"), "Calvras");
const staged = {};
for (const [provider, file] of [["google", "google-oauth.json"], ["github", "github-oauth.json"]]) {
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(oauthSourceDir, file), "utf8"));
    if (stored.clientId) staged[provider] = { clientId: stored.clientId, ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}) };
  } catch { /* nothing saved for this provider */ }
}
if (Object.keys(staged).length) {
  fs.writeFileSync(path.join("electron", "oauth-defaults.json"), `${JSON.stringify(staged, null, 2)}\n`);
}
console.log(`Prepared the TypeScript compiler and playwright for the desktop runtime. Sign-in bundled for: ${Object.keys(staged).join(", ") || "nobody (no OAuth config on this machine)"}.`);
