import { AgentSession, getSession, type Inference } from "./agent-runtime";
import { ACCESS_MODES, type AccessMode } from "../tool-catalog";
import { ApprovalNeeded, type EnforcementRules } from "./permissions";
import { sanitizePolicies } from "../policy-rules";
import { projectState, saveState } from "./project-state";
import { providerStatus, setProvider, testProvider } from "./providers";
import { paymentsCatalog, paymentsStatus, setPaymentsConfig } from "./payments";
import { usageStats } from "./usage-stats";
import { storeAttachments } from "./attachments";
import { appendJournal, readJournal } from "./journal";
import { addSchedule, claimDue, listSchedule, removeSchedule, reportRun, setScheduleEnabled } from "./schedule";
import { sanitizeRouting } from "./worker-pool";

/** Rules the browser Settings page owns; re-sanitized because they arrive over HTTP. */
function enforcement(raw: unknown): EnforcementRules {
  const policies = sanitizePolicies(raw);
  return { toolRules: policies.toolRules, networkRules: policies.networkRules, outsideSandboxCommands: policies.outsideSandboxCommands, browserRules: policies.browserRules, browserJs: policies.browserJs, planReview: policies.planReview };
}

export async function handleAgentApi(request: Request, infer: Inference): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/agent/")) return null;
  const origin = request.headers.get("origin");
  if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") return Response.json({ ok: false, error: "Cross-site workspace access is blocked." }, { status: 403 });
  try {
    if (url.pathname === "/api/agent/providers") {
      if (request.method === "GET") return Response.json({ ok: true, ...providerStatus() });
      if (request.method === "POST") { const body = await request.json(); return Response.json({ ok: true, ...setProvider(body.provider, body.key) }); }
    }
    if (url.pathname === "/api/agent/providers/test" && request.method === "POST") {
      const body = await request.json();
      return Response.json(await testProvider(String(body.provider || "")));
    }
    if (url.pathname === "/api/agent/usage" && request.method === "GET") return Response.json(usageStats());
    if (url.pathname === "/api/agent/payments") {
      if (request.method === "GET") return Response.json({ ok: true, ...paymentsStatus() });
      if (request.method === "POST") { const body = await request.json(); return Response.json({ ok: true, ...setPaymentsConfig(body || {}) }); }
    }
    if (url.pathname === "/api/agent/payments/catalog" && request.method === "GET") return Response.json(await paymentsCatalog());
    if (url.pathname === "/api/agent/attachments" && request.method === "POST") {
      const body = await request.json();
      const files = await storeAttachments(typeof body.projectPath === "string" ? body.projectPath : undefined, Array.isArray(body.files) ? body.files : []);
      return Response.json({ ok: true, files });
    }
    if (url.pathname === "/api/agent/journal") {
      const projectPath = request.method === "GET" ? url.searchParams.get("projectPath") || "" : "";
      if (request.method === "GET") {
        if (!projectPath) throw new Error("Select a project folder first.");
        return Response.json({ ok: true, content: await readJournal(projectPath) });
      }
      if (request.method === "POST") {
        const body = await request.json();
        if (!body.projectPath) throw new Error("Select a project folder first.");
        return Response.json(await appendJournal(String(body.projectPath), String(body.text || "")));
      }
    }
    if (url.pathname === "/api/agent/schedule") {
      // Schedules live in the project folder, so the browser names the folder it is asking about.
      const projectPath = request.method === "GET" ? url.searchParams.get("projectPath") || "" : "";
      if (request.method === "GET") {
        if (!projectPath) throw new Error("Select a project folder first.");
        return Response.json(await listSchedule(projectPath));
      }
      if (request.method === "POST") {
        const body = await request.json();
        const path = String(body.projectPath || "");
        if (!path) throw new Error("Select a project folder first.");
        if (body.action === "claim") return Response.json(await claimDue(path, Number(body.now ?? Date.now())));
        if (body.action === "report") return Response.json(await reportRun(path, String(body.id), String(body.status), String(body.note || "")));
        if (body.action === "enable") return Response.json(await setScheduleEnabled(path, String(body.id), body.enabled === true));
        if (body.action === "remove") return Response.json(await removeSchedule(path, String(body.id)));
        if (body.action === "add") return Response.json(await addSchedule(path, body));
        throw new Error("Choose add, claim, report, enable, remove or list.");
      }
    }
    if (url.pathname === "/api/agent/session") {
      if (request.method === "POST") {
        const body = await request.json();
        const mode = ACCESS_MODES.some((item) => item.value === body.mode) ? body.mode : "automatic";
        const session = new AgentSession(body.projectPath, mode, infer, enforcement(body.policies), body.routing);
        if (body.task) { const state = projectState(session.root); state.activeTask = String(body.task); state.unfinished = String(body.task); saveState(session.root); }
        return Response.json({ ok: true, ...session.status(), context: session.context() });
      }
      const id = url.searchParams.get("id") || request.headers.get("x-calvras-session") || "";
      const session = getSession(id);
      if (request.method === "GET") return Response.json({ ok: true, ...session.status() });
      if (request.method === "PATCH") {
        const body = await request.json();
        if (body.mode) { if (!ACCESS_MODES.some((mode) => mode.value === body.mode)) throw new Error("Unknown permission mode."); session.permission.mode = body.mode as AccessMode; }
        if (body.policies !== undefined) session.permission.rules = enforcement(body.policies);
        // A role's engine changed in Settings while a session is open: the next worker call takes
        // it, and a job already running keeps the route it was hired on.
        if (body.routing !== undefined) session.routing = sanitizeRouting(body.routing);
        if (body.finished) { const state = projectState(session.root); delete state.unfinished; saveState(session.root); }
        return Response.json({ ok: true, ...session.status() });
      }
      if (request.method === "DELETE") { session.stop(); return Response.json({ ok: true }); }
    }
    if (url.pathname === "/api/agent/answer" && request.method === "POST") {
      const body = await request.json();
      return Response.json(getSession(body.sessionId).answerQuestion(body.questionId, body.answer));
    }
    if (url.pathname === "/api/agent/approve" && request.method === "POST") {
      const body = await request.json();
      if (!["once", "task", "deny"].includes(body.choice)) throw new Error("Choose allow once, allow for this task, or deny.");
      return Response.json({ ok: true, ...getSession(body.sessionId).decide(body.approvalId, body.choice) });
    }
    if (url.pathname === "/api/agent/tools" && request.method === "POST") {
      const body = await request.json(); const session = getSession(body.sessionId);
      const controller = new AbortController(); const signal = AbortSignal.any([request.signal, controller.signal]);
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        async start(stream) {
          let closed = false;
          const send = (event: unknown) => {
            if (closed || signal.aborted) return;
            try { stream.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); }
            catch { closed = true; }
          };
          try {
            const result = await session.execute(body.action, { signal, approvalToken: body.approvalToken, userInitiated: body.userInitiated === true, onOutput: (output) => send({ output }) });
            send({ result });
          } catch (error) {
            if (error instanceof ApprovalNeeded) send({ approval: error.approval });
            else send({ result: { ok: false, error: error instanceof Error ? error.message : "Action failed." } });
          } finally {
            closed = true;
            if (!signal.aborted) { try { stream.close(); } catch { /* client already disconnected */ } }
          }
        }, cancel() { controller.abort(); },
      }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
    }
    return Response.json({ ok: false, error: "Unknown agent endpoint." }, { status: 404 });
  } catch (error) { return Response.json({ ok: false, error: error instanceof Error ? error.message : "Agent request failed." }, { status: 400 }); }
}
