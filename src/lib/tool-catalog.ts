export type AccessMode = "ask" | "automatic" | "full";
export type ToolRisk = "read" | "edit" | "execute" | "destructive" | "external" | "agent";
const groups = {
  read: ["semantic_search", "search_knowledge", "read_module", "read_file", "read_image", "list_files", "list_dir", "get_file_info", "directory_tree", "grep_search", "search_files", "find_files", "search_symbols", "go_to_definition", "find_references", "get_hover_info", "list_symbols", "read_diagnostics", "get_terminal_output", "get_errors", "get_stack_trace", "git_status", "git_diff", "git_show_diff", "git_log", "git_branch", "analyze_project", "detect_framework", "read_project_structure", "read_package_json", "find_entry_point", "map_dependencies", "analyze_codebase", "trace_function_calls", "track_progress", "summarize_changes", "explain_code", "inspect_dependencies", "read_memory", "read_task", "list_checkpoints", "check_server", "check_preview", "compare_to_reference", "check_console_errors", "inspect_element", "list_agents", "read_agent", "list_mcp_tools", "list_windows", "read_page", "wait_for_element", "queue_batch", "next_batch", "report_batch", "batch_status", "worker_changes", "list_scheduled"],
  edit: ["write_file", "create_file", "rename_file", "move_file", "copy_file", "search_replace", "multi_replace", "insert_code", "delete_lines", "undo_edit", "apply_patch", "apply_diff", "format_file", "format_code", "organize_imports", "multi_file_edit", "refactor_code", "generate_tests", "resolve_imports", "generate_documentation", "write_memory", "create_checkpoint", "use_user_file", "resolve_worker"],
  execute: ["run_command", "run_terminal", "run_code", "install_dependencies", "install_deps", "start_dev_server", "start_server", "stop_dev_server", "run_background_process", "run_tests", "run_single_test", "run_linter", "run_lint", "run_typecheck", "run_build", "debug_code", "verify_changes", "detect_security_issues", "git_add", "git_commit", "manage_environment_variables"],
  destructive: ["delete_file", "git_checkout", "git_restore", "rollback_changes"],
  external: ["git_push", "git_clone", "open_browser", "navigate_browser", "take_screenshot", "click_element", "fill_input", "test_responsive_layout", "search_documentation", "github_request", "deploy_application", "configure_mcp", "call_mcp_tool", "web_search", "take_screen_screenshot", "move_mouse", "click_mouse", "type_text", "press_keys", "open_app", "wait_for_window", "focus_window", "scroll_page", "press_page_key", "go_back", "upload_file_to_page", "probe_key", "run_page_script", "click_at", "hover_at", "drag_at", "type_into_page"],
  agent: ["plan_tasks", "create_task_list", "delegate_task", "ask_subagent", "request_user_approval", "ask_user", "cancel_agent", "schedule_run", "cancel_scheduled", "build_knowledge"],
} as const;
export type ToolName = (typeof groups)[keyof typeof groups][number];
export const TOOL_NAMES = Object.values(groups).flat() as ToolName[];
export const TOOL_RISK = Object.fromEntries(Object.entries(groups).flatMap(([risk, names]) => names.map((name) => [name, risk]))) as Record<ToolName, ToolRisk>;
export type ToolAction = {
  type: ToolName; path?: string; command?: string; content?: string;
  from?: string; to?: string; search?: string; replace?: string; regex?: boolean;
  pattern?: string; glob?: string; staged?: boolean; message?: string; branch?: string; url?: string; dest?: string;
  task?: string; prompt?: string; question?: string; options?: string[]; key?: string; value?: any; tasks?: any[];
  id?: string; jobId?: string; waitMs?: number; role?: string; check?: string; instructions?: string; outputPath?: string;
  operation?: string; endpoint?: string; method?: string; body?: any; name?: string; config?: any; tool?: string; arguments?: any;
  [key: string]: any;
};
export const ACCESS_MODES: { value: AccessMode; label: string; description: string }[] = [
  { value: "ask", label: "Ask first", description: "Confirm edits, commands, and outside access." },
  { value: "automatic", label: "Work automatically", description: "Handle routine workspace work; ask about risky actions." },
  { value: "full", label: "Full access", description: "Commands, installs, builds and servers run without a prompt. Creating, editing or deleting files still asks you first." },
];
export function toolQuestion(action: ToolAction): string {
  const target = action.path || action.command || action.url || action.task || action.prompt;
  if (action.type === "request_user_approval" || action.type === "ask_user") return String(action.question || action.message || "May I continue?");
  if (action.type === "configure_mcp") return `Can I connect ${action.name || "this MCP server"} using ${String(action.config?.command || action.config?.url || "the supplied configuration").slice(0, 180)}?`;
  if (action.type === "github_request") return `Can I ${action.method || "GET"} GitHub ${action.endpoint || "this endpoint"}?`;
  if (action.type === "manage_environment_variables") return `Can I ${action.operation || "set"} environment variable ${action.key || "names"} in .env.local? Values stay hidden.`;
  if (action.type === "run_code") return `Can I run this ${action["language"] || "JavaScript"} code: ${String(action["code"] || action.content || "").slice(0, 130)}?`;
  if (/^(run_|start_|install_|deploy_)/.test(action.type)) return `Can I ${action.type.replaceAll("_", " ")}${target ? `: ${String(target).slice(0, 180)}` : ""}?`;
  return `Can I ${action.type.replaceAll("_", " ")}${target ? ` — ${String(target).slice(0, 180)}` : ""}?`;
}
/** Near-miss names the model reaches for instead of the catalogued tool. Aliasing keeps the
 * call real rather than failing it; nothing here invents a tool that has no implementation. */
const TOOL_ALIASES: Record<string, string> = { read_page_content: "read_page", get_console_errors: "check_console_errors", screenshot: "take_screenshot" };
export function validateToolAction(value: Record<string, any>): ToolAction {
  const requested = value["type"] || value["action"];
  const type = TOOL_ALIASES[requested] || requested;
  if (!TOOL_NAMES.includes(type)) throw new Error(`Unsupported action: ${String(requested)}. Available tools are listed in the catalog; do not invent a name.`);
  const require = (field: string, label = field) => { if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`Missing ${label}.`); };
  if (["read_file", "read_image", "write_file", "create_file", "delete_file", "get_file_info", "search_replace", "insert_code", "delete_lines", "format_file", "git_add", "git_restore"].includes(type)) require("path", "file path");
  if (["run_command", "run_terminal", "start_server", "start_dev_server", "run_background_process"].includes(type)) require("command", "command");
  if (["write_file", "create_file"].includes(type) && typeof value["content"] !== "string") throw new Error("Missing file contents.");
  if (["rename_file", "move_file", "copy_file"].includes(type)) { require("from"); require("to"); }
  if (["search_files", "grep_search", "find_files"].includes(type)) require("pattern");
  if (type === "search_replace") { require("search"); if (typeof value["replace"] !== "string") throw new Error("Missing replace."); }
  if (type === "type_text" && typeof value["text"] !== "string") throw new Error("Missing text to type.");
  if (type === "press_keys" && typeof value["keys"] !== "string") throw new Error("Missing keys to press.");
  if (type === "move_mouse" && (value["x"] === undefined || value["y"] === undefined)) throw new Error("Move mouse needs x and y.");
  if (type === "open_app" && !value["app"] && !value["url"]) throw new Error("Provide an app name or a URL.");
  if (type === "focus_window" && !value["title"]) throw new Error("Provide part of the window title.");
  if (type === "wait_for_window" && !value["title"]) throw new Error("Provide part of the window title.");
  if (type === "run_page_script") require("code", "JavaScript to run in the page");
  if (type === "web_search") require("query");
  if (type === "probe_key") require("url", "URL");
  if (type === "queue_batch" && !(Array.isArray(value["targets"]) && value["targets"].length)) throw new Error("queue_batch needs targets: [{ url, label }].");
  if (type === "report_batch") { require("id", "batch target id"); if (!["queued", "running", "done", "blocked", "skipped"].includes(String(value["status"]))) throw new Error("A batch target ends as done, blocked, or skipped."); }
  if (["open_browser", "navigate_browser"].includes(type)) require("url", "URL");
  if (["click_element", "fill_input", "inspect_element", "wait_for_element", "upload_file_to_page"].includes(type)) require("selector", "CSS selector");
  if (["click_at", "hover_at"].includes(type) && (value["x"] === undefined || value["y"] === undefined)) throw new Error(`${type} needs the x and y of a numbered spot from take_screenshot.`);
  if (type === "drag_at" && [value["fromX"], value["fromY"], value["toX"], value["toY"]].some((n) => n === undefined)) throw new Error("drag_at needs fromX, fromY, toX and toY from the numbered screenshot.");
  if (type === "type_into_page" && typeof value["text"] !== "string") throw new Error("Missing text to type.");
  if (type === "fill_input" && typeof (value["value"] ?? value["text"]) !== "string") throw new Error("Missing text to fill in.");
  if (type === "press_page_key" && typeof value["keys"] !== "string") throw new Error("Missing keys to press.");
  if (type === "upload_file_to_page") require("path", "file path");
  if (type === "use_user_file") require("path", "file path");
  if (["worker_changes", "resolve_worker"].includes(type)) require("id", "subagent task id");
  if (value["effort"] !== undefined && !["quick", "balanced", "thorough"].includes(String(value["effort"]).trim().toLowerCase())) throw new Error("A subagent runs at quick, balanced or thorough effort.");
  if (value["model"] !== undefined && typeof value["model"] !== "string") throw new Error("Name the model as a single word, or leave it out and use the role's routing.");
  if (type === "resolve_worker" && !["apply", "discard"].includes(String(value["action"]))) throw new Error("Bring an isolated subagent's work back, or discard it.");
  if (type === "schedule_run") {
    require("prompt", "what the run should do");
    if (!["at", "every", "daily"].includes(String(value["kind"]))) throw new Error("Schedule a run as at, every, or daily.");
    if (value["kind"] === "at" && !value["at"]) throw new Error("A one-off run needs a date and time.");
    if (value["kind"] === "every" && !(Number(value["everyMinutes"]) >= 1)) throw new Error("A repeating run needs everyMinutes of at least 1.");
    if (value["kind"] === "daily" && !/^(\d{1,2}):(\d{2})$/.test(String(value["timeOfDay"] || ""))) throw new Error("A daily run needs timeOfDay like 09:30.");
  }
  if (type === "cancel_scheduled") require("id", "scheduled run id");
  if (type === "search_knowledge") require("query", "what to look for in the module cards");
  if (type === "build_knowledge" && value["depth"] !== undefined && !(Number(value["depth"]) >= 1 && Number(value["depth"]) <= 6)) throw new Error("Module grouping depth is a number from 1 to 6, or leave it out.");
  if (type === "git_commit") require("message");
  if (type === "git_checkout") require("branch");
  if (type === "git_clone") require("url");
  return { ...value, type };
}
