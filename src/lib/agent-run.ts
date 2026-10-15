export type AgentAction = {
  type:
    | "create_file"
    | "write_file"
    | "read_file"
    | "list_dir"
    | "run_command"
    // File operations
    | "rename_file"
    | "delete_file"
    | "copy_file"
    | "get_file_info"
    // Search & navigation
    | "search_files"
    | "find_files"
    // Code editing
    | "search_replace"
    // Git operations
    | "git_status"
    | "git_diff"
    | "git_log"
    | "git_add"
    | "git_commit"
    | "git_checkout"
    | "git_branch"
    | "git_restore"
    | "git_push"
    | "git_clone"
    // Build & run
    | "run_build"
    | "run_tests"
    | "run_lint"
    | "run_typecheck"
    | "install_deps";
  path?: string;
  command?: string;
  content?: string;
  // Rename / copy / move
  from?: string;
  to?: string;
  // Search & replace
  search?: string;
  replace?: string;
  regex?: boolean;
  // Search / find files
  pattern?: string;
  glob?: string;
  // Git
  staged?: boolean;
  message?: string;
  branch?: string;
  remote?: string;
  // Clone
  url?: string;
  dest?: string;
};
export type AgentReply = { actions: AgentAction[]; message: string; status?: "continue" | "complete" | "blocked"; plan?: string };
const actionTypes = new Set([
  "create_file", "write_file", "read_file", "list_dir", "run_command",
  "rename_file", "delete_file", "copy_file", "get_file_info",
  "search_files", "find_files",
  "search_replace",
  "git_status", "git_diff", "git_log", "git_add", "git_commit",
  "git_checkout", "git_branch", "git_restore", "git_push", "git_clone",
  "run_build", "run_tests", "run_lint", "run_typecheck", "install_deps",
]);

function extractJson(raw: string): string {
  const start = raw.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') { depth--; if (depth === 0) return raw.slice(start, i + 1); }
  }
  throw new Error('Unterminated JSON object in response');
}

export function parseAgentReply(raw: string): AgentReply {
  const json = extractJson(raw.trim());
  const value = JSON.parse(json);
  if (!value || typeof value !== "object" || !Array.isArray(value.actions) || typeof value.message !== "string") throw new Error("The agent returned an invalid response.");
  const actions = value.actions.map((action: Record<string, unknown>) => {
    if (!action || typeof action !== "object") throw new Error("Invalid action.");
    const type = action['type'] || action['action'];
    if (typeof type !== "string" || !actionTypes.has(type)) throw new Error(`Unsupported action: ${String(type)}`);
    if (type === "run_command" && (typeof action['command'] !== "string" || !action['command'].trim())) throw new Error("Missing command.");
    if (type !== "run_command" && type !== "list_dir" && (typeof action['path'] !== "string" || !action['path'].trim())) {
      // Actions that use from/to instead of path
      const fromToTypes = new Set(["rename_file", "copy_file"]);
      // Actions that use pattern instead of path
      const patternTypes = new Set(["search_files", "find_files"]);
      // Actions with no required path
      const noPathTypes = new Set(["git_status", "git_diff", "git_log", "git_branch", "git_push", "run_build", "run_tests", "run_lint", "run_typecheck", "install_deps", "git_commit", "git_checkout", "git_clone"]);
      if (!fromToTypes.has(type) && !patternTypes.has(type) && !noPathTypes.has(type)) {
        throw new Error("Missing file path.");
      }
    }
    if ((type === "create_file" || type === "write_file") && typeof action['content'] !== "string") throw new Error("Missing file contents.");
    // edit_file: be lenient — only reject if newContent is missing entirely
    if (type === "edit_file" && typeof action['newContent'] !== "string") throw new Error("Missing newContent for edit_file.");
    // rename_file / copy_file require from and to
    if ((type === "rename_file" || type === "copy_file") && (typeof action['from'] !== "string" || !action['from'].trim())) throw new Error(`Missing 'from' field for ${type}.`);
    if ((type === "rename_file" || type === "copy_file") && (typeof action['to'] !== "string" || !action['to'].trim())) throw new Error(`Missing 'to' field for ${type}.`);
    // search_replace requires path + search + replace
    if (type === "search_replace" && (typeof action['search'] !== "string" || !action['search'])) throw new Error("Missing 'search' field for search_replace.");
    if (type === "search_replace" && typeof action['replace'] !== "string") throw new Error("Missing 'replace' field for search_replace.");
    // search_files and find_files require pattern
    if ((type === "search_files" || type === "find_files") && (typeof action['pattern'] !== "string" || !action['pattern'].trim())) throw new Error(`Missing 'pattern' field for ${type}.`);
    // git_add and git_restore require path
    if ((type === "git_add" || type === "git_restore") && (typeof action['path'] !== "string" || !action['path'].trim())) throw new Error(`Missing 'path' field for ${type}.`);
    // git_commit requires message
    if (type === "git_commit" && (typeof action['message'] !== "string" || !action['message'].trim())) throw new Error("Missing 'message' field for git_commit.");
    // git_checkout requires branch
    if (type === "git_checkout" && (typeof action['branch'] !== "string" || !action['branch'].trim())) throw new Error("Missing 'branch' field for git_checkout.");
    // git_clone requires url
    if (type === "git_clone" && (typeof action['url'] !== "string" || !action['url'].trim())) throw new Error("Missing 'url' field for git_clone.");
    return { ...action, type } as AgentAction;
  });
  return { actions, message: value.message, ...(typeof value.plan === "string" ? { plan: value.plan } : {}), ...(["continue", "complete", "blocked"].includes(value.status) ? { status: value.status } : {}) };
}

export type ToolFeedback = { action: AgentAction; ok: boolean; result: unknown };
export type AgentOutcome = { status: "finished" | "blocked" | "stopped" | "limit"; message?: string; error?: string; plan?: string };

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
    for (let step = 0; step < (options.maxSteps ?? 16); step++) {
      options.signal.throwIfAborted();
      if (step > 0) options.onFeedback('');
      const raw = await options.infer(`${options.prompt}\n\n${history.join("\n\n")}`);
      options.signal.throwIfAborted();
      let reply: AgentReply;
      try { reply = parseAgentReply(raw); }
      catch (error) {
        if (++invalidReplies >= 2) throw error;
        history.push("[RESPONSE FORMAT ERROR] Return valid JSON with message, actions, and status fields. No markdown, no text outside the JSON object.");
        continue;
      }
      invalidReplies = 0;
      if (!reply.actions.length) {
        if (reply.status === "blocked") return { status: "blocked", message: reply.message };
        if (reply.status !== "complete" || unresolvedFailures || (options.requiresTools && !executedActions)) {
          history.push(`[AGENT UPDATE]\n${reply.message}\n[CONTINUE] No actions were executed. ${unresolvedFailures ? "Previous tools failed — retry, recover, or return status blocked." : "Return actions for unfinished work. For a fully answered question, return status complete."}`);
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
      // Surface edit_file failures clearly so the AI knows to read first
      const editFailures = results.filter(r => r.action.type === "edit_file" && !r.ok);
      const editHint = editFailures.length > 0
        ? "\n[EDIT HINT] edit_file failed. You must read_file first to get the exact line numbers before calling edit_file. Never guess line numbers."
        : "";
      unresolvedFailures = results.some((result) => !result.ok) || failedCommands.size > 0;
      history.push(`[AGENT UPDATE]\n${reply.message}\n[ACTUAL TOOL RESULTS]\n${JSON.stringify(results)}${editHint}\nUse these results for the next action. Verify changes. Do not claim success unless the result confirms it.`);
    }
    return { status: "limit" };
  } catch (error) {
    if (options.signal.aborted) return { status: "stopped" };
    return { status: "blocked", error: error instanceof Error ? error.message : String(error) };
  }
}
