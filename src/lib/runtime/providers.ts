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
    if (!response.ok) return { ok: false, message: `The provider answered HTTP ${response.status}. The key may be wrong, restricted, or out of quota.` };
    const data = await response.json().catch(() => null);
    const listed = Array.isArray(data?.data) ? data.data.length : Array.isArray(data?.models) ? data.models.length : 0;
    const handle = typeof data?.name === "string" ? data.name : "";
    return { ok: true, message: handle ? `Signed in as ${handle}.` : listed ? `Key accepted — ${listed} models available.` : "Key accepted." };
  } catch (error) {
    return { ok: false, message: `Could not reach the provider: ${error instanceof Error ? error.message : "network error"}` };
  }
}
