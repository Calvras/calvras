// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { inferStreaming } from "../lib/inference";

const messages = [{ role: "user", content: "hey" }];
const stream = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
afterEach(() => vi.unstubAllGlobals());
describe("bounded inference", () => {
  it("uses the current Google fallback and preserves JSON public output", async () => {
    const fetcher=vi.fn(async()=>new Response('data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\ndata: [DONE]\n\n'));
    vi.stubGlobal("fetch",fetcher);
    expect((await inferStreaming({messages,keys:{gemini:"google-current"}})).text).toBe("hello");
    expect((fetcher.mock.calls[0] as any)[0]).toContain("gemini-3.7-flash");
    expect(JSON.parse((fetcher.mock.calls[0] as any)[1].body).generationConfig.thinkingConfig).toEqual({thinkingLevel:"low"});
  });
  it("only sends the quick profile's minimal thinking to models that accept it", async () => {
    const gemini = () => new Response('data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\ndata: [DONE]\n\n');
    const fetcher = vi.fn(async (_url: string | URL, _init: any) => gemini()); vi.stubGlobal("fetch", fetcher);
    await inferStreaming({ messages, keys: { gemini: "test-quick-profile" }, profile: "quick" });
    const body = JSON.parse((fetcher.mock.calls[0] as any)[1].body);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    // Google rejects MINIMAL on the non-lite 3.x models, so a quick turn aimed at one is a dead request.
    for (const call of fetcher.mock.calls) expect(String(call[0])).toMatch(/flash-lite/);
  });
  it("does not disable mandatory reasoning on the quick endpoint", async () => {
    const fetcher = vi.fn(async () => stream("hello")); vi.stubGlobal("fetch",fetcher);
    await inferStreaming({messages, keys:{openrouter:"quick-mandatory"},profile:"quick"});
    const body = JSON.parse((fetcher.mock.calls[0] as any)[1].body);
    expect(body.reasoning).toEqual({effort:"low",exclude:true});
  });
  it("shows an actionable authentication failure instead of calling it a timeout", async () => {
    vi.stubGlobal("fetch",vi.fn(async () => new Response("unauthorized",{status:401})));
    await expect(inferStreaming({messages,keys:{openrouter:"invalid-key-fixture"},hedgeMs:5})).rejects.toThrow("provider keys stored for Calvras");
  });
  it("does not blame the key when the provider still accepts it", async () => {
    // The model call refuses, but the sign-in check passes, so the key is not the problem.
    vi.stubGlobal("fetch",vi.fn(async (url) => String(url).endsWith("/api/v1/models") ? new Response('{"data":[]}') : new Response("nope",{status:401})));
    await expect(inferStreaming({messages,keys:{openrouter:"working-key-fixture"},hedgeMs:5})).rejects.toThrow("still sign in");
  });
  it("names the provider's own reset window instead of saying wait briefly", async () => {
    // A Response body is single-use, so each attempt gets its own.
    const later = () => new Response(JSON.stringify({error:{message:"You exceeded your current quota",details:[{reason:"RATE_LIMIT_EXCEEDED",retryDelay:"900s"}]}}),{status:429});
    vi.stubGlobal("fetch",vi.fn(async () => later()));
    await expect(inferStreaming({messages,keys:{gemini:"quota-fixture"},hedgeMs:5,rateLimitWaitMs:5})).rejects.toThrow(/about 1[0-9] more minutes/);
  });
  it("requests actual streaming with a short output budget and no extended reasoning", async () => {
    const fetcher = vi.fn(async () => stream("hello")); vi.stubGlobal("fetch", fetcher);
    const onDelta = vi.fn();
    expect(await inferStreaming({ messages, keys: { openrouter: "test-fast" }, onDelta })).toMatchObject({ text: "hello" });
    const body = JSON.parse((fetcher.mock.calls[0] as any)[1].body);
    expect(body).toMatchObject({ stream: true, max_tokens: 8192, reasoning: { effort: "low", exclude: true } });
    expect(onDelta).toHaveBeenCalledWith("hello", expect.any(String));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("hedges a stalled provider with another key and cancels the losing request", async () => {
    let losingSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (url, init) => {
      if (String(url).includes("generativelanguage")) {
        losingSignal = init.signal;
        return new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      }
      return stream("fallback");
    }); vi.stubGlobal("fetch", fetcher);
    const started = performance.now();
    expect((await inferStreaming({ messages, keys: { gemini: "test-hedge-g", openrouter: "test-hedge-o" }, hedgeMs: 10, firstTokenMs: 1000 })).text).toBe("fallback");
    expect(performance.now() - started).toBeLessThan(500);
    expect(losingSignal?.aborted).toBe(true);
  });
  it("immediately advances after rejection and skips rate-limited models on the next turn", async () => {
    const fetcher = vi.fn(async (_url, init) => JSON.parse(init.body).model.includes("gemma-4-31b") ? new Response("rate limited", { status: 429 }) : stream("ok")); vi.stubGlobal("fetch", fetcher);
    await inferStreaming({ messages, keys: { openrouter: "test-cooldown" }, hedgeMs: 1000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockClear();
    await inferStreaming({ messages, keys: { openrouter: "test-cooldown" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetcher.mock.calls[0] as any)[1].body).model).not.toContain("gemma-4-31b");
  });
  it("never overlaps two requests on the same provider key", async () => {
    let active = 0, peak = 0, calls = 0;
    const gemini = () => new Response('data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\ndata: [DONE]\n\n');
    const fetcher = vi.fn(async () => {
      calls++; active++; peak = Math.max(peak, active);
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 40));
      active--;
      return calls === 1 ? new Response(JSON.stringify({ error: { message: "429 Too Many Requests" } }), { status: 429 }) : gemini();
    });
    vi.stubGlobal("fetch", fetcher);
    expect((await inferStreaming({ messages, keys: { gemini: "test-serialize" }, hedgeMs: 2 })).text).toBe("hello");
    expect(peak).toBe(1);
  });
  it("waits out a rate limit instead of ending the turn with a rate-limit error", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => { calls++; return calls <= 2 ? new Response(JSON.stringify({ error: { message: "Too many requests" } }), { status: 429 }) : stream("recovered"); });
    vi.stubGlobal("fetch", fetcher);
    expect((await inferStreaming({ messages, keys: { openrouter: "test-backoff" }, hedgeMs: 5, rateLimitWaitMs: 20 })).text).toBe("recovered");
  });
  it("keeps a complete reply from a stream that dies after the last token", async () => {
    const payload = JSON.stringify({ choices: [{ delta: { content: "{\"message\":\"finished\",\"actions\":[]}" } }] });
    const stalled = () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("data: " + payload + "\n\n"));
      setTimeout(() => controller.error(new Error("socket hang up")), 10);
    } }));
    vi.stubGlobal("fetch", vi.fn(async () => stalled()));
    expect(await inferStreaming({ messages, keys: { openrouter: "test-salvage" } })).toMatchObject({ text: "{\"message\":\"finished\",\"actions\":[]}" });
  });
  it("asks the cascade again when a provider stalls mid-stream", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => { calls++; return calls <= 2 ? new Response(new ReadableStream({ start() { /* never answers */ } })) : stream("recovered"); });
    vi.stubGlobal("fetch", fetcher);
    expect((await inferStreaming({ messages, keys: { openrouter: "test-retry" }, firstTokenMs: 30, hedgeMs: 5 })).text).toBe("recovered");
    expect(calls).toBeGreaterThan(2);
  });
  it("has an overall deadline and propagates cancellation", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))));
    const started = performance.now();
    await expect(inferStreaming({ messages, keys: { openrouter: "test-timeout" }, timeoutMs: 40, hedgeMs: 5 })).rejects.toThrow("did not respond");
    expect(performance.now() - started).toBeLessThan(500);
    const controller = new AbortController(); controller.abort();
    await expect(inferStreaming({ messages, keys: { openrouter: "test-cancel" }, signal: controller.signal })).rejects.toThrow();
  });
});
