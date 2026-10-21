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

/** "what can you do", "your full functions", "tell me everything you can do". */
const CAPABILITIES = /(?:\bwhat\s+(?:exactly\s+|all\s+|else\s+)?can\s+you\s+do\b|\bwhat\s+you\s+can\s+do\b|\beverything\s+(?:you|that\s+you)\s+can\s+do\b|\bwhat\s+(?:are|is)\s+your\s+(?:full\s+|complete\s+)?(?:capabilities|functions|features|skills|abilities)\b|\byour\s+(?:full\s+|complete\s+)?(?:capabilities|functions|features|skills|abilities)\b|\bwhat\s+are\s+you\s+(?:capable|able)\s+of\b|\b(?:list|show|tell\s+me)\b[\s\S]{0,20}\b(?:capabilities|functions|features)\b|\b(?:features|functions|capabilities)\s+do\s+you\s+have\b)/i;

/**
 * A message that asks what the agent is able to do. Here the list IS the answer — and the chat note
 * that keeps "hey" from turning into a task menu was flattening this into three vague lines, so the
 * route needs to know the difference. "What can you do about this bug?" is not one of these.
 */
export function asksForCapabilities(text: string): boolean {
  if (/\b(?:can|could)\s+you\s+do\s+(?:about|for|with|next|best)\b/i.test(text)) return false;
  return CAPABILITIES.test(text);
}

/** True when the message names a real tool. "Use web_search once for X" carries no plain-English
 *  work verb, and reading it as chat made the agent refuse work it was asked for by name. */
const mentionsTool = (text: string) => text.toLowerCase().split(/[^a-z0-9_]+/).some((token) => (TOOL_NAMES as readonly string[]).includes(token));

// "search for calvras.com and go to their partner page" names the site without a scheme, and the
// folder survey used to answer it. The list is real TLDs only, so a filename never reads as a host.
const BARE_HOST = /(?:^|[\s(])((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|ai|co|app|sh|gg|xyz|tech|so|me|info|site|online|cloud|live|gov|edu|de|fr|jp|uk|us|ca|au|br|in|ru|it|es|nl|pl|se)(?::\d+)?(?:\/[^\s"'<>,]*)?)(?=$|[\s).,!?;:])/i;
function bareHost(text: string): string | undefined {
  const match = BARE_HOST.exec(text);
  return match ? match[1] : undefined;
}
const withScheme = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

/**
 * A message whose verb belongs to the agent rather than to the workspace — "the languages you can
 * write", "the sites you can open", "what you know". Reading "write" in that clause as a work verb
 * made it a build task, so the loop refused the answer five times over and the user watched the same
 * list land again under Thinking…. A named file, folder or page still wins: that is work.
 */
const ABOUT_AGENT = /\b(?:you|calvras|the model)\s+(?:can|could|know|know\s+of|support|supports|have|has|are|is|do|does)\b/i;
const WORKSPACE_TARGET = /\b(?:files?|folders?|directories|directory|repo|repository|codebase|project|workspace|components?|classes?\b|pages?|routes?|src\/|\.tsx?\b|\.jsx?\b|\.py\b)\b/i;

export function asksAboutTheAgent(text: string): boolean {
  return ABOUT_AGENT.test(text) && !WORKSPACE_TARGET.test(text);
}

/** Resolve short follow-ups against the latest task, then begin with safe inspection. */
export function agentIntent(text: string, previousRequests: string[], hasProject: boolean) {
  const followUp = /^(?:yes|ok(?:ay)?|sure|please|do (?:it|that)|go ahead|continue|proceed|next(?: step)?|try (?:it|again))[.!\s]*$/i.test(text.trim());
  const request = followUp ? previousRequests.slice().reverse().find((message) => TASK_VERB.test(message) || mentionsTool(message)) || text : text;
  const explanation = /^(?:how|what|why|explain)\b/i.test(request) && !/\b(?:can|could|would) you\b/i.test(request);
  // "Show me what you can do" carries the verb "show", which made it a workspace task and answered a
  // question about the agent with a folder listing. A question about itself needs no tools.
  const aboutItself = asksForCapabilities(request) || asksAboutTheAgent(request);
  const requiresTools = !aboutItself && (mentionsTool(request) || (!explanation && TASK_VERB.test(request)));
  // A task that asks for a change must produce a real side effect. Without this the loop
  // accepted "I removed it" as an answer even when no tool ever touched the workspace.
  const requiresWork = !aboutItself && !explanation && WORK_VERB.test(request);
  const server = /^(?:please\s+)?(?:run|start|launch)\s+(?:the\s+)?(?:(?:dev|development)\s+)?server[.!]?$/i.test(request.trim());
  // An address in the message means the user wants to be on that page, and a folder scan is not
  // being on it. The browser opens before the first model round finishes thinking.
  const address = /https?:\/\/[^\s"'<>,]+/i.exec(request)?.[0] ?? bareHost(request);
  // "go to their partner page" names no host and no scheme. It still means a web page, while
  // "open the pricing page and change the layout" means the code that renders it, so a verb that
  // alters something is what separates the two. ("open", "run", "test" are how people say
  // "navigate", so they are not in this list.)
  const changesSomething = /\b(?:edit|fix|build|create|implement|remove|delete|add|change|replace|rename|move|refactor|redesign|restyle|style|improve|write|adjust|increase|decrease|tweak|clean|install|configure|integrate|convert|migrate|hide|show|swap|reorder|align|resize|deploy|update)\b/i;
  const browsing = !changesSomething.test(request)
    && /\b(?:open|visit|browse|go\s+to|navigat\w*|search\s+for|look\s+up|google)\b/i.test(request)
    && /\b(?:website|web\s*site|web\s*page|page|site|url|link|browser|online)\b/i.test(request);
  const webIntent = /\b(?:open|browse|visit|go\s+to|check|look|search|find|apply|book|message|sign\s*up|fill|scroll|click)\b/i.test(request);
  const webFirst = !explanation && webIntent && (Boolean(address) || browsing);
  const initialActions: AgentAction[] = server
    ? [{ type: "read_file", path: "package.json" }]
    : webFirst && address
    ? [{ type: "open_browser", url: withScheme(address) }]
    : webFirst && hasProject
    ? [{ type: "web_search", query: request }]
    : requiresTools && hasProject ? [{ type: "list_dir", path: "." }] : [];
  const finishOnServerReady = requiresTools && /\b(?:run|start|launch|boot|serve)\b/i.test(request) && /\b(?:server|app|application|project|website|site|it|this|workspace)\b/i.test(request) && !/\b(?:build|create|fix|edit|implement|update|deploy|tests?|lint|typecheck|install|electron|desktop|mobile|android|ios|production)\b/i.test(request);
  return { requiresTools, requiresWork, initialActions, request, finishOnServerReady, webFirst };
}
