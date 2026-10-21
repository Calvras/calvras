import type { AgentAction, ToolFeedback } from "./agent-run";

const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, Math.floor(max * 0.65))}\n[truncated; re-read relevant file or rerun a targeted command for full detail]\n${text.slice(-Math.floor(max * 0.35))}`;
export function feedbackContext(results: ToolFeedback[], detailed = true) {
  return results.map(({ action, ok, result }) => {
    const data = result as Record<string, unknown> | null;
    const identity = { type: action.type, path: action.path, command: action.command };
    const evidence = detailed ? data && typeof data === "object" ? { ...data, ...(data["image"] ? { image: "[Screenshot attached separately]" } : {}), ...(Array.isArray(data["layouts"]) ? { layouts: (data["layouts"] as any[]).map(({ image, ...layout }) => layout) } : {}) } : result : { error: data?.["error"], exitCode: data?.["exitCode"], ready: data?.["ready"], url: data?.["url"], output: typeof data?.["output"] === "string" ? clip(data["output"], 500) : undefined };
    // Keep the evidence readable. Stringifying it inside another JSON string
    // repeatedly escaped code, paths and JSON files before the model saw them.
    return `${JSON.stringify({ action: identity, ok })}\n${clip(JSON.stringify(evidence) ?? "null", detailed ? ok ? 8000 : 5000 : 1000)}`;
  }).join("\n");
}

const independent = new Set(["read_file", "list_dir", "get_file_info", "search_files", "find_files", "git_status", "git_diff", "git_log"]);
/** Fill order has no risk of landing on the wrong control, so a form runs as one parallel pass
 * instead of one action per model round — the eight-action browser chain costs milliseconds, not
 * eight thinks. Clicks, uploads and scripts stay barriers because their order changes the page. */
const pageFills = new Set(["fill_input"]);
/** Only contiguous reads overlap. Every mutation is a barrier. Results stay ordered. */
export async function executeInOrder(actions: AgentAction[], execute: (action: AgentAction) => Promise<ToolFeedback>, signal: AbortSignal) {
  const results: ToolFeedback[] = [];
  for (let i = 0; i < actions.length;) {
    signal.throwIfAborted();
    const batch = [actions[i++]!];
    const splittable = independent.has(batch[0]!.type) || pageFills.has(batch[0]!.type);
    if (splittable) while (i < actions.length && batch.length < 8 && (independent.has(actions[i]!.type) || pageFills.has(actions[i]!.type))) batch.push(actions[i++]!);
    results.push(...await Promise.all(batch.map(execute)));
  }
  return results;
}
