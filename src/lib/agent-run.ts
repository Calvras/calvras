export type AgentAction = {
  type: "create_file" | "write_file" | "edit_file" | "read_file" | "list_dir" | "run_command";
  path?: string;
  command?: string;
  content?: string;
  newContent?: string;
  lineStart?: number;
  lineEnd?: number;
};
export type AgentReply = { actions: AgentAction[]; message: string; status?: "continue" | "complete" | "blocked"; plan?: string };
const actionTypes = new Set(["create_file", "write_file", "edit_file", "read_file", "list_dir", "run_command"]);

export function parseAgentReply(raw: string): AgentReply {
  const json = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const value = JSON.parse(json);
  if (!value || typeof value !== "object" || !Array.isArray(value.actions) || typeof value.message !== "string") throw new Error("The agent returned an invalid response.");
  const actions = value.actions.map((action: Record<string, unknown>) => {
    if (!action || typeof action !== "object") throw new Error("Invalid action.");
    const type = action['type'] || action['action'];
    if (typeof type !== "string" || !actionTypes.has(type)) throw new Error(`Unsupported action: ${String(type)}`);
    if (type === "run_command" && (typeof action['command'] !== "string" || !action['command'].trim())) throw new Error("Missing command.");
    if (type !== "run_command" && type !== "list_dir" && (typeof action['path'] !== "string" || !action['path'].trim())) throw new Error("Missing file path.");
    if ((type === "create_file" || type === "write_file") && typeof action['content'] !== "string") throw new Error("Missing file contents.");
    if (type === "edit_file" && (typeof action['newContent'] !== "string" || !Number.isInteger(action['lineStart']) || !Number.isInteger(action['lineEnd']))) throw new Error("Invalid edit range.");
    return { ...action, type } as AgentAction;
  });
  return { actions, message: value.message, ...(typeof value.plan === "string" ? { plan: value.plan } : {}), ...(["continue", "complete", "blocked"].includes(value.status) ? { status: value.status } : {}) };
}

export type ToolFeedback = { action: AgentAction; ok: boolean; result: unknown };
export type AgentOutcome = { status: "finished" | "blocked" | "stopped" | "limit"; message: string; plan?: string };

export async function runAgent(options: {
  prompt: string;
  signal: AbortSignal;
  infer: (prompt: string) => Promise<string>;
  execute: (actions: AgentAction[]) => Promise<ToolFeedback[]>;
  onFeedback: (message: string) => void;
  maxSteps?: number;
  requiresTools?: boolean;
}): Promise<AgentOutcome> {
  const history: string[] = [];
  let invalidReplies = 0;
  const failedCommands = new Set<string>();
  let unresolvedFailures = false;
  let executedActions = 0;
  try {
    for (let step = 0; step < (options.maxSteps ?? 24); step++) {
      options.signal.throwIfAborted();
      const raw = await options.infer(`${options.prompt}\n\n${history.join("\n\n")}`);
      options.signal.throwIfAborted();
      let reply: AgentReply;
      try { reply = parseAgentReply(raw); }
      catch (error) {
        if (++invalidReplies >= 2) throw error;
        history.push("[RESPONSE FORMAT ERROR] Return valid JSON with message, actions, and status. Do not include thought or reasoning. Use actual supported actions to perform the request.");
        continue;
      }
      invalidReplies = 0;
      if (!reply.actions.length) {
        if (reply.status === "blocked") return { status: "blocked", message: reply.message || "The agent needs more information to continue." };
        if (reply.status !== "complete" || unresolvedFailures || (options.requiresTools && !executedActions)) {
          history.push(`[AGENT UPDATE]\n${reply.message}\n[CONTINUE] No actions were executed in this step. ${unresolvedFailures ? "Previous tools failed. Retry, recover, or return status blocked and explain the unresolved failure." : "Return actual actions for unfinished work. For a fully answered question or verified finished task, return status complete and the final answer. If you cannot act, return status blocked with the reason."}`);
          continue;
        }
        return { status: "finished", message: reply.message, ...(reply.plan ? { plan: reply.plan } : {}) };
      }
      if (reply.message.trim()) options.onFeedback(reply.message);
      const results = await options.execute(reply.actions);
      executedActions += results.length;
      options.signal.throwIfAborted();
      for (const result of results) {
        if (result.action.type === "run_command" && result.action.command) {
          if (result.ok) failedCommands.delete(result.action.command);
          else failedCommands.add(result.action.command);
        }
      }
      unresolvedFailures = results.some((result) => !result.ok) || failedCommands.size > 0;
      history.push(`[AGENT UPDATE]\n${reply.message}\n[ACTUAL TOOL RESULTS]\n${JSON.stringify(results)}\nUse these results to decide the next action. Verify changes. Do not claim an action succeeded unless its result confirms success. Keep working or explain a blocker.`);
    }
    return { status: "limit", message: "This run reached its action limit before the task was verified. Send Continue to resume from the recorded results." };
  } catch (error) {
    if (options.signal.aborted) return { status: "stopped", message: "Stopped. Any actions already executed are shown above." };
    return { status: "blocked", message: error instanceof Error ? error.message : "The agent could not continue." };
  }
}
