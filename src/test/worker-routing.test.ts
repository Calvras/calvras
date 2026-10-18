// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../lib/runtime/agent-runtime";
import { DEFAULT_WORKER_ROUTING, mergeRoute, sanitizeRouting } from "../lib/runtime/worker-pool";
import { handleAgentApi } from "../lib/runtime/api";
import { PROFILE_MAX_TOKENS, inferStreaming, profileFrom } from "../lib/inference";
import { RuntimeClient } from "../lib/runtime-client";
import { CALVRAS_SYSTEM_PROMPT } from "../lib/system-prompt";
import { DEFAULT_ROLE_ROUTING, sanitizeWorkerRouting } from "../lib/preferences";
import { validateToolAction } from "../lib/tool-catalog";

let base = "";
let root = "";
const sessions: AgentSession[] = [];

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "calvras-worker-routing-")));
  root = path.join(base, "work");
  await fs.mkdir(root, { recursive: true });
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.stop();
  vi.unstubAllGlobals();
  await fs.rm(base, { recursive: true, force: true }).catch(() => {});
});

const track = (session: AgentSession) => { sessions.push(session); return session; };

describe("the effort a role name can resolve to", () => {
  it("accepts every spelling the UI produces and rejects anything else", () => {
    expect(profileFrom("Quick")).toBe("quick");
    expect(profileFrom("  THOROUGH ")).toBe("thorough");
    expect(profileFrom("balanced")).toBe("balanced");
    expect(profileFrom("maximum")).toBeUndefined();
    expect(profileFrom(undefined)).toBeUndefined();
    expect(profileFrom(2)).toBeUndefined();
  });
  it("gives each effort a reply budget that fits the work", () => {
    expect(PROFILE_MAX_TOKENS).toEqual({ quick: 4096, balanced: 8192, thorough: 16384 });
  });
});

describe("routing table sanitation", () => {
  it("falls back to the built-in table for anything missing or nonsense", () => {
    for (const raw of [undefined, null, "yes", 42, {}, { builder: "fast" }, { extra: { profile: "quick" } }]) {
      expect(sanitizeRouting(raw)).toEqual(DEFAULT_WORKER_ROUTING);
    }
  });
  it("reads the Settings shape (effort + model) as well as the runtime one", () => {
    const fromSettings = sanitizeRouting({ builder: { effort: "Thorough", model: "" }, researcher: { effort: "quick", model: "gemini-3.1-flash-lite" } });
    expect(fromSettings.builder).toEqual({ profile: "thorough" });
    expect(fromSettings.researcher).toEqual({ profile: "quick", model: "gemini-3.1-flash-lite" });
    // A role nobody touched keeps its default rather than inheriting a neighbour's choice.
    expect(fromSettings.verifier).toEqual(DEFAULT_WORKER_ROUTING.verifier);
  });
  it("clips an over-long model name instead of passing it through", () => {
    const routed = sanitizeRouting({ verifier: { model: `x${"y".repeat(200)}` } });
    expect(routed.verifier.model).toHaveLength(120);
  });
  it("lets a delegation override one field and keep the rest", () => {
    expect(mergeRoute({ profile: "balanced", model: "a" }, { profile: "quick" })).toEqual({ profile: "quick", model: "a" });
    expect(mergeRoute({ profile: "balanced" }, undefined)).toEqual({ profile: "balanced" });
    expect(mergeRoute()).toEqual({});
  });
  it("keeps a stored preferences blob readable per role with defaults underneath", () => {
    expect(sanitizeWorkerRouting(undefined)).toEqual(DEFAULT_ROLE_ROUTING);
    expect(sanitizeWorkerRouting({ builder: { effort: "Ludicrous", model: 5 }, verifier: { effort: "Thorough", model: " gemini-3.7-flash " } }))
      .toEqual({ builder: { effort: "Balanced", model: "" }, verifier: { effort: "Thorough", model: "gemini-3.7-flash" }, researcher: { effort: "Quick", model: "" } });
  });
});

describe("a worker inferred on its role's engine", () => {
  const done = async () => JSON.stringify({ message: "Said what I run on.", actions: [], status: "complete" });

  it("receives the profile and model the user set for that role", async () => {
    const calls: { system?: string | undefined; route?: unknown }[] = [];
    const session = track(new AgentSession(root, "full", async (prompt, _delta, system, route) => {
      calls.push({ system, route });
      return done();
    }, undefined, { builder: { profile: "thorough", model: "gemini-3.8-flash" }, researcher: { profile: "quick" } }));
    const delegated = await session.execute({ type: "delegate_task", role: "builder", task: "Summarise the plan for the sidebar" });
    await session.pool.wait(delegated.job.id, 8_000);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toMatchObject({ route: { profile: "thorough", model: "gemini-3.8-flash" } });
    // The role still gets its own worker prompt alongside the engine.
    expect(calls[0]?.system).toContain("builder worker inside Calvras");

    const other = await session.execute({ type: "delegate_task", role: "researcher", task: "List the routes in the app" });
    await session.pool.wait(other.job.id, 8_000);
    const researcherCall = calls[calls.length - 1];
    expect(researcherCall).toMatchObject({ route: { profile: "quick" } });
    expect(researcherCall?.system).toContain("researcher worker inside Calvras");
  });

  it("honours a one-off effort or model named in the delegation", async () => {
    const calls: unknown[] = [];
    const session = track(new AgentSession(root, "full", async (_prompt, _delta, _system, route) => {
      calls.push(route);
      return done();
    }, undefined, { builder: { profile: "balanced", model: "gemini-3.7-flash" } }));
    const job = (await session.execute({ type: "delegate_task", role: "builder", task: "Reword the empty state", effort: "Quick" })).job;
    await session.pool.wait(job.id, 8_000);
    // Quick wins, the role's pinned model stays because the delegation did not name one.
    expect(calls[0]).toEqual({ profile: "quick", model: "gemini-3.7-flash" });

    const pinned = (await session.execute({ type: "delegate_task", role: "builder", task: "Reword the header", effort: "Thorough", model: "gemini-3.1-flash-lite" })).job;
    await session.pool.wait(pinned.id, 8_000);
    expect(calls[calls.length - 1]).toEqual({ profile: "thorough", model: "gemini-3.1-flash-lite" });
    // The role's own routing is untouched by either override.
    expect(session.routing.builder).toEqual({ profile: "balanced", model: "gemini-3.7-flash" });
  });

  it("reports each job's engine from status so the trace can name it", async () => {
    const session = track(new AgentSession(root, "full", done, undefined, { verifier: { profile: "thorough", model: "gemini-3.8-flash" } }));
    const job = (await session.execute({ type: "delegate_task", role: "verifier", task: "Read the test list and describe it", effort: "quick" })).job;
    await session.pool.wait(job.id, 8_000);
    const group = session.status().agents.find((entry) => entry.role === "verifier");
    expect(group?.jobs.at(-1)).toMatchObject({ id: job.id, engine: { profile: "quick", model: "gemini-3.8-flash" } });
    expect(session.status().routing.verifier).toEqual({ profile: "thorough", model: "gemini-3.8-flash" });
  });

  it("refuses an effort the runtime could not map before the job is queued", () => {
    expect(() => validateToolAction({ type: "delegate_task", role: "builder", task: "Do it", effort: "maximum" })).toThrow(/quick, balanced or thorough/);
    expect(() => validateToolAction({ type: "delegate_task", role: "builder", task: "Do it", model: 7 })).toThrow(/single word/);
    expect(validateToolAction({ type: "delegate_task", role: "builder", task: "Do it", effort: "Thorough", model: "gemini-3.7-flash" })).toMatchObject({ effort: "Thorough", model: "gemini-3.7-flash" });
  });
});

describe("routing through the session API", () => {
  const open = async (body: Record<string, unknown>) => {
    const response = await handleAgentApi(new Request("http://localhost:3000/api/agent/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), async () => '{"tasks":[]}');
    expect(response).not.toBeNull();
    return response!.json() as Promise<any>;
  };
  const patch = async (id: string, body: Record<string, unknown>) => {
    const response = await handleAgentApi(new Request(`http://localhost:3000/api/agent/session?id=${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), async () => '{"tasks":[]}');
    expect(response).not.toBeNull();
    return (await response!.json()) as any;
  };

  it("stores what the app sent at start and replaces it on a settings change", async () => {
    const data = await open({ projectPath: root, mode: "automatic", task: "Inspect", routing: { builder: { effort: "Thorough", model: "gemini-3.8-flash" } } });
    expect(data.ok).toBe(true);
    expect(data.routing).toEqual({ builder: { profile: "thorough", model: "gemini-3.8-flash" }, verifier: DEFAULT_WORKER_ROUTING.verifier, researcher: DEFAULT_WORKER_ROUTING.researcher });
    const updated = await patch(data.id, { routing: { researcher: { effort: "Thorough" }, builder: { effort: "Balanced", model: "gemini-3.8-flash" } } });
    expect(updated.routing).toEqual({ builder: { profile: "balanced", model: "gemini-3.8-flash" }, verifier: DEFAULT_WORKER_ROUTING.verifier, researcher: { profile: "thorough" } });
    // A patch that says nothing about routing leaves the table alone.
    expect((await patch(data.id, { mode: "ask" })).routing.researcher).toEqual({ profile: "thorough" });
  });
});

describe("the app's own routing all the way to the session", () => {
  it("posts the engines stored in Settings when it opens the session", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, id: "session-1", context: "", routing: DEFAULT_WORKER_ROUTING }));
    }));
    const client = new RuntimeClient("C:\\work\\demo", async () => undefined);
    const routing = { builder: { effort: "Thorough", model: "gemini-3.8-flash" } };
    await client.start("automatic", "Build the settings page", { securityPreset: "automatic" }, routing);
    expect(bodies[0]).toMatchObject({ projectPath: "C:\\work\\demo", mode: "automatic", routing });

    await client.update({ mode: "full", routing: { researcher: { effort: "Thorough" } } });
    expect(bodies[1]).toMatchObject({ mode: "full", routing: { researcher: { effort: "Thorough" } } });
  });
  it("tells the main agent that each role has an engine of its own", () => {
    expect(CALVRAS_SYSTEM_PROMPT).toMatch(/runs on the model and effort the user chose for it/i);
  });
});

describe("a pinned engine reaching the provider call", () => {
  const geminiReply = () => new Response('data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\ndata: [DONE]\n\n');

  it("tries the pinned model first and budgets the reply by the role's effort", async () => {
    const fetcher = vi.fn(async () => geminiReply());
    vi.stubGlobal("fetch", fetcher);
    const result = await inferStreaming({ messages: [{ role: "user", content: "hey" }], keys: { gemini: "pinned-role-model" }, model: "gemini-3.8-flash", profile: "thorough", maxTokens: PROFILE_MAX_TOKENS.thorough });
    expect(result.text).toBe("hello");
    expect(String((fetcher.mock.calls[0] as any)[0])).toContain("gemini-3.8-flash");
    expect(JSON.parse((fetcher.mock.calls[0] as any)[1].body).generationConfig.maxOutputTokens).toBe(16384);
  });

  it("keeps the effort's own chain behind the pinned model", async () => {
    const fetcher = vi.fn(async (url: string | URL) => String(url).includes("gemini-3.8-flash") ? new Response("gone", { status: 404 }) : geminiReply());
    vi.stubGlobal("fetch", fetcher);
    const result = await inferStreaming({ messages: [{ role: "user", content: "hey" }], keys: { gemini: "pinned-then-chain" }, model: "gemini-3.8-flash", profile: "quick", maxTokens: PROFILE_MAX_TOKENS.quick, hedgeMs: 5 });
    expect(result.text).toBe("hello");
    // A quick role falls through to the lite chain, never to a model that rejects MINIMAL thinking.
    expect(String((fetcher.mock.calls[fetcher.mock.calls.length - 1] as any)[0])).toMatch(/flash-lite/);
  });
});
