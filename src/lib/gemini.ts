export interface MediaAttachment {
  mimeType: string;
  data: string; // Base64 or URL
}

// User overrides are ephemeral. Default provider credentials stay on the server.
export const getGeminiKey = () => typeof globalThis !== "undefined" ? (globalThis as any).__GEMINI_KEY__ || "" : "";
export const getOpenRouterKey = () => typeof globalThis !== "undefined" ? (globalThis as any).__OPENROUTER_KEY__ || "" : "";

export function setGeminiKey(key: string) {
  if (typeof globalThis !== "undefined") (globalThis as any).__GEMINI_KEY__ = key;
}
export function setOpenRouterKey(key: string) {
  if (typeof globalThis !== "undefined") (globalThis as any).__OPENROUTER_KEY__ = key;
}

export { CALVRAS_SYSTEM_PROMPT } from "./system-prompt";
import { CALVRAS_SYSTEM_PROMPT } from "./system-prompt";

// All inference goes through one bounded server request; no duplicate client cascade.
import { readSSE } from "./streaming";
import { readPreferences } from "./preferences";

export async function callAI(
  prompt: string,
  systemInstruction?: string,
  mediaAttachments?: MediaAttachment[],
  projectContext?: string,
  signal?: AbortSignal,
  onDelta?: (text: string) => void,
  effort = "Balanced"
): Promise<string> {
  signal?.throwIfAborted();
  // A model pinned in Settings overrides the automatic cascade for every request.
  const pinned = typeof window === "undefined" ? "" : readPreferences().model;
  const system = [systemInstruction || CALVRAS_SYSTEM_PROMPT, projectContext].filter(Boolean).join("\n\n");
  const content = mediaAttachments?.length ? [
    ...mediaAttachments.map((m) => ({ type: "image_url", image_url: { url: m.data.startsWith("data:") ? m.data : `data:${m.mimeType};base64,${m.data}` } })),
    { type: "text", text: prompt },
  ] : prompt;
  const request = async (messages: Array<{ role: string; content: unknown }>, alreadySent: string) => {
    const response = await fetch("/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(pinned ? { model: pinned } : {}), messages, stream: true, max_tokens: effort === "Quick" ? 2048 : effort === "Thorough" ? 16384 : 8192, profile: effort === "Quick" ? "quick" : effort === "Thorough" ? "thorough" : "balanced",
        keys: { gemini: getGeminiKey(), openrouter: getOpenRouterKey() } }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`AI request failed (HTTP ${response.status}).`);
    let received = "";
    let cutOff = false;
    await readSSE(response, (data) => {
      if (data.error) throw new Error(data.error.message || "Inference failed. Please retry.");
      if (data.choices?.[0]?.finish_reason === "length") cutOff = true;
      const delta = data.choices?.[0]?.delta?.content;
      if (typeof delta === "string") { received += delta; onDelta?.(alreadySent + received); }
    }, signal);
    return { received, cutOff };
  };

  let text = "";
  let cutOff = false;
  const first = await request([{ role: "system", content: system }, { role: "user", content }], "");
  text = first.received;
  cutOff = first.cutOff;
  // A reply stopped by the token cap is a half-written document, not a finished answer. Ask for
  // the remainder and keep going instead of handing the agent — and then the user — a truncation.
  for (let round = 0; round < 4 && cutOff; round++) {
    signal?.throwIfAborted();
    const prior = text;
    const next = await request([
      { role: "system", content: "You are continuing a reply that was cut off by the token limit. Output only the remaining characters of that reply. Do not repeat any earlier text, restate it, or add a preamble." },
      { role: "assistant", content: prior },
      { role: "user", content: "Continue exactly where you stopped." },
    ], prior);
    if (!next.received) break;
    text += next.received;
    cutOff = next.cutOff;
  }
  if (!text.trim()) throw new Error("The inference provider returned no answer. Please retry.");
  return text;
}
