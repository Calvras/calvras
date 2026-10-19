import { handleAgentApi } from "./lib/runtime/api";
import { importFolder, importFolderFromPath } from "./lib/folder-import";
import { runManualTerminal } from "./lib/manual-terminal";
import "./lib/error-capture";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

/* ─────────────────────────────────────────────────────────────────────────────
 * CALVRAS — ZERO-DOWNTIME MULTI-ENGINE INFERENCE CASCADE & FILESYSTEM API
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { providerKeys } from "./lib/runtime/providers";
const getHFKey = () => providerKeys().hf;
const getGeminiKey = () => providerKeys().gemini;
const getOpenRouterKey = () => providerKeys().openrouter;

// ── Calvras System Prompt ────────────────────────────────────────────────────

export { CALVRAS_SYSTEM_PROMPT } from "./lib/system-prompt";
import { CALVRAS_SYSTEM_PROMPT } from "./lib/system-prompt";

/**
 * Only the desktop runtime serves this machine's files, terminal, and store credential, and it must
 * refuse a request that arrived over the public domain. A client can drop the Origin header to look
 * same-site, but it cannot change the host it knocked on.
 */
export function isLocalRuntime(url: URL) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\./.test(host);
}

import { updateManifest } from "./lib/release";
import { handleSiteApi, type SiteEnv } from "./lib/site-api";
import { inferStreaming, PROFILE_MAX_TOKENS } from "./lib/inference";

// One inference request, real upstream streaming, bounded provider fallbacks.
async function handleChatCompletions(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") return Response.json({ error: { message: "Cross-site model access is blocked." } }, { status: 403 });
  const cors = { "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return Response.json({ error: { message: "Method Not Allowed" } }, { status: 405, headers: cors });
  const body = await request.json().catch(() => ({}));
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  if (!messages.some((m: any) => m.role === "system")) messages.unshift({ role: "system", content: CALVRAS_SYSTEM_PROMPT });
  const options = { messages, keys: { openrouter: body.keys?.openrouter || getOpenRouterKey(), gemini: body.keys?.gemini || getGeminiKey(), hf: getHFKey() }, maxTokens: Math.min(body.max_tokens || 8192, 16384), temperature: body.temperature ?? 0.2, ...(body.model ? { model: body.model } : {}), ...(["quick", "balanced", "thorough"].includes(body.profile) ? { profile: body.profile } : {}) };
  const cancelled = new AbortController();
  const signal = AbortSignal.any([request.signal, cancelled.signal]);
  if (body.stream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: unknown) => { if (!signal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); };
        try {
          const result = await inferStreaming({ ...options, signal, onDelta: (content, model) => send({ model, choices: [{ delta: { content }, finish_reason: null }] }) });
          send({ model: result.model, choices: [{ delta: {}, finish_reason: result.truncated ? "length" : "stop" }] });
          if (!signal.aborted) { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); }
        } catch (error) {
          if (!signal.aborted) { send({ error: { message: error instanceof Error ? error.message : "Inference failed." } }); controller.close(); }
        }
      },
      cancel() { cancelled.abort(); },
    });
    return new Response(stream, { headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
  }
  try {
    const result = await inferStreaming({ ...options, signal });
    return Response.json({ model: result.model, choices: [{ message: { role: "assistant", content: result.text }, finish_reason: "stop" }] }, { headers: cors });
  } catch (error) {
    return Response.json({ error: { message: error instanceof Error ? error.message : "Inference failed." } }, { status: 503, headers: cors });
  }
}
// All agent filesystem, terminal, Git, browser, and worker operations use scoped sessions.
async function handleApi(request: Request, env: SiteEnv): Promise<Response | null> {
  const url = new URL(request.url);
  // The account ledger is the one API that is meant to answer the public domain: it reads a D1
  // database attached to the deployment, never this machine. So it is tried before the loopback gate.
  const site = await handleSiteApi(request, env);
  if (site) return site;
  // The desktop workspace, terminal, and payment-store routes exist for the app on this computer.
  // Off the loopback they answer nothing at all, not even which of them exist.
  if (!isLocalRuntime(url) && (url.pathname.startsWith("/api/agent") || url.pathname.startsWith("/api/fs") || url.pathname.startsWith("/api/terminal"))) {
    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  const agent = await handleAgentApi(request, async (prompt, onDelta, system, route) => {
    let accumulated = "";
    // A subagent role brings its own engine and effort: the profile picks the chain, the timeout
    // and the reply budget, and a pinned model is tried before any of them.
    const result = await inferStreaming({ messages: [{ role: "system", content: system || CALVRAS_SYSTEM_PROMPT }, { role: "user", content: prompt }], keys: { openrouter: getOpenRouterKey(), gemini: getGeminiKey(), hf: getHFKey() }, onDelta: (delta) => { accumulated += delta; onDelta?.(accumulated); }, ...(route?.profile ? { profile: route.profile, maxTokens: PROFILE_MAX_TOKENS[route.profile] } : {}), ...(route?.model ? { model: route.model } : {}) });
    return result.text;
  });
  if (agent) return agent;
  if (["/api/v1/chat/completions", "/api/chat/completions", "/v1/chat/completions"].includes(url.pathname)) return handleChatCompletions(request);
  // The published version feed. Every installed Calvras reads it to decide whether to offer an
  // update, so it is public on purpose: a version number and a download URL, never a key or a path.
  if (url.pathname === "/update.json") {
    if (request.method !== "GET" && request.method !== "HEAD") return Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 });
    return new Response(request.method === "HEAD" ? null : JSON.stringify(updateManifest()), { headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" } });
  }
  if (url.pathname.startsWith("/api/")) {
    const origin = request.headers.get("origin");
    if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") return Response.json({ ok: false, error: "Cross-site workspace access is blocked." }, { status: 403 });
    if (url.pathname === "/api/fs/import" && request.method === "POST") return importFolder(request);
    if (url.pathname === "/api/fs/import-path" && request.method === "POST") return importFolderFromPath(request);
    if (url.pathname === "/api/terminal/exec" && request.method === "POST") return runManualTerminal(request);
    if (url.pathname === "/api/fs/create-project" && request.method === "POST") {
      const body = await request.json();
      const name = String(body.name || "calvras-project").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 50) || "calvras-project";
      const desktop = path.join(os.homedir(), "Desktop"); fs.mkdirSync(desktop, { recursive: true });
      let projectPath = path.join(desktop, name);
      for (let suffix = 1; fs.existsSync(projectPath); suffix++) projectPath = path.join(desktop, `${name}-${suffix}`);
      fs.mkdirSync(projectPath);
      return Response.json({ ok: true, name: path.basename(projectPath), projectPath });
    }
    return Response.json({ ok: false, error: "Use /api/agent/tools with a workspace session." }, { status: 403 });
  }
  return null;
}

// ── SSR Entry ─────────────────────────────────────────────────────────────────

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry
    );
  }
  return serverEntryPromise;
}

async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const apiResponse = await handleApi(request, (env || {}) as SiteEnv);
      if (apiResponse) return apiResponse;

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
