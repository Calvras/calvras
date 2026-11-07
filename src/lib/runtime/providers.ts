import fs from "node:fs";
import path from "node:path";
import os from "node:os";
type Provider = "openrouter" | "gemini" | "hf";
const file = () => path.join(process.env["LOCALAPPDATA"] || path.join(os.homedir(), ".local", "share"), "Calvras", "providers.json");
function stored(): Partial<Record<Provider, string>> { try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch { return {}; } }
export function providerKeys() {
  const keys = stored();
  return { openrouter: process.env["OPENROUTER_API_KEY"] || keys.openrouter || "", gemini: process.env["GEMINI_API_KEY"] || keys.gemini || "", hf: process.env["HUGGINGFACE_API_KEY"] || process.env["HF_TOKEN"] || keys.hf || "" };
}
export function providerStatus() { return { configured: Object.fromEntries(Object.entries(providerKeys()).map(([name, key]) => [name, Boolean(key)])) }; }
/** Which copy of a key is actually in force. An environment variable shadows the saved one, so a
 * rejected key means something different depending on which of the two got sent — and on a machine
 * where a stale export is still set, "my key is broken" is the wrong conclusion. */
export function providerKeySource(provider: Provider): string {
  const envNames: Record<Provider, string[]> = { openrouter: ["OPENROUTER_API_KEY"], gemini: ["GEMINI_API_KEY"], hf: ["HUGGINGFACE_API_KEY", "HF_TOKEN"] };
  const fromEnv = envNames[provider].find((name) => process.env[name]);
  if (fromEnv) return `the ${fromEnv} environment variable, which overrides the saved key`;
  return stored()[provider] ? "the key saved in Calvras" : "";
}
export function setProvider(provider: string, key: string) {
  if (!["openrouter", "gemini", "hf"].includes(provider) || typeof key !== "string" || key.length > 1000) throw new Error("Choose a supported provider and valid key.");
  const keys = stored(); keys[provider as Provider] = key.trim(); const target = file(); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target + ".tmp", JSON.stringify(keys), { mode: 0o600 }); fs.renameSync(target + ".tmp", target);
  return providerStatus();
}
/** Exercise a saved key against the provider's own API so Settings can say "this works"
 * from evidence rather than from a key merely being present. */
export async function testProvider(provider: string): Promise<{ ok: boolean; message: string }> {
  const keys = providerKeys();
  const key = keys[provider as Provider];
  if (!key) return { ok: false, message: "No key is saved for this provider yet." };
  const target = provider === "gemini"
    ? { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=5", headers: { "x-goog-api-key": key } }
    : provider === "openrouter"
      ? { url: "https://openrouter.ai/api/v1/models", headers: { Authorization: `Bearer ${key}` } }
      : { url: "https://huggingface.co/api/whoami-v2", headers: { Authorization: `Bearer ${key}` } };
  try {
    const response = await fetch(target.url, { headers: target.headers, signal: AbortSignal.timeout(15_000) });
    if (response.status === 401 || response.status === 403) return { ok: false, message: "The provider rejected this key — it is wrong, revoked, or restricted. Ask for a fresh one rather than retrying." };
    if (response.status === 402) return { ok: false, message: "The key is valid but the account has no credit for this call. That is a billing wall, not a broken key." };
    if (response.status === 429) return { ok: false, message: "The key works, but its rate limit or quota is currently spent." };
    if (!response.ok) return { ok: false, message: `The provider answered HTTP ${response.status}.` };
    const data = await response.json().catch(() => null);
    const listed = Array.isArray(data?.data) ? data.data.length : Array.isArray(data?.models) ? data.models.length : 0;
    const handle = typeof data?.name === "string" ? data.name : "";
    return { ok: true, message: handle ? `Signed in as ${handle}.` : listed ? `Key accepted — ${listed} models available.` : "Key accepted." };
  } catch (error) {
    return { ok: false, message: `Could not reach the provider: ${error instanceof Error ? error.message : "network error"}` };
  }
}
