import type { AgentAction } from "./agent-run";
import { TOOL_NAMES } from "./tool-catalog";

const TASK_VERB = /\b(?:check|inspect|read|edit|fix|build|create|implement|run|start|launch|boot|serve|deploy|search|update|test|remove|delete|add|change|replace|rename|move|refactor|redesign|restyle|style|improve|make|write|adjust|increase|decrease|tweak|clean|install|configure|integrate|apply|convert|migrate|hide|show|swap|reorder|align|resize|open|close|set\s+up|setup|help\s+me)\b/i;
const WORK_VERB = /\b(?:edit|fix|build|create|implement|remove|delete|add|change|replace|rename|move|refactor|redesign|restyle|style|improve|make|write|adjust|increase|decrease|tweak|clean|install|configure|integrate|apply|convert|migrate|hide|show|swap|reorder|align|resize|deploy|update|test|run|start|launch|boot|serve|open|close)\b/i;

/** A screenshot only sets a visual target when the words around it ask for that screen. */
const REPRODUCE = /\b(?:duplicat\w*|recreate\w*|rebuild|replicat\w*|clone|match(?:es|ing)? (?:this|the|it)|same (?:ui|screen|page|design|look)|look(?:s)? (?:exactly )?(?:like|the same)|make (?:it|this)(?: look)? like|pixel[ -]?perfect|as shown|this (?:ui|screen|page|design|layout)|from (?:the |this )?(?:screenshot|image|picture))\b/i;

/** True when the user is asking for the screen in the image to be reproduced. */
export function asksToReproduce(text: string): boolean {
  return REPRODUCE.test(text);
}

/** True when the message names a real tool. "Use web_search once for X" carries no plain-English
 *  work verb, and reading it as chat made the agent refuse work it was asked for by name. */
const mentionsTool = (text: string) => text.toLowerCase().split(/[^a-z0-9_]+/).some((token) => (TOOL_NAMES as readonly string[]).includes(token));

/** Resolve short follow-ups against the latest task, then begin with safe inspection. */
export function agentIntent(text: string, previousRequests: string[], hasProject: boolean) {
  const followUp = /^(?:yes|ok(?:ay)?|sure|please|do (?:it|that)|go ahead|continue|proceed|next(?: step)?|try (?:it|again))[.!\s]*$/i.test(text.trim());
  const request = followUp ? previousRequests.slice().reverse().find((message) => TASK_VERB.test(message) || mentionsTool(message)) || text : text;
  const explanation = /^(?:how|what|why|explain)\b/i.test(request) && !/\b(?:can|could|would) you\b/i.test(request);
  const requiresTools = mentionsTool(request) || (!explanation && TASK_VERB.test(request));
  // A task that asks for a change must produce a real side effect. Without this the loop
  // accepted "I removed it" as an answer even when no tool ever touched the workspace.
  const requiresWork = !explanation && WORK_VERB.test(request);
  const server = /^(?:please\s+)?(?:run|start|launch)\s+(?:the\s+)?(?:(?:dev|development)\s+)?server[.!]?$/i.test(request.trim());
  const initialActions: AgentAction[] = server ? [{ type: "read_file", path: "package.json" }] : requiresTools && hasProject ? [{ type: "list_dir", path: "." }] : [];
  const finishOnServerReady = requiresTools && /\b(?:run|start|launch|boot|serve)\b/i.test(request) && /\b(?:server|app|application|project|website|site|it|this|workspace)\b/i.test(request) && !/\b(?:build|create|fix|edit|implement|update|deploy|tests?|lint|typecheck|install|electron|desktop|mobile|android|ios|production)\b/i.test(request);
  return { requiresTools, requiresWork, initialActions, request, finishOnServerReady };
}
