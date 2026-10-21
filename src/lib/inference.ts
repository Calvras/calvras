import { readSSE } from "./streaming";

type Message = { role: string; content: any };
type Keys = { openrouter?: string; gemini?: string; hf?: string };
type Candidate = { model: string; key: string; provider: "or" | "gemini" | "hf" };
/** How much thinking a request asks for. One name for the whole app: the Settings labels,
 * the composer's cycle and each subagent role all resolve to one of these three. */
export type InferenceProfile = "quick" | "balanced" | "thorough";
export type InferenceRoute = { profile?: InferenceProfile; model?: string };
/** Reply budget that goes with a profile. A quick worker still has to emit whole files as JSON,
 * so its floor sits above the chat path's. */
export const PROFILE_MAX_TOKENS: Record<InferenceProfile, number> = { quick: 4096, balanced: 8192, thorough: 16384 };
export const isProfile = (value: unknown): value is InferenceProfile => value === "quick" || value === "balanced" || value === "thorough";
/** "Quick", "quick" and a Settings chip all mean the same profile; anything else is not a choice. */
export function profileFrom(value: unknown): InferenceProfile | undefined {
  if (typeof value !== "string") return undefined;
  const lowered = value.trim().toLowerCase();
  return isProfile(lowered) ? lowered : undefined;
}
const cooldowns = new Map<string, number>();
/** Gemini models verified live against the configured key — each one accepts the
 * thinkingLevel its profile sends, plus inline image parts. Keep it that way when editing:
 * the 3.x non-lite models reject MINIMAL, and Google retires pinned version numbers without
 * warning, so a dead name here strands every run on a 404. */
const GEMINI_CHAIN: Record<"quick" | "balanced" | "thorough", string[]> = {
  quick: ["gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview", "gemini-flash-lite-latest"],
  balanced: ["gemini-3.7-flash", "gemini-3.1-flash-lite", "gemini-3.8-flash"],
  thorough: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.1-flash-lite"],
};
/** OpenRouter free models all share one daily quota, so the whole pool is parked once it is spent. */
const OR_FREE = { quick: "google/gemma-4-31b-it:free", balanced: "google/gemma-4-31b-it:free", thorough: "nvidia/nemotron-3-ultra-550b-a55b:free" } as const;
let orFreeParkedUntil = 0;
const orFreeParked = () => orFreeParkedUntil > Date.now();
/** A dropped stream is transient, so the whole cascade gets one more pass before the user sees anything. */
const STREAM_FAILURE = /stopped streaming|stream failed|took too long|empty response|socket|ECONNRESET|terminated|fetch failed/i;

/** A 401 on one model is not proof the user's key is broken — ask the provider's own auth
 *  endpoint before telling them to go and replace a key that still works. Answers with the
 *  providers whose key that endpoint refuses; an unreachable endpoint is not a refusal. */
async function rejectedKeys(keys: Keys) {
  const targets = Object.entries(keys).filter(([, key]) => Boolean(key)).map(([provider, key]) => ({
    provider,
    url: provider === "gemini"
      ? "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1"
      : provider === "openrouter" ? "https://openrouter.ai/api/v1/models" : "https://huggingface.co/api/whoami-v2",
    headers: provider === "gemini" ? { "x-goog-api-key": String(key) } : { authorization: `Bearer ${key}` },
  }));
  const answers = await Promise.all(targets.map(async (target) => {
    try { return { provider: target.provider, status: (await fetch(target.url, { headers: target.headers, signal: AbortSignal.timeout(8_000) })).status }; }
    catch { return { provider: target.provider, status: 0 /* unreachable is not a rejection */ }; }
  }));
  return answers.filter((answer) => answer.status === 401 || answer.status === 403).map((answer) => answer.provider);
}

/** A credential its own provider refuses is not worth a first-token wait on every round of a run
 *  that still has two hours of queue left. The park is keyed by the key, never by the provider name,
 *  so one dead OpenRouter credential cannot blind a different one on the same provider. */
const deadKeys = new Map<string, number>();
const deadKey = (provider: "or" | "gemini" | "hf", key: string) => (deadKeys.get(`${provider}:${key}`) ?? 0) > Date.now();

/** Recover a whole JSON reply from a stream that died before its closing frame. */
function salvage(text: string) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  for (let end = text.length; end > start; end--) {
    if (text[end - 1] !== "}") continue;
    try { JSON.parse(text.slice(start, end)); return text.slice(start, end); } catch { /* not a balanced object yet */ }
  }
  return null;
}

/** First public token wins; losing requests are cancelled, never mixed together. */
export async function inferStreaming(options: {
  messages: Message[];
  keys: Keys;
  signal?: AbortSignal;
  onDelta?: (text: string, model: string) => void;
  maxTokens?: number;
  temperature?: number;
  model?: string;
  hedgeMs?: number;
  firstTokenMs?: number;
  rateLimitWaitMs?: number;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  profile?: "quick" | "balanced" | "thorough";
}): Promise<{ text: string; model: string; truncated: boolean }> {
  const lifetime = new AbortController();
  /** When this request's providers said they would answer again, so the report can name it. */
  let parkedUntil = 0;
  const profile = options.profile === "quick" ? "quick" : options.profile === "thorough" ? "thorough" : "balanced";
  const totalMs = options.timeoutMs ?? (profile === "thorough" ? 240_000 : 150_000);
  const startedAt = Date.now();
  const deadline = AbortSignal.timeout(totalMs);
  const signal = AbortSignal.any([lifetime.signal, deadline, ...(options.signal ? [options.signal] : [])]);
  const hasImages = options.messages.some((m) => Array.isArray(m.content));
  const candidates: Candidate[] = [];
  // A model pinned in Settings is tried first, on whichever provider can serve it. A provider
  // whose stored key its own auth endpoint refused stays out of the chain.
  if (options.model) {
    if (options.keys.gemini && !deadKey("gemini", options.keys.gemini) && /^gemini/i.test(options.model)) candidates.push({ model: options.model, key: options.keys.gemini, provider: "gemini" });
    else if (options.keys.openrouter && !deadKey("or", options.keys.openrouter)) candidates.push({ model: options.model, key: options.keys.openrouter, provider: "or" });
  }
  // Gemini leads the chain: it has its own quota pool and handles both text and images, so
  // an exhausted OpenRouter free allowance can never strand the run on its own.
  if (options.keys.gemini && !deadKey("gemini", options.keys.gemini)) for (const model of GEMINI_CHAIN[profile]) candidates.push({ model, key: options.keys.gemini, provider: "gemini" });
  if (options.keys.openrouter && !deadKey("or", options.keys.openrouter)) {
    if (!orFreeParked()) candidates.push({ model: hasImages ? "nvidia/nemotron-3.5-super-vl:free" : OR_FREE[profile], key: options.keys.openrouter, provider: "or" });
    // The auto-router answers from its own pool, so a spent ":free" allowance must not take this
    // candidate with it — that park is what left a run with nothing but rate-limited models to wait on.
    if (!hasImages) candidates.push({ model: "openrouter/free", key: options.keys.openrouter, provider: "or" });
  }
  if (options.keys.hf && !deadKey("hf", options.keys.hf) && !hasImages) candidates.push({ model: "Qwen/Qwen2.5-Coder-32B-Instruct", key: options.keys.hf, provider: "hf" });
  const failures: string[] = [];

  const attempt = async (): Promise<{ text: string; model: string; truncated: boolean }> => {
    // Each pass classifies its own failures; a stale 429 from an earlier pass must not
    // decide which message the last pass reports.
    failures.length = 0;
    let eligible = candidates.filter((c) => (cooldowns.get(`${c.model}:${c.key}`) ?? 0) <= Date.now()).slice(0, 4);
    // Cooldowns schedule work, they do not strand it. If the whole list is marked cooling
    // down, the first candidates still get one real try before anything is reported.
    if (!eligible.length && candidates.length) eligible = candidates.slice(0, 2);
    if (!eligible.length) throw new Error("No model provider is available for this request.");
    let winner = -1;
    const controllers = eligible.map(() => new AbortController());
    let releaseNext: (() => void)[] = [];
    const waits = eligible.map((_, i) => new Promise<void>((resolve) => { releaseNext[i] = resolve; }));
    releaseNext[0]?.();
    // Candidates sharing one provider key hedge against each other for real only if they never
    // run at the same time — three parallel calls on one Gemini key trip its own rate limit.
    const sameKeyBefore = eligible.map((candidate, index) => {
      for (let earlier = index - 1; earlier >= 0; earlier--) if (eligible[earlier]!.provider === candidate.provider && eligible[earlier]!.key === candidate.key) return earlier;
      return -1;
    });
    const tasks = eligible.map(async (candidate, index) => {
      const own = controllers[index]!;
      const ownSignal = AbortSignal.any([signal, own.signal]);
      const hedge = setTimeout(() => releaseNext[index]?.(), index * (options.hedgeMs ?? (profile === "quick" ? 1200 : 2500)));
      const wake = () => releaseNext[index]?.();
      ownSignal.addEventListener("abort", wake, { once: true });
      let firstTokenTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let text = "";
      let hitLengthCap = false;
      try {
        await waits[index];
        const blocker = sameKeyBefore[index]!;
        if (blocker >= 0) await tasks[blocker]?.catch(() => {});
        ownSignal.throwIfAborted();
        firstTokenTimer = setTimeout(() => own.abort(new Error("Provider took too long to respond.")), options.firstTokenMs ?? (profile === "quick" ? 12_000 : 30_000));
        const append = (delta: string) => {
          if (!delta) return;
          ownSignal.throwIfAborted();
          if (winner === -1) {
            winner = index;
            controllers.forEach((controller, i) => { if (i !== index) controller.abort(); });
          }
          if (winner !== index) return;
          clearTimeout(firstTokenTimer);
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => own.abort(new Error("Provider stopped streaming.")), options.idleTimeoutMs ?? 45_000);
          text += delta;
          options.onDelta?.(delta, candidate.model);
        };
        let url: string;
        let headers: Record<string, string> = { "Content-Type": "application/json" };
        let body: any;
        if (candidate.provider === "gemini") {
          url = `https://generativelanguage.googleapis.com/v1beta/models/${candidate.model}:streamGenerateContent?alt=sse`;
          headers["x-goog-api-key"] = candidate.key;
          const parts = options.messages.filter((m) => m.role !== "system").flatMap((m) => typeof m.content === "string" ? [{ text: m.content }] : m.content.map((p: any) => p.type === "text" ? { text: p.text } : { inlineData: { mimeType: p.image_url.url.match(/^data:([^;]+)/)?.[1] || "image/jpeg", data: p.image_url.url.split(";base64,")[1] } }));
          body = { contents: [{ role: "user", parts }], systemInstruction: { parts: [{ text: options.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n") }] }, generationConfig: { temperature: options.temperature ?? 0.2, maxOutputTokens: options.maxTokens ?? 8192, responseMimeType: "application/json", thinkingConfig: { thinkingLevel: profile === "quick" ? "minimal" : "low" } } };
        } else {
          url = candidate.provider === "or" ? "https://openrouter.ai/api/v1/chat/completions" : "https://router.huggingface.co/v1/chat/completions";
          headers["Authorization"] = `Bearer ${candidate.key}`;
          const jsonResponse = candidate.provider === "or" && /^(?:google\/gemma-4|liquid\/)/.test(candidate.model) && options.messages.some((message) => message.role === "system" && /Return[^\n]*JSON/i.test(String(message.content)));
          body = { model: candidate.model, messages: options.messages, stream: true, temperature: options.temperature ?? 0.2, max_tokens: options.maxTokens ?? 8192, ...(jsonResponse ? { response_format: { type: "json_object" } } : {}), ...(candidate.provider === "or" ? { reasoning: { effort: profile === "thorough" ? "medium" : "low", exclude: true } } : {}) };
        }
        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ownSignal });
        if (!response.ok) {
          let dailyQuota = false;
          let parkedMs = 300_000;
          if (response.status === 429) {
            const problem = await response.json().catch(() => null);
            dailyQuota = /free-models-per-day|free-models|daily|per\.day/i.test(String(problem?.error?.message ?? problem?.error ?? ""));
            // Google and OpenRouter say when they will let you back in. Guessing 30s when the
            // answer says 900s just re-sends a request the provider has already refused.
            const seconds = Number(String(problem?.error?.details?.find?.((detail: any) => detail?.retryDelay)?.retryDelay ?? "").match(/^[\d.]+/)?.[0]);
            parkedMs = Math.min(30 * 60_000, Math.max(5_000, (Number.isFinite(seconds) ? seconds : 30) * 1000));
          }
          if ([401, 403, 404, 429].includes(response.status)) cooldowns.set(`${candidate.model}:${candidate.key}`, Date.now() + parkedMs);
          if (response.status === 429) parkedUntil = Math.max(parkedUntil, Date.now() + parkedMs);
          // OpenRouter's free allowance covers every ":free" model at once, so one spend means the
          // whole pool is dead until it resets. Park it rather than re-failing on every later call.
          if (dailyQuota && candidate.provider === "or") orFreeParkedUntil = Date.now() + 30 * 60_000;
          if (!response.bodyUsed) await response.body?.cancel();
          throw new Error(`${candidate.model}: HTTP ${response.status}${dailyQuota ? " (daily free-model quota)" : ""}`);
        }
        try {
          await readSSE(response, (data) => {
            if (data.error) throw new Error("Provider stream failed.");
            if (candidate.provider === "gemini") {
              if (String(data.candidates?.[0]?.finishReason ?? "") === "MAX_TOKENS") hitLengthCap = true;
              for (const part of data.candidates?.[0]?.content?.parts ?? []) if (part.text && !part.thought) append(part.text);
            } else {
              if (String(data.choices?.[0]?.finish_reason ?? "") === "length") hitLengthCap = true;
              const delta = data.choices?.[0]?.delta?.content;
              if (typeof delta === "string") append(delta);
            }
          }, ownSignal);
        } catch (error) {
          // The stream can die after the reply was already complete. Keep that work instead of
          // throwing the turn away and making the user start over.
          const whole = text.length > 12 ? salvage(text) : null;
          if (!whole) throw error;
          return { text: whole, model: candidate.model, truncated: hitLengthCap };
        }
        if (!text.trim()) throw new Error("Provider returned an empty response.");
        return { text, model: candidate.model, truncated: hitLengthCap };
      } catch (error) {
        if (winner === -1 || winner === index) failures.push(error instanceof Error ? error.message : "Provider request failed.");
        throw error;
      } finally {
        clearTimeout(hedge);
        clearTimeout(firstTokenTimer);
        clearTimeout(idleTimer);
        ownSignal.removeEventListener("abort", wake);
        releaseNext[index + 1]?.();
      }
    });
    return await Promise.any(tasks);
  };

  const streamBroke = () => failures.some((failure) => STREAM_FAILURE.test(failure));
  // A rate limit clears in seconds and a 503 is Google's "high demand, try again later", so
  // both are this turn's problem to ride out rather than a message the user has to act on.
  const busy = () => failures.some((failure) => /HTTP 429|HTTP 50[0-9]/.test(failure));
  const outOfTime = () => deadline.aborted || Boolean(options.signal?.aborted);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    try {
      return await attempt();
    } catch (error) {
      if (outOfTime()) throw error;
      if (busy() && !streamBroke() && totalMs - (Date.now() - startedAt) > 20_000) {
        // Free-tier rate windows clear in seconds. Waiting inside this turn is better than
        // handing the user a "wait briefly and retry" message they had to act on.
        for (const [key, until] of cooldowns) if (until - Date.now() < 30_000) cooldowns.delete(key);
        await sleep(options.rateLimitWaitMs ?? Math.min(12_000, totalMs - (Date.now() - startedAt) - 10_000));
        return await attempt();
      }
      if (!streamBroke() && !STREAM_FAILURE.test(error instanceof Error ? error.message : "")) throw error;
      await sleep(600);
      return await attempt();
    }
  } catch {
    options.signal?.throwIfAborted();
    if (failures.some((failure) => /HTTP 402/.test(failure))) throw new Error("The model provider requires credits. Check the provider balance, or store a key for another provider on this computer.");
    if (failures.some((failure) => /HTTP 429/.test(failure))) {
      // The providers state their own reset windows, so say how long rather than "briefly" when
      // the answer is a quarter of an hour.
      const waitMs = parkedUntil - Date.now();
      throw new Error(waitMs > 60_000 ? `The free model tiers are used up for about ${Math.ceil(waitMs / 60_000)} more minutes. Send it again after that, or store a paid key for another provider.` : "Model providers are rate limited. Wait briefly, or store a key for another provider on this computer.");
    }
    if (failures.some((failure) => /HTTP 40[13]/.test(failure))) {
      const refused = await rejectedKeys(options.keys);
      for (const provider of refused) {
        const key = options.keys[provider as "gemini" | "openrouter" | "hf"];
        if (key) deadKeys.set(`${provider === "openrouter" ? "or" : provider}:${key}`, Date.now() + 30 * 60_000);
      }
      const stored = Object.values(options.keys).filter(Boolean).length;
      // One dead key in a shelf of three is not a reason to abandon a run the other providers can
      // still carry, so only send the user off to replace keys when every stored one is refused.
      // Anything else reads as a refusal the turn waits out rather than a wall it stops at.
      const named = refused.map((provider) => ({ gemini: "Google", openrouter: "OpenRouter", hf: "Hugging Face" })[provider as "gemini" | "openrouter" | "hf"] || provider).join(" and ");
      throw new Error(refused.length && refused.length >= stored
        ? `A configured model key was rejected (${named}). Update the provider keys stored for Calvras on this computer.`
        : "The stored keys still sign in, but the model providers refused this request. Try again in a moment.");
    }
    if (deadline.aborted) throw new Error("AI providers did not respond in time. Retry, or check the provider access stored on this computer.");
    if (streamBroke()) throw new Error("The model connection dropped mid-reply, so Calvras asked it again and that failed too. Send the message once more to continue.");
    throw new Error("AI providers did not respond in time. Retry, or check the provider access stored on this computer.");
  } finally { lifetime.abort(); }
}
