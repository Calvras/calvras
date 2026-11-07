import fs from "node:fs/promises";
import path from "node:path";
import { providerKeys } from "./providers";
import { safeProjectPath } from "./file-tools";

/**
 * A picture the provider actually returned, before it goes into the project. Nothing here is a
 * placeholder: if no saved key can answer an image request, the call fails and says which provider
 * was tried, because a grey rectangle written to `assets/` is how a build ends up shipping a fake.
 */
export type GeneratedImage = { bytes: Buffer; mimeType: string; model: string; provider: string };

const GEMINI_LIST = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200";
const OPENROUTER_LIST = "https://openrouter.ai/api/v1/models";
const TIMEOUT_MS = 90_000;

const shortName = (name: string) => name.split("/").pop() || name;
const asItems = (payload: unknown): Record<string, unknown>[] =>
  Array.isArray(payload) ? payload as Record<string, unknown>[]
    : Array.isArray((payload as { data?: unknown })?.data) ? (payload as { data: Record<string, unknown>[] }).data
    : Array.isArray((payload as { models?: unknown })?.models) ? (payload as { models: Record<string, unknown>[] }).models
    : [];

/** Which of the caller's own models answer with a picture, read from the provider's list rather
 *  than assumed: these names get retired without notice and a hardcoded chain strands the tool. */
export function geminiImageModels(payload: unknown): string[] {
  const names = asItems(payload)
    .filter((entry) => Array.isArray(entry["supportedGenerationMethods"]) && (entry["supportedGenerationMethods"] as string[]).includes("generateContent"))
    .map((entry) => shortName(String(entry["name"] || "")))
    .filter((name) => /image/i.test(name) && !/edit/i.test(name));
  // A Gemini image model takes :generateContent; an imagen-* name only answers on :predict, so
  // the generateContent-capable ones are the whole list here.
  return [...new Set(names)].sort((a, b) => Number(/imagen/i.test(b)) - Number(/imagen/i.test(a)));
}

/** OpenRouter labels each model's input and output modalities, so the ones that emit images are
 *  read off that field instead of guessed from the name. */
export function openRouterImageModels(payload: unknown): string[] {
  return [...new Set(asItems(payload)
    .filter((entry) => {
      const architecture = entry["architecture"] as { output_modalities?: string[] } | undefined;
      return Array.isArray(architecture?.output_modalities) && architecture.output_modalities.includes("image");
    })
    .map((entry) => String(entry["id"] || ""))
    .filter(Boolean))];
}

const base64Of = (value: string): Buffer | null => {
  const inline = /^data:[^;]+;base64,(.+)$/s.exec(value.trim());
  const raw = (inline ? inline[1] || "" : value).replace(/\s+/g, "");
  if (raw.length < 64 || !/^[A-Za-z0-9+/=]+$/.test(raw)) return null;
  const bytes = Buffer.from(raw, "base64");
  return bytes.length > 512 ? bytes : null;
};

async function callGemini(prompt: string, aspectRatio: string, key: string, signal: AbortSignal, fetchImpl: typeof fetch): Promise<GeneratedImage> {
  const listed = await fetchImpl(GEMINI_LIST, { headers: { "x-goog-api-key": key }, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (!listed.ok) throw new Error(`Gemini refused the key when listing models (HTTP ${listed.status}).`);
  const models = geminiImageModels(await listed.json());
  if (!models.length) throw new Error("The Gemini account behind this key lists no image model. Ask for a key with image generation enabled, or wire an OpenRouter key in Settings.");
  const failures: string[] = [];
  for (const model of models.slice(0, 3)) {
    try {
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio } },
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { failures.push(`${model}: HTTP ${response.status} ${String((payload as { error?: { message?: string } })?.error?.message || "").slice(0, 160)}`); continue; }
      const parts = ((payload as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[] })?.candidates?.[0]?.content?.parts) || [];
      const picture = parts.find((part) => part.inlineData?.data);
      const bytes = picture?.inlineData?.data ? base64Of(picture.inlineData.data) : null;
      if (!bytes) { failures.push(`${model}: answered with no picture`); continue; }
      return { bytes, mimeType: picture?.inlineData?.mimeType || "image/png", model, provider: "gemini" };
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${model}: ${error instanceof Error ? error.message.slice(0, 160) : "call failed"}`);
    }
  }
  throw new Error(`Gemini returned no image (${failures.slice(0, 3).join("; ") || "no attempt reached the provider"}).`);
}

async function callOpenRouter(prompt: string, key: string, signal: AbortSignal, fetchImpl: typeof fetch): Promise<GeneratedImage> {
  const listed = await fetchImpl(OPENROUTER_LIST, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (!listed.ok) throw new Error(`OpenRouter refused the key when listing models (HTTP ${listed.status}).`);
  const models = openRouterImageModels(await listed.json());
  if (!models.length) throw new Error("This OpenRouter key can list models but none of them outputs images. Add a Gemini key in Settings instead.");
  const failures: string[] = [];
  for (const model of models.slice(0, 3)) {
    try {
      const response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], modalities: ["image"] }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { failures.push(`${model}: HTTP ${response.status} ${String((payload as { error?: { message?: string } })?.error?.message || "").slice(0, 160)}`); continue; }
      const message = (payload as { choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[] })?.choices?.[0]?.message;
      const encoded = message?.images?.[0]?.image_url?.url || "";
      const bytes = base64Of(encoded);
      if (!bytes) { failures.push(`${model}: answered with no picture`); continue; }
      return { bytes, mimeType: /^data:image\/([a-z+]+)/i.exec(encoded)?.[1] === "jpeg" ? "image/jpeg" : "image/png", model, provider: "openrouter" };
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${model}: ${error instanceof Error ? error.message.slice(0, 160) : "call failed"}`);
    }
  }
  throw new Error(`OpenRouter returned no image (${failures.slice(0, 3).join("; ") || "no attempt reached the provider"}).`);
}

/**
 * One picture, from whichever saved key can produce it. Gemini is tried first because that is the
 * provider Calvras already ships against; a 401/403 on a key is reported as a key problem rather
 * than retried through the rest of the chain.
 */
export async function generateImage(options: { prompt: string; aspectRatio?: string; signal: AbortSignal; fetchImpl?: typeof fetch; keys?: { gemini?: string; openrouter?: string } }): Promise<GeneratedImage> {
  const prompt = String(options.prompt || "").trim();
  if (prompt.length < 8) throw new Error("generate_image needs a real description of the picture in its prompt field.");
  if (prompt.length > 4000) throw new Error("Keep the image prompt under 4000 characters.");
  const keys = options.keys ?? providerKeys();
  const fetchImpl = options.fetchImpl ?? fetch;
  const chain = [keys.gemini ? () => callGemini(prompt, options.aspectRatio || "1:1", keys.gemini as string, options.signal, fetchImpl) : null, keys.openrouter ? () => callOpenRouter(prompt, keys.openrouter as string, options.signal, fetchImpl) : null].filter(Boolean) as (() => Promise<GeneratedImage>)[];
  if (!chain.length) throw new Error("No provider key is saved, so there is nothing to generate a picture with. Ask the user for a Gemini or OpenRouter key in Settings — do not write a placeholder file instead.");
  const failures: string[] = [];
  for (const attempt of chain) {
    try { return await attempt(); }
    catch (error) { if (options.signal.aborted) throw error; failures.push(error instanceof Error ? error.message : String(error)); }
  }
  throw new Error(`Image generation failed: ${failures.join(" | ").slice(0, 700)}`);
}

const extensionOf = (mimeType: string) => (mimeType.includes("jpeg") ? ".jpg" : mimeType.includes("webp") ? ".webp" : mimeType.includes("gif") ? ".gif" : ".png");

/**
 * Writes the picture into the project and returns the workspace-relative path the code will import.
 * The path is the deliverable: a generated asset nothing references is the same failure as an
 * unwired component, so the result names the folder it landed in and how to import it.
 */
export async function saveGeneratedImage(projectRoot: string, generated: GeneratedImage, requested: string, fallbackName: string): Promise<{ relativePath: string; target: string; bytes: number }> {
  const wanted = String(requested || "").trim() || `assets/generated/${fallbackName}${extensionOf(generated.mimeType)}`;
  const normalised = wanted.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (path.isAbsolute(normalised) || normalised.split("/").includes("..")) throw new Error("generate_image writes inside the project: give a path like assets/hero.png.");
  const extension = extensionOf(generated.mimeType);
  const withExtension = /\.(png|jpe?g|webp|gif)$/i.test(normalised) ? normalised : `${normalised}${extension}`;
  const target = await safeProjectPath(projectRoot, withExtension, false);
  if (generated.bytes.length > 8 * 1024 * 1024) throw new Error("The provider returned more than 8 MiB, which is not a project asset.");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, generated.bytes);
  return { relativePath: withExtension, target, bytes: generated.bytes.length };
}

/** A file-system-safe slug for the picture's own name, taken from its prompt. */
export function assetNameFrom(prompt: string): string {
  const words = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").filter(Boolean).slice(0, 5);
  return (words.join("-") || "generated-image").slice(0, 60);
}
