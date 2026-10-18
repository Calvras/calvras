// Answers one question without ever printing a credential: are the model keys saved on this
// computer still accepted by their provider? Reports provider name, key length and HTTP status.
// Reads the same file the agent's own routing reads, so no running app instance is needed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const file = path.join(process.env["LOCALAPPDATA"] || path.join(os.homedir(), ".local", "share"), "Calvras", "providers.json");

const targets = [
  { provider: "gemini", env: ["GEMINI_API_KEY"], url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=5", header: (key) => ({ "x-goog-api-key": key }) },
  { provider: "openrouter", env: ["OPENROUTER_API_KEY"], url: "https://openrouter.ai/api/v1/models", header: (key) => ({ Authorization: `Bearer ${key}` }) },
  { provider: "hf", env: ["HUGGINGFACE_API_KEY", "HF_TOKEN"], url: "https://huggingface.co/api/whoami-v2", header: (key) => ({ Authorization: `Bearer ${key}` }) },
];

let stored = {};
try { stored = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* nothing saved yet */ }

const keys = [];
for (const target of targets) {
  const fromEnv = target.env.map((name) => process.env[name]).find(Boolean);
  const key = String(fromEnv || stored[target.provider] || "");
  if (!key) { keys.push({ provider: target.provider, configured: false }); continue; }
  try {
    const response = await fetch(target.url, { headers: target.header(key), signal: AbortSignal.timeout(15_000) });
    keys.push({ provider: target.provider, configured: true, length: key.length, status: response.status, accepted: response.ok });
  } catch (error) {
    keys.push({ provider: target.provider, configured: true, length: key.length, status: `NETWORK_ERROR ${error instanceof Error ? error.name : "?"}` });
  }
}

console.log(JSON.stringify({ keyFile: fs.existsSync(file) ? file : "none", keys }, null, 2));
process.exit(keys.some((entry) => entry.configured && !entry.accepted) ? 1 : 0);
