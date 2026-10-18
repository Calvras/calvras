import { readSSE } from "./streaming";
import type { AccessMode, ToolAction } from "./tool-catalog";
export class RuntimeClient {
  id = "";
  context = "";
  constructor(public root: string, private ask: (request: any, sessionId: string, signal?: AbortSignal) => Promise<string | undefined>) {}
  async start(mode: AccessMode, task: string, policies?: unknown, routing?: unknown) {
    const response = await fetch("/api/agent/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectPath: this.root, mode, task, ...(policies ? { policies } : {}), ...(routing ? { routing } : {}) }) });
    const data = await response.json(); if (!data.ok) throw new Error(data.error || "Could not open workspace session.");
    this.id = data.id; this.context = data.context; return data;
  }
  async status() { const response = await fetch(`/api/agent/session?id=${encodeURIComponent(this.id)}`); const data = await response.json(); if (!data.ok) throw new Error(data.error); return data; }
  async update(body: unknown) { return fetch(`/api/agent/session?id=${encodeURIComponent(this.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  async stop() { if (this.id) await fetch(`/api/agent/session?id=${encodeURIComponent(this.id)}`, { method: "DELETE" }); }
  async preserveWorkersFor(root: string | null) {
    if (root === this.root) {
      try {
        const state = await this.status();
        if (state.agents?.some((agent: any) => agent.active || agent.queued > 0)) return true;
      } catch { /* Replace an unavailable session instead of reusing it. */ }
    }
    await this.stop();
    return false;
  }
  async execute(action: ToolAction, signal?: AbortSignal, onOutput?: (text: string) => void, options?: { userInitiated?: boolean }) {
    let approvalToken: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const response = await fetch("/api/agent/tools", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: this.id, action, approvalToken, ...(options?.userInitiated ? { userInitiated: true } : {}) }), ...(signal ? { signal } : {}) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || "Tool request failed."); }
      let result: any; let approval: any;
      await readSSE(response, (event) => { if (event.output) onOutput?.(event.output); if (event.result) result = event.result; if (event.approval) approval = event.approval; }, signal);
      if (approval) {
        approvalToken = await this.ask({ ...approval, kind: "approval" }, this.id, signal);
        if (!approvalToken) return { ok: false, denied: true, error: "The user denied this action. Do not retry it." };
        continue;
      }
      if (!result) throw new Error("The tool ended without returning a result.");
      if (result.needsInput) { const answer = await this.ask({ id: crypto.randomUUID(), kind: "question", question: result.question, choices: action.options }, this.id, signal); return { ok: true, answer }; }
      return result;
    }
    throw new Error("The approval could not be applied. Please retry the action.");
  }
}
