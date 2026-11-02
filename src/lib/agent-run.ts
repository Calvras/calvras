import { partialMessage } from "./streaming";
import { feedbackContext } from "./agent-context";
import { describeFidelity, fidelityNote, type FidelitySummary } from "./image-fidelity";
import { TOOL_RISK } from "./tool-catalog";

import { validateToolAction, type ToolAction } from "./tool-catalog";
export type AgentAction = ToolAction;
export type AgentReply = { actions: AgentAction[]; message: string; status?: "continue" | "complete" | "blocked"; plan?: string };

function extractJson(raw: string): string {
  const start = raw.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (raw[i] === '\\') escaped = true;
      else if (raw[i] === '"') quoted = false;
      continue;
    }
    if (raw[i] === '"') { quoted = true; continue; }
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
    return validateToolAction(action);
  });
  return { actions, message: value.message, ...(typeof value.plan === "string" ? { plan: value.plan } : {}), ...(["continue", "complete", "blocked"].includes(value.status) ? { status: value.status } : {}) };
}

export type ToolFeedback = { action: AgentAction; ok: boolean; result: unknown };
export type AgentOutcome = { status: "finished" | "blocked" | "stopped" | "limit"; message?: string; error?: string; plan?: string; /** The phase-plan steps still untouched when the run stopped, so the UI can offer to pick the work back up. */ openSteps?: string[] };
type PreviewState = { healthy: boolean; issues: string[]; url: string };
/** Characters of detailed tool context that trigger a working-memory compression.
 * Deliberately high: a normal task should finish long before this, so compression is a
 * last resort for genuinely long runs rather than something that interrupts short work. */
const COMPRESSION_THRESHOLD = 120_000;
/** Working context handed to the model. Kept at the compression threshold so nothing is
 * silently dropped before compression gets a chance to summarise it properly. */
const CONTEXT_WINDOW = 120_000;
/** Automatic reload-and-recheck attempts before an unhealthy preview blocks the run. */
const PREVIEW_CHECK_LIMIT = 3;
/** Replies the loop will ask the model to repair before giving up on the turn. Generous on
 * purpose: one truncated JSON object must not kill hours of real work. */
const INVALID_REPLY_LIMIT = 6;
/** Rounds without a real action that a run gets before it stops, on the condition that the
 * state still holds something unfinished. Long enough to recover from a confused round. */
const IDLE_ROUND_LIMIT = 5;
/** Repeated read-only rounds before the run stops itself. */
const REPEATED_READ_LIMIT = 12;
/** Rounds the plan gate holds a completion claim for before letting the run end honestly. */
const PLAN_GATE_LIMIT = 4;

function compressedFallback(task: string, ledger: string[], inspected: Set<string>, needsVerification: boolean, executedActions: number): string {
  return [
    `Original task: ${task.replace(/\s+/g, " ").slice(0, 700)}`,
    `${executedActions} actions executed so far.`,
    ledger.length ? `Action ledger (oldest to newest):\n${ledger.slice(-60).join("\n")}` : "",
    inspected.size ? `Already inspected: ${[...inspected].join(", ").slice(-1600)}` : "",
    needsVerification ? "The latest changes still need verification." : "",
    "Continue this same task from the current state. Do not restart completed work.",
  ].filter(Boolean).join("\n");
}

export async function runAgent(options: {
  prompt: string;
  signal: AbortSignal;
  infer: (prompt: string, onDelta?: (text: string) => void) => Promise<string>;
  execute: (actions: AgentAction[]) => Promise<ToolFeedback[]>;
  onFeedback: (message: string) => void;
  /** Closes a turn. `final` is false for the update that accompanies a tool round, so the
   * host can keep it in the timeline instead of printing it again as the reply. */
  onPhaseComplete?: (message: string, final?: boolean) => void;
  maxSteps?: number;
  requiresTools?: boolean;
  requiresWork?: boolean;
  /** The task writes files and no project folder is open. A build in this state stalls on a
   *  question the model keeps asking in prose, where nothing can answer it. */
  needsProjectFolder?: boolean;
  initialActions?: AgentAction[];
  finishOnServerReady?: boolean;
  onMessageDelta?: (message: string) => void;
  getSteering?: () => string[];
  /** Summarize the accumulated session. Return plain text that preserves goals, results, failures and next steps. */
  compress?: (transcript: string) => Promise<string>;
  onCompression?: (state: "compressing" | "compressed", summary?: string) => void;
  /** True when the user sent a screenshot this session, so a rebuilt UI has to be
   * measured against it before the run may claim it is done. */
  hasReferenceImage?: boolean;
}): Promise<AgentOutcome> {
  const history: string[] = [];
  let invalidReplies = 0;
  // The agent's own most recent sentence, kept so a run that has to stop can end on what it
  // actually said rather than on internal text.
  let lastNarration = "";
  const failedCommands = new Set<string>();
  let unresolvedFailures = false;
  // An agent that meets an error it cannot fix does not stop: it rewords the same attempt and
  // tries again. One duplication job spent 17 minutes re-editing the same CSS against the same
  // PostCSS conflict, each round reporting that this one would settle it. The key below is the
  // failing tool plus the error's own line, so the loop can see the repeat the model keeps
  // rephrasing — and say so, then stop, instead of spending the whole run on another attempt.
  // Each error also remembers the exact call that produced it, so only that call passing means it
  // was really fixed: an unrelated command that happens to succeed proves nothing about the build.
  const failureRepeats = new Map<string, { count: number; keys: Set<string> }>();
  const STUCK_NUDGE_AT = 3;
  const STUCK_STOP_AT = 6;
  let stuck: { signature: string; detail: string; count: number } | null = null;
  // The brief is re-read every round, so the same note is only worth putting in front of the model
  // once per new occurrence of the error — not on every round afterwards.
  let stuckNote: string | null = null;
  // record() is the only writer, and the loop's own view of the variable stays narrowed to its
  // initial null, so the round reads it back through this.
  const stuckRound = () => stuck as { signature: string; detail: string; count: number } | null;
  let executedActions = 0;
  // A completion claim for a change request is only credible after real state changed.
  let workDone = false;
  let idleRounds = 0;
  let needsVerification = false;
  let serverNeedsVerification = false;
  // True once a managed server proved it answers HTTP in this run. A reply that says a
  // service is up without that proof gets probed instead of accepted.
  let serverReadyProof = false;
  let serverProbes = 0;
  const SERVER_PROBE_LIMIT = 2;
  const claimsLiveServer = (text: string) => text.split(/(?<=[.!?])\s+/).some((sentence) =>
    !/\b(?:not|never|nothing|without|stopped|closed|failed|refus)/i.test(sentence) &&
    /\b(?:server|api|endpoint|service|application|app)\b/i.test(sentence) &&
    /(?:https?:\/\/(?:localhost|127\.0\.0\.1)|\bport\s*\d{4,5}\b|:\d{4,5}\b)/i.test(sentence) &&
    /\b(?:running|listening|live|up|serving|reachable|responding|available|ready|start(?:s|ed|ing)?|boot(?:ed|ing)?|launch(?:ed|es|ing)?)\b/i.test(sentence));
  // The task itself demanding a service on a port is a stronger signal than how the model
  // words its final reply: it must end with that port actually answering HTTP.
  const serverTaskRequested = /\b(?:server|api|endpoint|service|application|app)\b/i.test(options.prompt) &&
    /\b(?:listens?(?:ing)?|start(?:s|ed|ing)?|run(?:s|ning)?|serv(?:es|ing)?|launch(?:ed|es|ing)?|bring(?:ing)? up|spin(?:ning)? up)\b[^\n]{0,80}\b(?:port\s*)?\d{4,5}\b|\bport\s*\d{4,5}\b|\b(?:localhost|127\.0\.0\.1):\d{4,5}\b/i.test(options.prompt);
  let browserNeedsVerification = false;
  // True once a browser page has been opened in this run, so later edits re-arm the check.
  let uiIsOpen = false;
  let verificationAutoRun = false;
  // The latest rendered preview is a hard completion gate. It starts unknown;
  // once a preview check runs, an unhealthy result blocks "complete" until a
  // fresh check passes.
  let previewHealth: PreviewState | null = null;
  let previewChecks = 0;
  /** True while the run's own phase plan still holds untouched steps. Judging a half-built page
   * is what made a build stop eleven minutes in: the server comes up early, the preview reads as
   * broken because the later steps have not been written yet, and every round after that spends
   * itself on the preview instead of the work. So the page is judged once, after the last step. */
  const buildInProgress = () => plan.total > 0 && plan.open.length > 0;
  /** Whether a rendered page is even part of this job. A CLI or backend run with a phase plan must
   * not end up chased by a preview check for a page that was never asked for. */
  const uiBuildRequested = /\b(?:ui|interface|frontend|front-end|website|web ?app|webpage|page|screen|landing|dashboard|design|react|next\.?js|vue|svelte|html|css|tailwind)\b/i.test(options.prompt);
  /** An edit made while the build was still running means the last look no longer describes the
   * page. Held instead of acted on, and turned into one blocking check when the plan completes. */
  let previewStaleMidBuild = false;
  const previewBroken = () => previewHealth !== null && !previewHealth.healthy;
  const previewProblems = () => (previewHealth?.issues ?? []).slice(0, 5).join("; ");
  // A verification gate that has failed its own checks as many times as it is allowed stops
  // holding the rest of a long build hostage: the run finishes the remaining plan steps and
  // says plainly which part it could not verify. Without this, one dead preview port ends a
  // two-hour brief eleven minutes in.
  let previewGateDisarmed = false;
  let fidelityGateDisarmed = false;
  let serverGateDisarmed = false;
  const previewBlocking = () => previewBroken() && !previewGateDisarmed && !buildInProgress();
  const previewPromptState = () => buildInProgress()
    ? ` The build is still in progress (${plan.open.length} planned step(s) untouched), so the preview is out of bounds for now: do not call check_preview, compare_to_reference or take_screenshot to judge this half-built page, and do not treat a blank or unstyled preview as a failure to fix right now. It is half-built because you have not built the rest. Keep writing the files the next step needs, and judge the rendered page once, after the last step is marked done.`
    : previewHealth ? (previewHealth.healthy ? " The visible preview's DOM check passed, which says nothing about whether it looks designed — judge its screenshot." : ` The visible preview FAILS verification: ${previewProblems() || "the page did not render"}. Fix it and call check_preview; completion is blocked until it passes.`) : "";
  // When the user supplied a screenshot, a rebuilt screen has to be measured against it.
  // The check runs in the visible page and returns real pixel numbers.
  let fidelityEnforced = options.hasReferenceImage === true;

  let fidelity: FidelitySummary | null = null;
  let fidelityStuck = 0;
  const FIDELITY_CHECK_LIMIT = 3;
  /** Only a real visual disagreement blocks. A panel that cannot be aligned to the
   * screenshot's shape is a caveat to disclose, not a reason to loop forever. */
  const fidelityMismatch = () => fidelity !== null && fidelity.reasons.some((reason) => !reason.includes("different shape"));
  const shapeOnly = () => fidelity !== null && !fidelity.matched && !fidelityMismatch();
  const fidelityPending = () => fidelityArmed() && (fidelity === null || fidelityMismatch());
  const previewRendered = () => previewHealth !== null || uiIsOpen;
  /** Armed once the run has both the user's screenshot and real work on screen: the
   * completion claim then needs a measured pixel comparison, not an opinion. */
  const fidelityArmed = () => fidelityEnforced && !fidelityGateDisarmed && workDone && previewRendered() && !buildInProgress();
  /** The screenshot is the specification, but only for a page that is actually built. While the
   * plan still has steps, a pixel diff against a half-written screen measures the work the run has
   * not done yet, so the obligation waits rather than firing round after round. */
  const fidelityHeld = () => fidelityEnforced && !fidelityGateDisarmed && buildInProgress();
  const fidelityPromptState = () => fidelity
    ? (fidelity.matched ? ` The render matches the user's screenshot at ${fidelity.similarity}% similar with the colours and layout in line; read the attached panels before you call it done.` : shapeOnly() ? ` The render was measured against the user's screenshot but the preview panel is a different shape (${fidelity.referenceSize.width}x${fidelity.referenceSize.height} versus ${fidelity.renderedSize.width}x${fidelity.renderedSize.height}), so layout could not be aligned; colours and the picture itself were compared. Say in the reply which part of the screen you could not verify that way.` : ` The render does NOT match the user's screenshot (${fidelity.diff}% different${fidelity.hotspots.length ? `: ${fidelity.hotspots.slice(0, 3).map((item) => `${item.region} ${item.diff}%`).join(", ")}` : ""}) — ${fidelity.reasons.join("; ")}. Fix it and call compare_to_reference; completion is blocked until it passes.`)
    : (fidelityHeld() ? " The screenshot comparison waits until the build is finished — the page is half-written right now, so measuring it would only measure the parts you have not built. Keep building." : fidelityEnforced && !fidelityGateDisarmed ? " The screen has not yet been compared pixel-by-pixel with the screenshot the user sent; call compare_to_reference once the page renders." : "");
  const toolHistory: { detailed: string; summary: string }[] = [];
  const actionLedger: string[] = [];
  const pendingWorkers = new Set<string>();
  // Repeated web work ("apply to every posting on this site") lives in .calvras/batch.json.
  // A run that finishes while targets are still queued has not done what was asked, so the
  // ledger's counts gate completion the same way a failing preview does.
  const batch = { total: 0, queued: 0, running: 0, done: 0, blocked: 0, skipped: 0 };
  let batchUsed = false;
  // There is no way to switch this gate off: a queue the run keeps abandoning still drains,
  // because the ledger closes a target dropped three times as blocked on its own.
  const batchPending = () => batchUsed && batch.queued + batch.running > 0;
  // A written phase plan is what makes a multi-hour build survivable: once the run has laid
  // steps down, finishing early is a decision the loop no longer gets to take silently.
  const plan = { total: 0, open: [] as string[] };
  let planStuck = 0;
  let planGaveUp = false;
  const planPending = () => !planGaveUp && plan.total > 0 && plan.open.length > 0;
  /** The steps the loop never got to, carried out of the run so the reply can offer to pick
   * the work back up instead of making the user retype the whole request. */
  const carried = () => (plan.open.length ? { openSteps: plan.open.slice(0, 6) } : {});
  const inspected = new Set<string>();
  const snapshotReads = new Set(["read_file", "read_package_json", "list_dir", "list_files", "directory_tree", "analyze_project"]);
  /** Judging our own running page. These are the calls a build spends its rounds on once the
   *  stylesheet comes back with no rules in it — and an unfinished page always reads that way. */
  const previewLooks = new Set(["check_preview", "compare_to_reference", "inspect_element", "check_console_errors", "test_responsive_layout", "take_screenshot"]);
  /** "duplicate https://www.cloudflare.com/" names a page the run has to read end to end before it
   * writes a line of it. The brief says so, and the run that skips it rebuilds the one screenful it
   * opened on and guesses at every section below the fold — which is exactly the wrong spacing, wrong
   * colour and wrong size the user then looks at. So the write is withheld until the survey is back.
   * A repo link with "clone" is source to fetch, not a page to copy, so that wording is excluded. */
  const referenceMatch = /(https?:\/\/[^\s"'<>]+)/i.exec(options.prompt);
  const isPageCopy = /\b(?:duplicat\w*|replicat\w*|clone[sd]?|re-?create[sd]?|pixel-?perfect|same\s+(?:as|like)\s+this)\b/i.test(options.prompt)
    && !/\b(?:repo|repository|codebase|source\s+code)\b/i.test(options.prompt);
  const referenceUrl = (referenceMatch && isPageCopy ? referenceMatch[1] : "") ?? "";
  const samePage = (left: string, right: string) => {
    if (!left || !right) return false;
    if (left.replace(/\/+$/, "") === right.replace(/\/+$/, "")) return true;
    try { return new URL(left).hostname.replace(/^www\./, "") === new URL(right).hostname.replace(/^www\./, ""); } catch { return false; }
  };
  let referenceSurveyed = false;
  let referenceHeldRounds = 0;
  const REFERENCE_HOLD_LIMIT = 3;
  type ReferenceSheet = { url?: string; sectionCount?: number; documentHeightPx?: number; sections?: any[]; palette?: string[]; documentText?: string; viewportWidthPx?: number; viewportHeightPx?: number };
  let referenceSheet: ReferenceSheet | null = null;
  let referencePlanSeeded = false;
  let referenceTookPage = false;
  let referenceTakeTried = false;
  /**
   * The survey survives two rounds. Everything older than the last two tool results is folded into a
   * 1000-character summary, so on a build that takes thirty rounds the page being copied is gone from
   * the prompt before the middle of it is written — and the run finishes inventing sections it cannot
   * remember measuring. This is the same sheet re-rendered compactly and pinned into every prompt for
   * as long as the plan has open steps, so the numbers are in front of the model as it writes them.
   */
  let referenceBrief = "";
  const buildReferenceBrief = (sheet: ReferenceSheet) => {
    const bands = sheet.sections ?? [];
    const out = [
      `REFERENCE BUILD SHEET — ${sheet.url ?? referenceUrl} · ${sheet.documentHeightPx ?? 0}px tall · ${sheet.sectionCount ?? bands.length} sections · viewport ${sheet.viewportWidthPx ?? 0}x${sheet.viewportHeightPx ?? 0}`,
      `palette: ${(sheet.palette ?? []).join(" | ")}`,
    ];
    for (const band of bands) {
      out.push(`${Number(band?.index) + 1}. <${band?.tag}>${band?.id ? `#${band.id}` : ""} y=${band?.topPx} h=${band?.heightPx} bg=${band?.background} fg=${band?.color} pad=${band?.paddingPx} maxw=${band?.maxWidthPx} align=${band?.textAlign}${band?.font ? ` font=${band.font}` : ""}${band?.baseFontSizePx ? ` base=${band.baseFontSizePx}px` : ""}`);
      for (const head of band?.headings ?? []) out.push(`   ${head.tag} "${head.text}" ${head.sizePx}px w${head.weight} ${head.color} lh${head.lineHeightPx}`);
      for (const control of band?.controls ?? []) out.push(`   link/btn "${control.text}" bg=${control.background} fg=${control.color} r=${control.radiusPx} pad=${control.paddingPx} ${control.fontSizePx}px`);
      for (const item of band?.media ?? []) out.push(`   ${item.tag} ${item.size} alt="${item.alt}" ${item.src}`);
      if (band?.text) out.push(`   words: ${String(band.text).replace(/\n/g, " ¶ ").slice(0, 600)}`);
    }
    const words = String(sheet.documentText ?? "");
    if (words) out.push(`EVERY WORD ON THE PAGE, IN DOCUMENT ORDER (copy it verbatim into these sections): ${words.slice(0, 12000)}`);
    const brief = out.join("\n");
    return brief.length > 40000 ? `${brief.slice(0, 40000)}\n[sheet trimmed — call read_page {full:true} again for the sections past this point]` : brief;
  };
  // The page's own markup is both the faster and the more faithful read of it, so it is the door this
  // run is expected to use first: a survey alone no longer releases the writes, because a model that
  // has measured every band will happily spend thirty-five rounds retyping them — which is the twenty
  // minutes the user complained about. The hand-built route stays open: once a take has actually been
  // attempted, the survey is enough.
  const handRouteOpen = () => referenceTookPage || (referenceTakeTried && referenceSurveyed);
  const referencePending = () => Boolean(referenceUrl) && !handRouteOpen();
  const referencePromptState = () => referencePending() ? ` ${referenceUrl} is the specification and none of it is in the project yet: call duplicate_page {url:"${referenceUrl}"} — one call saves that page's own markup and stylesheet into the project, and you then edit only what the user asked. Do not build it from a screenshot or from a survey of bands; that is the slow route and it is what produced the wrong spacing and colours last time.` : "";
  /** Pinned for as long as the build has steps left, then dropped — the finished page is judged by
   * the pixel comparison, and paying for the sheet again after the last band is written buys nothing. */
  const referenceSheetPrompt = () => referenceBrief && buildInProgress() ? `\n${referenceBrief}\n[END REFERENCE BUILD SHEET] This is what the page at ${referenceUrl} measures, section by section, and it stays in front of you for every remaining step. Reproduce each band at its own height, colour, padding and font size, and use its own words exactly as listed — the copy is on the sheet, so inventing headline or card text is a choice, not a limitation. Nothing here is judged against the preview until the last band is written.` : "";
  const pageWrites = new Set(["write_file", "create_file", "search_replace", "multi_replace", "insert_code", "delete_lines", "apply_patch", "apply_diff", "multi_file_edit", "refactor_code", "format_file", "format_code", "generate_image"]);
  // External tools that only observe; they cannot satisfy a change request on their own.
  const observational = new Set(["take_screenshot", "take_screen_screenshot", "inspect_element", "test_responsive_layout", "read_page", "read_page_content", "check_console_errors", "list_windows", "search_documentation", "web_search", "wait_for_element", "wait_for_window", "focus_window"]);
  // What every page, file and command has returned so far — never the batch ledger, whose own
  // echo of a reference would otherwise "prove" the report that carried it.
  let observedText = "";
  /** Batch targets a done-report closed without a receipt any page in this run printed. */
  const receiptDoubts: { id: string; reference: string; why: string }[] = [];
  /** Receipt codes handed out this run, and the target that first quoted each one. Two postings
   * cannot arrive with the same reference, so a second claim on it is a code copied off an earlier
   * confirmation page — the shape a sloppy batch takes when the run stops reading. */
  const receiptsTaken = new Map<string, string>();
  /** Targets still closed as done whose receipt was never actually read. The submission stays
   * closed — reopening finished work is how a batch applies to the same posting twice — but the
   * final count has to name them, because "7 applications sent" is not "7 postings covered". */
  const unreceipted = new Set<string>();
  const receiptNudged = new Set<string>();
  /** Boilerplate the site prints on every confirmation. It proves a page was read, not that this
   * target went through, so it can never stand in for the reference the page issued. */
  const BOILERPLATE_RECEIPT = /^(?:the )?(?:application|submission|form|request|booking|order|answer|message)s? (?:has been |is |was |are )?(?:successfully )?(?:submitted|received|sent|completed|complete|done|successful|recorded|confirmed|accepted)|^(?:submitted|received|sent|completed|success|successful|done|ok|confirmed|accepted)[.!]*$/i;
  /** Batch targets queued from an address nothing this run has read carries: a run that wrote a
   * URL from memory instead of following the link on the listing page, which then 404s. */
  const queueDoubts: string[] = [];
  const addressSeen = (url: string) => {
    const haystack = `${options.prompt}\n${observedText}`.toLowerCase();
    // A page read earlier may have shown the link as `127.0.0.1:8123/post/2` while the run writes
    // `localhost:8123/post/2`; only the address the listing actually printed counts as invented.
    const forms = [url, url.replace(/^https?:\/\//, "").replace(/^www\./i, "")];
    try {
      const parsed = new URL(url);
      forms.push(`${parsed.host}${parsed.pathname}`, parsed.pathname);
    } catch { /* a label where a URL was expected — nothing to match */ }
    return forms.some((form) => form.length > 1 && haystack.includes(form.toLowerCase()));
  };
  const LEDGER_TOOLS = ["report_batch", "queue_batch", "next_batch", "batch_status"];
  /** The text a failed tool actually returned. A build says what broke in its output; a refused
   *  action says it in `error`. */
  const failureTextOf = (result: ToolFeedback): string => {
    const data = (result.result ?? {}) as { error?: unknown; output?: unknown; stderr?: unknown };
    return String(data.error ?? data.output ?? data.stderr ?? "").trim();
  };
  /** A look at the running page that comes back unhappy is the same dead end as a failed command,
   *  but the tool itself succeeded, so `ok` is true and nothing counted it. That is how a run spends
   *  seventeen rounds reading the same unstyled page: the repeat is in the verdict, not in an error. */
  const lookProblem = (result: ToolFeedback): string => {
    const data = (result.result ?? {}) as { healthy?: boolean; issues?: unknown; matched?: boolean; score?: unknown; diffPercent?: unknown; mismatch?: unknown };
    if (result.action.type === "check_preview" && data.healthy === false)
      return (Array.isArray(data.issues) ? data.issues.join("; ") : "") || "the preview did not render";
    if (result.action.type === "compare_to_reference" && data.matched === false)
      return `the rebuilt page still differs from the reference (${String(data.score ?? data.diffPercent ?? data.mismatch ?? "no match")})`;
    return "";
  };
  /** The line that carries the failure, with the parts that legitimately change between attempts
   *  (paths, ports, counts) taken out, so the same error recognises itself next round even when
   *  the file it names moved. */
  const failureSignature = (actionType: string, text: string): string => {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const line = lines.find((candidate) => /\b(?:error|failed|cannot|could not|unexpected|missing|not found|conflict)\b/i.test(candidate)) ?? lines[0] ?? "";
    const normalized = line
      .replace(/(?:[a-z]:)?(?:[\\/][^\s:,'")\]}]+)+/gi, "<path>")
      .replace(/\b\d+(?::\d+)*\b/g, "#")
      .replace(/`/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140)
      .toLowerCase();
    return `${actionType}|${normalized}`;
  };
  const record = (results: ToolFeedback[]) => {
    const detailed = feedbackContext(results);
    const evidence = feedbackContext(results.filter((result) => !LEDGER_TOOLS.includes(result.action.type)));
    // Checked against the evidence as it stood before this round: a done-report has to be proven
    // by a page the run actually read, not by the number it is quoting.
    const proofText = (observedText + "\n" + evidence).toLowerCase();
    toolHistory.push({ detailed, summary: feedbackContext(results, false) });
    observedText = (observedText + "\n" + evidence).slice(-200_000);
    // Actions skipped for runtime reasons (for example no workspace) are guidance
    // for the model, not executed work or real failures. Checked strictly because a tool
    // may legitimately return a count named "skipped" — the batch ledger does exactly that.
    const effective = results.filter((result) => (result.result as { skipped?: boolean } | null)?.skipped !== true);
    executedActions += effective.length;
    const succeededKeys = new Set<string>();
    for (const result of effective) {
      const actionKey = `${result.action.type}|${JSON.stringify(result.action)}`;
      const problem = result.ok ? lookProblem(result) : failureTextOf(result);
      // A look that came back unhappy ran fine as a tool, so `ok` is true — but it is not the call
      // passing. Only a clean result retires the error it produced.
      if (result.ok && !problem) succeededKeys.add(actionKey);
      if (problem) {
        const signature = failureSignature(result.action.type, problem);
        const detail = signature.slice(signature.indexOf("|") + 1);
        // A one-word signature ("failed", "error") proves nothing and would fire on unrelated
        // rounds, so only a line with real content is counted.
        if (detail.length > 12) {
          const entry = failureRepeats.get(signature) ?? { count: 0, keys: new Set<string>() };
          entry.count += 1;
          entry.keys.add(actionKey);
          failureRepeats.set(signature, entry);
          if (entry.count >= STUCK_NUDGE_AT && (!stuck || entry.count >= stuck.count)) stuck = { signature, detail, count: entry.count };
        }
      }
      if (result.ok && result.action.type === "report_batch" && result.action["status"] === "done") {
        const reference = String(result.action["reference"] ?? "").trim();
        const id = String(result.action.id ?? "?");
        const owner = receiptsTaken.get(reference.toLowerCase());
        // Boilerplate ("application submitted") is what every confirmation page says, so it proves a
        // page was read and nothing about this target. A code another target already quoted was
        // copied off that earlier page instead of read here — two postings cannot share one receipt.
        const why = !reference ? "no reference was given at all"
          : reference.length < 4 ? `"${reference}" is too short to be the code a site issues`
          : BOILERPLATE_RECEIPT.test(reference) ? `"${reference}" is the sentence every confirmation page prints, which proves nothing about this target`
          : owner && owner !== id ? `that code is ${owner}'s receipt, so it was copied from an earlier confirmation instead of read off this page`
          : !proofText.includes(reference.toLowerCase()) ? `no page this run read prints "${reference}"`
          : "";
        if (why) receiptDoubts.push({ id, reference, why });
        else { receiptsTaken.set(reference.toLowerCase(), id); unreceipted.delete(id); }
      }
      if (result.ok && result.action.type === "queue_batch") {
        for (const target of (Array.isArray(result.action["targets"]) ? result.action["targets"] : [])) {
          const url = String((target as { url?: unknown })?.url ?? "").trim();
          if (url && !addressSeen(url)) queueDoubts.push(url);
        }
      }
      const ledgerTarget = result.action.command || result.action.path || result.action.url || result.action["selector"] || "";
      actionLedger.push(`${result.ok ? "ok" : "FAILED"} ${result.action.type}${ledgerTarget ? ` ${ledgerTarget}` : ""}`.slice(0, 240));
      if (actionLedger.length > 400) actionLedger.splice(0, actionLedger.length - 400);
      const resultRisk = TOOL_RISK[result.action.type];
      if (result.ok && (["edit", "destructive", "execute"].includes(resultRisk) || (resultRisk === "external" && !observational.has(result.action.type)))) workDone = true;
      if (result.ok && ["edit", "destructive", "execute"].includes(resultRisk)) inspected.clear();
      if (result.ok && snapshotReads.has(result.action.type)) inspected.add(JSON.stringify(result.action));
      const job = (result.result as { job?: { id: string; status: string } })?.job;
      if (job) { if (["queued", "running"].includes(job.status)) pendingWorkers.add(job.id); else pendingWorkers.delete(job.id); }
      if (result.ok && ["queue_batch", "next_batch", "report_batch", "batch_status"].includes(result.action.type)) {
        const counts = (result.result || {}) as Record<string, number>;
        if (typeof counts["queued"] === "number") {
          for (const key of ["queued", "running", "done", "blocked", "skipped"] as const) if (typeof counts[key] === "number") batch[key] = counts[key];
          batch.total = batch.queued + batch.running + batch.done + batch.blocked + batch.skipped;
          batchUsed = true;
        }
      }
      const taskState = (result.result as { tasks?: { title?: string; status?: string }[] } | null)?.tasks;
      if (result.ok && ["create_task_list", "plan_tasks", "track_progress", "read_task"].includes(result.action.type) && Array.isArray(taskState)) {
        const hadSteps = plan.open.length > 0;
        plan.total = taskState.length;
        plan.open = taskState.filter((task) => !["done", "blocked"].includes(String(task.status))).map((task) => String(task.title || "")).filter(Boolean);
        if (plan.open.length) planStuck = 0;
        // The last step just closed. Everything built after the previous look has never been seen
        // rendered, so the one thing the run now owes the user is a single pass over the finished
        // page — the check it was told to hold while it worked.
        if (hadSteps && plan.open.length === 0 && (previewStaleMidBuild || previewHealth !== null || uiIsOpen || uiBuildRequested) && !previewGateDisarmed) {
          previewStaleMidBuild = false;
          previewHealth = { healthy: false, issues: ["The build is finished and the page has not been looked at since the last steps were written. Open the preview once now, judge the screenshot as a person would, fix what falls short, then complete."], url: previewHealth?.url ?? "" };
          previewChecks = 0;
        }
      }
      const commandKind = /\bbuild\b/.test(result.action.command ?? "") ? "build" : /\btest\b/.test(result.action.command ?? "") ? "tests" : /\blint\b/.test(result.action.command ?? "") ? "lint" : /\b(?:tsc|typecheck)\b/.test(result.action.command ?? "") ? "typecheck" : result.action.command;
      const identity = result.action.type === "run_command" ? commandKind! : result.action.type.replace(/^run_/, "");
      if (["run_command", "run_build", "run_tests", "run_lint", "run_typecheck"].includes(result.action.type)) {
        if (!result.ok) failedCommands.add(identity);
        else failedCommands.delete(identity);
      }
      if (result.ok && TOOL_RISK[result.action.type] === "edit" && !["format_code", "create_checkpoint", "write_memory"].includes(result.action.type)) needsVerification = true;
      if (result.ok && ["read_file", "run_tests", "run_single_test", "run_build", "run_linter", "run_lint", "run_typecheck", "run_command", "verify_changes"].includes(result.action.type)) needsVerification = false;
      if (["start_server", "check_server", "start_dev_server"].includes(result.action.type) || typeof (result.result as { ready?: boolean })?.ready === "boolean") {
        const alive = result.ok && (result.result as { ready?: boolean })?.ready === true;
        serverReadyProof = alive;
        serverNeedsVerification = !alive;
      }
      // Editing the code a live server serves invalidates the proof: the running process no
      // longer contains the change, so the next completion claim has to be re-checked.
      if (result.ok && TOOL_RISK[result.action.type] === "edit" && !["format_code", "create_checkpoint", "write_memory"].includes(result.action.type)) serverReadyProof = false;
      if (result.action.type === "stop_dev_server") serverReadyProof = false;
      // Once a rendered UI is on screen, edits invalidate it: the agent has to drive the real
      // interface — type into it, click it, look at what came back — before it can finish.
      const uiProof = ["inspect_element", "take_screenshot", "test_responsive_layout", "fill_input", "click_element", "press_page_key", "upload_file_to_page", "click_at", "hover_at", "drag_at", "type_into_page"];
      if (result.ok && ["open_browser", "navigate_browser"].includes(result.action.type)) { uiIsOpen = true; browserNeedsVerification = true; }
      if (result.ok && uiProof.includes(result.action.type)) browserNeedsVerification = false;
      if (result.ok && TOOL_RISK[result.action.type] === "edit" && uiIsOpen && !buildInProgress()) browserNeedsVerification = true;
      // Only the survey proves the run looked past the fold: it scrolls the live page to its real
      // end and reports every band, so a duplication can be built from measured numbers. A survey of
      // our own half-written page is not a read of the reference, so the URL has to match.
      if (result.ok && !referenceTookPage && result.action.type === "read_page" && (result.result as { coverage?: string } | null)?.coverage === "full document"
        && Boolean(referenceUrl) && samePage(String((result.result as { url?: string } | null)?.url ?? ""), referenceUrl)) {
        referenceSurveyed = true;
        referenceSheet = result.result as NonNullable<typeof referenceSheet>;
        referenceBrief = buildReferenceBrief(referenceSheet);
      }
      // Taking the page's own markup is the faster and more faithful read of it, so it satisfies the
      // same obligation — and there is then nothing to pin, because the file on disk is the spec. A
      // take that failed opens the hand-built route on top of the survey, so a page that refuses to
      // hand anything over cannot deadlock the run.
      if (result.action.type === "duplicate_page" && Boolean(referenceUrl)
        && samePage(String((result.result as { url?: string } | null)?.url ?? "") || String(result.action.url ?? ""), referenceUrl)) {
        referenceTakeTried = true;
      }
      if (result.ok && result.action.type === "duplicate_page" && referenceTakeTried) {
        referenceSurveyed = true;
        referenceTookPage = true;
        const rebuilt = referencePlanSeeded;
        referenceSheet = null;
        referenceBrief = "";
        if (referencePlanSeeded) referencePlanSeeded = false;
        const taken = result.result as { dir?: string; files?: { path: string }[]; remoteReferences?: number };
        history.push(`[PAGE TAKEN] ${referenceUrl} is in the project as ${String(taken.dir ?? "").trim() || "the copy folder"} (${(taken.files ?? []).map((file) => file.path).join(", ")}). Its markup, its wording, its spacing and its colours are the page's own — nothing about it has to be written by you. Start the server, look at the render once, then use search_replace for exactly what the user named and leave the rest of the file alone. Rebuilding this page section by section now would throw away the copy you just took.${rebuilt ? " The plan you were given was written for the slow route and has been replaced with the four steps this copy needs." : ""}`);
      }
      // The pixel check is the strongest UI evidence there is, so it also clears the
      // "go drive the page yourself" obligation.
      if (result.ok && result.action.type === "compare_to_reference") {
        const measured = (result.result as { fidelity?: FidelitySummary } | null)?.fidelity;
        if (measured && typeof measured.diff === "number") { fidelity = measured; browserNeedsVerification = false; }
      }
      if (result.ok && TOOL_RISK[result.action.type] === "edit") fidelity = null;
      const preview = (result.result as { preview?: { ok?: boolean; healthy?: boolean; issues?: string[]; url?: string } } | null)?.preview;
      if (preview) {
        const wasUnhealthy = previewBroken();
        previewHealth = {
          healthy: preview.ok === true && preview.healthy !== false,
          issues: Array.isArray(preview.issues) ? preview.issues.filter((issue): issue is string => typeof issue === "string" && issue.trim() !== "").slice(0, 12) : [],
          url: typeof preview.url === "string" ? preview.url : "",
        };
        if (wasUnhealthy && previewHealth.healthy) history.push(`[PREVIEW VERIFIED] A fresh browser check of ${previewHealth.url || "the preview"} renders cleanly: no blank page, error overlay, unstyled output, or meaningful console errors. The task may complete while the page stays unchanged.`);
      }
      if (result.ok && TOOL_RISK[result.action.type] === "edit" && previewHealth) {
        // A new edit means the last visual check no longer describes the page.
        previewChecks = 0;
        if (buildInProgress()) {
          // Deferred: the page is still under construction, and a fresh check mid-build is the
          // detour that leaves the build unfinished. Recorded and judged when the plan closes.
          previewStaleMidBuild = true;
        } else if (previewHealth.healthy) {
          previewHealth = { ...previewHealth, healthy: false, issues: ["The page changed after the last visual check, so it needs a fresh check."] };
        }
      }
    }
    // The count survives rounds that went well: the run the user cancelled edited the CSS
    // successfully between failing builds, and clearing on a quiet round meant the repeat never
    // reached the nudge. An error is only behind you when the call that produced it passes.
    for (const [signature, entry] of [...failureRepeats]) {
      if ([...entry.keys].some((key) => succeededKeys.has(key))) {
        failureRepeats.delete(signature);
        if (stuck?.signature === signature) { stuck = null; stuckNote = null; }
      }
    }
    unresolvedFailures = effective.some((result) => !result.ok) || failedCommands.size > 0;
  };
  /**
   * A duplication gets its plan from the reference itself, not from the model's memory of the
   * screenful it happened to open on. One step per surveyed section, in document order, and the plan
   * gate then does what no sentence in the brief could: holds the preview out of bounds and refuses
   * to let the turn close while bands the page actually has are still unwritten.
   */
  const seedReferencePlan = async () => {
    if (referencePlanSeeded) return;
    const titles = referenceTookPage
      ? [
        `Serve the copied page and look at it once, as the user will`,
        `Apply exactly what the user asked to change, with search_replace on the saved files`,
        `Bring the copy's own assets in if it still pulls them from ${(() => { try { return new URL(referenceUrl).hostname; } catch { return "the reference host"; } })()}`,
        `Screenshot the copy against ${referenceUrl} and name the differences left`,
      ]
      : (() => {
        if (!referenceSheet) return [];
        const bands = referenceSheet.sections ?? [];
        const list = bands
          .filter((band: any) => (band?.headings?.length || 0) > 0 || (band?.controls?.length || 0) > 0)
          .slice(0, 10)
          .map((band: any, index: number) => `Section ${index + 1}: ${String(band?.headings?.[0]?.text || band?.tag || "band").slice(0, 64).trim()} — ${band?.heightPx}px tall at y=${band?.topPx}, background ${band?.background}`);
        if (bands.length > list.length) list.push(`Copy the exact wording of the other ${bands.length - list.length} bands the survey listed`);
        return list;
      })();
    // A plan shorter than the one already on the board is normally the model's own, finer breakdown —
    // leave it alone. The four steps a taken page needs are the exception: they replace a band-by-band
    // plan written before the copy arrived, and leaving that plan standing would hold the preview
    // against thirty rounds of work nobody has to do.
    if (!titles.length || (!referenceTookPage && plan.total > 0 && titles.length <= plan.total)) return;
    referencePlanSeeded = true;
    const seeded = await options.execute([({ type: "create_task_list", tasks: titles.map((title) => ({ title, status: "pending" })) }) as unknown as AgentAction]);
    record(seeded);
    if (!plan.total) return;
    history.push(referenceTookPage
      ? `[REFERENCE PLAN] ${referenceUrl} was taken into the project, so the work is four steps, not thirty-five: look at the copy, change only what the user named, localise anything it still fetches from the original host, and compare it against that page. Close each with track_progress. Do not re-write the saved markup into new components — that is the slow route you have already been given the real file for.`
      : `[REFERENCE PLAN] ${referenceSheet?.sectionCount ?? titles.length} bands came back from ${referenceSheet?.url || "the reference page"}, and ${plan.total} build steps were written from them in document order. Build them one at a time and close each with track_progress. documentText in the survey is every word that page shows, in order: put each section's own sentences, nav labels, card copy and footer links in verbatim — a heading you paraphrased is a miss and a band you skipped is a hole in the page. The preview stays out of bounds until the last step closes, so judge the render once, at the end, against the whole survey.`);
  };
  /**
   * Drop whatever the ledger has checked out and take the next chunk of untouched targets.
   * A completion attempt or an idle round is never a stop while the queue has work: the run is
   * handed new targets instead of a countdown, and a target dropped three times is closed as
   * blocked by the ledger itself, so the queue can only ever shrink.
   */
  const claimOut = async () => {
    const cleared = await options.execute([{ type: "next_batch", count: 0 } as unknown as AgentAction]);
    record(cleared);
    options.signal.throwIfAborted();
    const ledger = cleared.find((result) => result.ok)?.result as
      { claimed?: { id: string; label: string }[]; dropped?: { id: string; label: string }[]; closed_as_blocked?: { id: string; label: string }[] } | undefined;
    return { left: batch.queued + batch.running, handed: ledger?.claimed ?? [], dropped: ledger?.dropped ?? [], closed: ledger?.closed_as_blocked ?? [] };
  };
  const claimOutNote = (state: Awaited<ReturnType<typeof claimOut>>) => state.left
    ? `[BATCH NOT FINISHED] ${state.dropped.length ? `The ledger released your claim on ${state.dropped.map((item) => item.id).join(", ")} and` : "The ledger"} handed the next chunk above (${state.handed.map((item) => item.id).join(", ") || "nothing new to hand"}). ${state.left} of ${batch.total} targets are still open — ${batch.done} done, ${batch.blocked} blocked, ${batch.skipped} skipped. Work them one at a time and record each outcome with report_batch: done with the reference the site showed, or blocked with what the page actually said. A target that already went through stays through — never submit the same form twice to earn a receipt. Do not answer with a sentence about stopping, and do not claim the queue is finished.`
    : `[BATCH CLOSED] Every target now has an outcome: ${batch.done} done, ${batch.blocked} blocked, ${batch.skipped} skipped out of ${batch.total}. Complete, and put those exact numbers in the reply — say which targets were not finished and what stopped them, in the plain words of what the page showed.${unreceipted.size ? ` ${unreceipted.size} of the closed targets (${[...unreceipted].join(", ")}) were never backed by a receipt this run read: list them separately as done without confirmation, never inside a count of confirmed ones.` : ""}`;
  const noteServerReady = (results: ToolFeedback[]): void => {
    const verified = results.find((result) => result.ok && ["start_server", "start_dev_server", "check_server"].includes(result.action.type) && (result.result as { ready?: boolean })?.ready === true);
    if (!verified) return;
    const result = verified.result as { url?: string; preview?: { ok?: boolean; healthy?: boolean; issues?: string[]; title?: string; consoleErrors?: string[]; screenshot?: boolean } };
    if (buildInProgress()) {
      // The dev server starting is a milestone, not a verdict. Reading its half-rendered page here
      // is how a run mistakes the scaffold for the finish line and stops.
      history.push(`[SERVER READY] The server ${result.url ? `at ${result.url} ` : ""}is up with ${plan.open.length} planned step(s) still untouched — next is "${plan.open[0]}". Nothing else about the preview matters right now: the page is meant to be incomplete until you have written it. Do not check, screenshot or judge it, and do not fix a blank or unstyled screen that is simply not built yet. Keep writing the remaining steps, and make the one real pass over the rendered page after the plan closes.`);
      return;
    }
    const preview = result.preview;
    const evidence = preview
      ? preview.ok
        ? ` A visible preview was loaded and measured automatically${preview.title ? ` ("${preview.title}")` : ""}: the rendered layout, page text and ${preview.consoleErrors?.length ? `${preview.consoleErrors.length} console error(s)` : "console errors"} are in the tool result${preview.screenshot ? ", with a screenshot" : ""}. ${preview.healthy === false ? `The automatic check FAILED: ${(preview.issues ?? []).slice(0, 5).join("; ") || "the page is blank, unstyled, or erroring"}. Fix the actual rendered page, then call check_preview. Completion is blocked while the preview fails.` : "The automatic check found no fault, but it only measures the DOM — it cannot see whether the page looks designed. Treat it as unfinished until you have looked at the attached screenshot of this render, described what a person would see, and fixed anything below the design bar. Saying the preview passed because this number passed is a false claim."} Use check_preview after UI changes.`
        : " The visible preview did not load, so the UI is not verified. Fix why the page does not load before completing."
      : "";
    history.push(`[SERVER READY] The server ${result.url ? `at ${result.url} ` : ""}is running and responded to an HTTP check.${evidence}${options.finishOnServerReady ? " If the launch goal is achieved and the preview is sound, return status complete with a short confirmation of what you checked." : " Continue the task and verify the UI before declaring it done."}`);
  };
  try {
    if (options.initialActions?.length) {
      // Opening inspection runs through the real tools; the model writes every public update.
      record(await options.execute(options.initialActions));
      await seedReferencePlan();
    }
    for (let step = 0; step < (options.maxSteps ?? 800); step++) {
      options.signal.throwIfAborted();
      const steering = options.getSteering?.() ?? [];
      if (steering.length) history.push(`[USER STEERING]\n${steering.join("\n")}\nUse this latest instruction when choosing the next action.`);
      // Long runs compress their own working memory instead of silently dropping old
      // results. The summary replaces the transcript, then the same task continues.
      const contextChars = toolHistory.reduce((total, entry) => total + entry.detailed.length, 0);
      if (options.compress && contextChars > COMPRESSION_THRESHOLD) {
        options.onCompression?.("compressing");
        const header = `[TASK]\n${options.prompt.slice(0, 8000)}`;
        const notes = history.slice(-3).join("\n\n");
        // Trim the oldest evidence, never the task itself or the freshest notes — otherwise a
        // long run summarises itself into forgetting what it was asked to do.
        const evidence = toolHistory.slice(-24).map((entry) => entry.detailed).join("\n\n").slice(-Math.max(80_000 - header.length - notes.length, 8_000));
        const transcript = [header, evidence, notes].filter(Boolean).join("\n\n");
        let summary = "";
        try { summary = (await options.compress(transcript)).trim(); }
        catch (error) { if (options.signal.aborted) throw error; }
        if (!summary) summary = compressedFallback(options.prompt, actionLedger, inspected, needsVerification, executedActions);
        summary = summary.slice(0, 14_000);
        toolHistory.length = 0;
        toolHistory.push({ detailed: `[COMPRESSED WORKING MEMORY]\n${summary}`, summary: `[COMPRESSED WORKING MEMORY]\n${summary}` });
        history.push("[SESSION COMPRESSED] Earlier steps were summarized below. Continue the SAME task from this state — reuse completed work, do not restart from the beginning, and keep every unresolved failure and next step.");
        options.onCompression?.("compressed", summary);
      }
      const context = toolHistory.map((entry, i) => i < toolHistory.length - 2 ? entry.summary : entry.detailed).join("\n").slice(-CONTEXT_WINDOW);
      const planLine = plan.total && plan.open.length ? `Phase plan: ${plan.total - plan.open.length} of ${plan.total} steps are done; the next unfinished step is "${plan.open[0]}"${plan.open.length > 1 ? ` (${plan.open.length - 1} more after it)` : ""}.` : "";
      const raw = await options.infer(`${options.prompt}\n\n[EXECUTION STATE]\nContinuation ${step + 1}. ${executedActions} actions have already executed. Do not restart the task. ${planLine}Inspected snapshots: ${[...inspected].join(", ").slice(-2000)}. ${needsVerification ? "Changes need verification." : ""}${previewPromptState()}${fidelityPromptState()}${referencePromptState()}${referenceSheetPrompt()}\n[OBSERVED TOOL RESULTS]\n${context}\n${history.slice(-3).join("\n\n")}\nUse the observed results to take the NEXT useful action. For an implementation request, inspection must lead to actual file edits, then verification. Stop only when verified.`, (text) => {
        const message = partialMessage(text);
        if (message !== undefined) options.onMessageDelta?.(message);
      });
      options.signal.throwIfAborted();
      let reply: AgentReply;
      try { reply = parseAgentReply(raw); }
      catch (error) {
        // One unreadable line is a formatting slip, not the end of a task. Keep the run alive
        // and tell the model exactly what broke: an hours-long build must not die because a
        // single reply had an unescaped newline, and a throw would strand the turn mid-work.
        const reason = error instanceof Error ? error.message : "The reply could not be read";
        if (++invalidReplies >= INVALID_REPLY_LIMIT) return { status: "blocked", ...(lastNarration ? { message: lastNarration } : {}), ...carried() };
        history.push(`[RESPONSE FORMAT ERROR] ${reason}. Return exactly one JSON object: message first, then actions, then status. Put every string on one line with newlines written as \\n and quotes escaped, keep file bodies inside a content field, and use only action names from the catalog. No prose, no markdown fences, no half-written object. Then take the next real action.`);
        continue;
      }
      invalidReplies = 0;
      if (reply.message.trim()) lastNarration = reply.message.slice(0, 1200);
      if (reply.actions.length && reply.actions.every((action) => snapshotReads.has(action.type) && inspected.has(JSON.stringify(action)))) {
        const strikes = ++idleRounds;
        history.push(strikes >= 3
          ? `[BUILD NOW] You have re-requested reads that already succeeded. Their results are above and nothing in the workspace has changed since, so more inspection cannot tell you anything new. Using only what you already know, make the requested change now with search_replace, insert_code or write_file, then verify it. If one specific fact is genuinely missing, name it in a single sentence and return status blocked.`
          : "[REPEATED INSPECTION BLOCKED] Those exact reads already succeeded and their results are above. No workspace mutation has occurred since. Do not restart inspection or announce that you are starting again. For an implementation task, create or edit the requested files now using the existing evidence. If information is truly missing, read a different relevant file or explain the concrete blocker.");
        // A run this stuck has to stop, but the model's own last message is the honest
        // thing to show — not a generic provider-blaming error.
        if (strikes >= REPEATED_READ_LIMIT) return { status: "blocked", ...(reply.message.trim() ? { message: reply.message } : {}), ...carried() };
        continue;
      }
      // The brief already tells the model the preview is out of bounds while its plan has steps
      // left, and one that ignores that sentence still lands in the loop the user watched:
      // seventeen rounds of "checking the rendered page again" against a page that is unstyled
      // because it is unfinished. Mid-build the look is taken away rather than asked for.
      const heldWrites = referencePending() ? reply.actions.filter((action) => pageWrites.has(action.type)) : [];
      if (heldWrites.length) {
        referenceHeldRounds += 1;
        reply.actions = reply.actions.filter((action) => !pageWrites.has(action.type));
        history.push(referenceTakeTried
          ? `[REFERENCE UNREAD] ${heldWrites.map((action) => action.type).join(", ")} is out of bounds until the survey of ${referenceUrl} is in. duplicate_page could not bring that page back, so read it yourself: open_browser that address, then call read_page {full:true} — it scrolls the live page to its real bottom, waits for the sections that load on the way, and returns every band with its height, colours, headings, padding, images and buttons. Then build one section at a time from those measurements and copy each band's own wording verbatim. A page written from the first screenful is a page of guesses: the hero you happened to see, plus invented gaps, colours and sizes.`
          : `[REFERENCE UNREAD] ${heldWrites.map((action) => action.type).join(", ")} is out of bounds until ${referenceUrl} is in the project. Call duplicate_page {url:"${referenceUrl}"} — one call writes that page's own markup and its own resolved stylesheet into the project, with its wording, its spacing and its colours intact, and the rest of the run changes only what the user named. Do not survey the page and rebuild it band by band: that is the route that spent twenty minutes retyping a page the site had already handed over, and it is how the wrong spacing and colours got in.`);
        if (referenceHeldRounds >= REFERENCE_HOLD_LIMIT) {
          referenceSurveyed = true;
          history.push(`[REFERENCE UNREACHABLE] ${referenceUrl} has resisted ${referenceHeldRounds} rounds, so the writes are released — build from what you have actually read and say in the reply which parts of that page you never saw. Do not present a page you have not read as its duplicate.`);
        }
        if (!reply.actions.length) continue;
      }
      const heldLooks = buildInProgress() ? reply.actions.filter((action) => previewLooks.has(action.type)) : [];
      if (heldLooks.length) {
        reply.actions = reply.actions.filter((action) => !previewLooks.has(action.type));
        history.push(`[PREVIEW HELD] ${heldLooks.map((action) => action.type).join(", ")} is out of bounds while your plan still has ${plan.open.length} step(s) untouched; the next one is "${plan.open[0]}". A page whose stylesheet has no rules in it is a page you have not written yet, not a page that is broken — the setup that produces the error is the thing to change, and that happens by writing the remaining files. Judge the rendered page once, after the last step is marked done.`);
      }
      if (!reply.actions.length) {
        const steering = options.getSteering?.() ?? [];
        if (steering.length) { history.push(`[USER STEERING]\n${steering.join("\n")}\nHandle this instruction before completing.`); continue; }
        if (reply.status === "blocked") {
          if (batchPending() && reply.message.trim()) {
            // "Blocked" is an outcome for one target, never for the queue. Its claim is released,
            // the next chunk is handed over, and a target dropped three times closes itself — so
            // this path can only end with every target holding an outcome.
            options.onFeedback(reply.message);
            const state = await claimOut();
            history.push(claimOutNote(state));
            idleRounds = 0;
            continue;
          }
          if (reply.message.trim()) options.onPhaseComplete?.(reply.message);
          // Steps it wrote down and never did travel with the stop, so the reply can offer to
          // pick them up rather than leave the run's own plan unfinished in silence.
          return { status: "blocked", message: reply.message, ...carried() };
        }
        // A conversation turn has nothing to execute and nothing to verify, so its first reply IS the
        // answer. Every gate below exists for a work run; pointed at a chat answer they re-asked the
        // model up to IDLE_ROUND_LIMIT times, and the user watched the same list land again and again
        // under a Thinking… header — including when the model's own status token said "continue".
        if (!options.requiresTools && !options.requiresWork && executedActions === 0 && reply.message.trim()) {
          options.onPhaseComplete?.(reply.message);
          return { status: "finished", message: reply.message, ...(reply.plan ? { plan: reply.plan } : {}) };
        }
        const announcesWork = Boolean(reply.plan?.trim()) || /\b(?:I(?:'ll| will)|let me|going to|next I)\b/i.test(reply.message);
        const unprovenServerClaim = reply.status === "complete" && !serverReadyProof && serverProbes < SERVER_PROBE_LIMIT && (serverTaskRequested || claimsLiveServer(reply.message));
        if (reply.status !== "complete" || unprovenServerClaim || unresolvedFailures || needsVerification || (serverNeedsVerification && !serverGateDisarmed) || (browserNeedsVerification && !buildInProgress()) || previewBlocking() || fidelityPending() || batchPending() || (planPending() && !announcesWork) || pendingWorkers.size > 0 || (options.requiresWork && !workDone) || (options.requiresTools && (!executedActions || announcesWork))) {
          if (previewBlocking() && reply.status === "complete") {
            // The model is trying to finish on top of a page that failed its
            // rendered check. Reload it ourselves and re-verify before accepting.
            if (reply.message.trim()) options.onFeedback(reply.message);
            previewChecks += 1;
            const check = await options.execute([{ type: "check_preview" } as AgentAction]);
            record(check);
            options.signal.throwIfAborted();
            if (!previewBroken()) {
              previewChecks = 0;
              history.push("[PREVIEW VERIFIED] A fresh reload of the preview now passes the DOM check. That check cannot see design: before you finish, look at the screenshot attached to this turn and describe what the page actually looks like. Do not claim anything the page does not show, and never report a render as good on the strength of this number.");
              idleRounds = 0;
              continue;
            }
            const problems = previewProblems() || "the page still did not render";
            if (previewChecks > PREVIEW_CHECK_LIMIT) {
              // Enough checks. Rather than end the run, stop letting one dead page hold up
              // the rest of the build and make the final report say what was not verified.
              const attempts = previewChecks;
              previewGateDisarmed = true;
              previewChecks = 0;
              history.push(`[PREVIEW UNVERIFIABLE] ${attempts} fresh reloads still leave the preview failing: ${problems}. Stop re-checking it and stop treating this as the end of the task. Finish every remaining step of the plan first. In the final reply, name this as the one thing that could not be rendered or verified and what was in the way — never claim the page works.`);
              idleRounds = 0;
              continue;
            }
            history.push(`[PREVIEW STILL BROKEN] A fresh reload of the preview still fails verification: ${problems}. Fix the actual page, then call check_preview yourself. ${PREVIEW_CHECK_LIMIT - previewChecks + 1} automatic recheck(s) remain before this check releases and you carry on with the rest of the work.`);
            idleRounds = 0;
            continue;
          }
          if (fidelityArmed() && (fidelity === null || (fidelityMismatch() && reply.status === "complete")) && !previewBlocking()) {
            // The screen the user sent is the specification. A completion claim without a
            // passing pixel comparison re-measures the live page and keeps going.
            if (reply.message.trim()) options.onFeedback(reply.message);
            if (fidelityStuck >= FIDELITY_CHECK_LIMIT) {
              fidelityGateDisarmed = true;
              history.push(`[SCREENSHOT NOT VERIFIABLE] ${fidelityStuck} fresh pixel checks still leave the render differing from the screenshot the user sent (${describeFidelity(fidelity)}). Do not end the run over it: finish the remaining plan work, then report honestly which parts of the screen still differ and how.`);
              idleRounds = 0;
              continue;
            }
            const check = await options.execute([{ type: "compare_to_reference" } as AgentAction]);
            record(check);
            options.signal.throwIfAborted();
            const measured = check.find((item) => item.action.type === "compare_to_reference")?.result as { fidelity?: FidelitySummary } | undefined;
            if (!measured?.fidelity) {
              // No panel, no open page, or the headless runtime: nothing to measure here.
              fidelityEnforced = false;
              history.push("[NO PIXEL COMPARISON] The page could not be measured against the user's screenshot, so this run cannot verify the render visually. Describe honestly what you built instead of claiming it matches.");
            } else if (measured.fidelity.matched) {
              fidelityStuck = 0;
              history.push(`[SCREENSHOT MATCHED] ${fidelityNote(measured.fidelity)}`);
            } else if (!fidelityMismatch()) {
              // Nothing disagrees except the shape of the panel. That is a caveat to tell
              // the user, not a defect to chase, and re-measuring cannot fix it.
              history.push(`[SCREENSHOT PARTLY VERIFIED] ${fidelityNote(measured.fidelity)} Report in your reply that the layout could not be aligned to the screenshot's shape.`);
            } else {
              fidelityStuck += 1;
              history.push(`[SCREENSHOT MISMATCH] ${fidelityNote(measured.fidelity)} ${FIDELITY_CHECK_LIMIT - fidelityStuck} automatic recheck(s) remain before this task is blocked.`);
            }
            idleRounds = 0;
            continue;
          }
          if (batchPending() && reply.status === "complete") {
            // The ledger is the job. Finishing early is not a thing this run gets to decide:
            // its claim is released, the next chunk is handed over, and the work goes on.
            if (reply.message.trim()) options.onFeedback(reply.message);
            const state = await claimOut();
            history.push(claimOutNote(state));
            idleRounds = 0;
            continue;
          }
          if (unprovenServerClaim) {
            // Saying a service is up is not the same as it answering. Probe it before
            // accepting the claim, so a self-closing "listen" never passes for a server.
            serverProbes += 1;
            if (reply.message.trim()) options.onFeedback(reply.message);
            const probe = await options.execute([{ type: "check_server" } as AgentAction]);
            record(probe);
            options.signal.throwIfAborted();
            const alive = probe.find((result) => result.ok && (result.result as { ready?: boolean })?.ready === true);
            if (alive) {
              history.push(`[SERVER PROBED] A live HTTP check confirms ${(alive.result as { url?: string })?.url || "the server"} is answering. Complete only if the rest of the task is really done.`);
              idleRounds = 0;
              continue;
            }
            const port = (options.prompt.match(/(?:port\s*(\d{4,5})|(?:localhost|127\.0\.0\.1):(\d{4,5}))/i) ?? []).filter(Boolean)[1] ?? "";
            history.push(`[SERVER NOT LISTENING] ${port ? `Port ${port} answers nothing right now, so ` : ""}the service this task asked for is not actually running. Opening a socket inside a command that then exits is not a running server. Start it with start_server (or run_background_process) so the process stays alive, confirm it with check_server, then complete.`);
            continue;
          }
          if (reply.message.trim()) options.onPhaseComplete?.(reply.message);
          if (needsVerification && reply.status === "complete" && !verificationAutoRun) {
            // The model insists the edit is done without checking anything. Run the smallest
            // relevant verification ourselves instead of surfacing a canned failure later.
            verificationAutoRun = true;
            const check = await options.execute([{ type: "run_typecheck" } as AgentAction]);
            record(check);
            // Our verification obligation is discharged by running the check; real failures
            // stay tracked in unresolvedFailures so the model still has to address them.
            needsVerification = false;
            history.push(`[AUTO-VERIFY] You declared the change complete without verifying it, so a type check ran: ${check.every((result) => result.ok) ? "it passed" : "it reported problems above"}. Fix real problems, or run a more appropriate check for this project (run_tests/run_build) and then complete.`);
            continue;
          }
          if (planPending()) {
            // This is the endurance rule: a run that wrote a phase plan may not end while the
            // plan still has steps. The failure mode of a big build is stopping at step three.
            if (reply.message.trim()) options.onFeedback(reply.message);
            if (planStuck >= PLAN_GATE_LIMIT) {
              planGaveUp = true;
              history.push(`[PLAN STOPPED SHORT] ${plan.total} steps were written and some are still untouched. End the run now, and in the final reply list which steps were done, which were not, and what stopped them.`);
              idleRounds = 0;
              continue;
            }
            planStuck += 1;
            history.push(`[PLAN HAS STEPS LEFT] ${plan.total - plan.open.length} of ${plan.total} steps are done; still open: ${plan.open.slice(0, 3).map((title) => `"${title}"`).join(", ")}. A build does not finish because a round ended. Do the next step now with real actions, mark it done with track_progress, then take the one after it. If a step is genuinely impossible, track_progress it as blocked, move to the next, and say in the final report what blocked it.`);
            idleRounds = 0;
            continue;
          }
          if (batchPending()) {
            // Not a completion claim, but the round did nothing and the queue is still open.
            // Same rule as above: take the next chunk instead of drifting toward a stop.
            const state = await claimOut();
            history.push(claimOutNote(state));
            idleRounds = 0;
            continue;
          }
          const rounds = ++idleRounds;
          // A round that did nothing but ask something in prose is the agent trying to have a
          // conversation with a chat bubble. With no folder open the one question it keeps
          // asking — "where should this live?" — already has an answer in the tooling: the first
          // create_file of the build raises the approval card, and the user's click decides.
          const askedInProse = reply.actions.length === 0 && /[?]/.test(reply.message);
          const folderNote = "No folder is open, so nothing can be written yet, and a location asked about in prose is a question the user has no way to answer here. Propose it with your next action instead: return a create_file for the project's entry file with its real first contents. The app then shows the user a card asking whether to create that project folder and build there, and nothing is written until they answer. Do not ask where to build again in words.";
          if (rounds >= IDLE_ROUND_LIMIT) {
            // Several explicit continuations in. The agent's own last words are the honest
            // thing to show; what stayed open belongs in the timeline and the journal, never
            // as a canned sentence about the state of the run.
            const standsByReport = reply.status === "complete" && reply.message.trim() !== "" && !needsVerification && !previewBlocking() && !announcesWork && !batchPending() && pendingWorkers.size === 0 && (!options.requiresTools || executedActions > 0) && (!options.requiresWork || workDone);
            return standsByReport
              ? { status: "finished", message: reply.message }
              : { status: "blocked", ...(reply.message.trim() ? { message: reply.message } : {}), ...carried() };
          }
          history.push(`[AGENT UPDATE]\n${reply.message}\n[CONTINUE] No actions were executed. ${unresolvedFailures ? "Previous tools failed — retry, recover, or return status blocked." : previewBlocking() ? `The rendered preview still fails verification: ${previewProblems() || "the page did not render"}. Fix the actual page, then call check_preview before completing.` : browserNeedsVerification && !buildInProgress() ? "Opening a browser is not UI verification. Drive the real page: fill_input the control that matters, click_element the button that acts, wait_for_element for the response, then take_screenshot or inspect_element and read what actually came back. If the change you just made affects this page, exercise it again after the change. A feature that was never used is not verified." : buildInProgress() ? `Your plan still has ${plan.open.length} step(s) untouched and the next one is "${plan.open[0]}". Write that step's real files now — a page half-built is a page worth building, not one worth looking at. Judge the render after the last step.` : pendingWorkers.size ? `Wait for delegated jobs with read_agent or ask_subagent before completing: ${[...pendingWorkers].join(", ")}` : options.needsProjectFolder && !executedActions ? folderNote : options.requiresWork && !workDone ? "This request asks for a real change, and nothing in the workspace has changed yet. A sentence describing the change is not the change itself. Edit the code that actually renders or defines the thing, or run the command that performs the work — deleting an attachment, screenshot, or unrelated image is not a substitute. Then verify and complete." : needsVerification || serverNeedsVerification ? "Verify the latest change or check_server readiness before completing." : askedInProse ? "You asked the user something and left it in the message, where nothing can be answered. Call ask_user {question, options:[...]} with that one question — it renders in their input box, which is where their reply actually comes from — and keep the prose to what you already did. One question, not a list of them." : "Take the first useful action now. For a fully answered question, return status complete."}`);
          continue;
        }
        if (reply.message.trim()) options.onPhaseComplete?.(reply.message);
        return { status: "finished", message: reply.message, ...(reply.plan ? { plan: reply.plan } : {}) };
      }
      if (reply.message.trim()) options.onFeedback(reply.message);
      idleRounds = 0;
      const results = await options.execute(reply.actions);
      record(results);
      await seedReferencePlan();
      // A target closed on a reference no page printed stays closed — sending that application a
      // second time to earn a receipt is how a batch ends up applying twice — but the run is told,
      // once, to go back for the page's own words and to name the gap in its final count.
      for (const doubt of receiptDoubts.splice(0)) {
        unreceipted.add(doubt.id);
        if (receiptNudged.has(doubt.id)) continue;
        receiptNudged.add(doubt.id);
        history.push(`[BATCH RECEIPT UNREAD] ${doubt.id} was closed as done with "${doubt.reference || "nothing"}" — ${doubt.why}. Leave the submission alone and do not send it again; a second submit is a duplicate application, not a receipt. go_back to that confirmation (or read_page where you are) and report_batch the same target done with the reference exactly as that page shows it. If the page cannot be reached again, keep it done and count it in your final reply as applied without its own receipt read — never as a confirmed one.`);
      }
      options.signal.throwIfAborted();

      noteServerReady(results);

      const stuckNow = stuckRound();
      if (stuckNow) {
        if (stuckNow.count >= STUCK_STOP_AT) {
          // Six attempts on one error is not a run in progress. End it on the error, in plain words,
          // rather than spend the rest of the budget on a seventh rewording of the same attempt.
          const message = `It stopped here rather than try the same fix a ${stuckNow.count + 1}th time: "${stuckNow.detail}" came back on every attempt since it first appeared, and nothing after it is verified. Anything written before that is still in the project, and the part that is broken is the setup that produces this error, not the page you asked for.`;
          options.onPhaseComplete?.(message);
          return { status: "blocked", message, ...carried() };
        }
        const marker = `${stuckNow.signature}|${stuckNow.count}`;
        if (stuckNote !== marker) {
          stuckNote = marker;
          history.push(`[SAME ERROR ${stuckNow.count} TIMES] "${stuckNow.detail}" has now come back ${stuckNow.count} separate times, and each round before it said the next edit would settle it. It did not. Repeating the attempt is not a strategy, and a sentence claiming the error is gone is not the error being gone. Do this instead: (1) stop touching the file that keeps failing and read what actually produces the error — its config file, the installed version (read_file package.json, then run_command npm ls <that package>), and the whole output of the command that failed; (2) search the exact error text with web_search or search_documentation and follow what that package's current documentation says, because a toolchain that moved a plugin into its own package is fixed by changing the setup, not by rewriting the page again; (3) re-run the one command that failed, or the one check that came back unhappy, and only then call it fixed. If the setup is not yours to change, return status blocked now and name the error in your reply — the user would rather read that than watch another twenty minutes of the same attempt.`);
        }
      }

      // After executing tools the update closes the turn's thought; it is not a new reply,
      // so it is marked non-final and stays in the timeline rather than under the header.
      options.onPhaseComplete?.(reply.message, false);
      history.push(`[AGENT UPDATE]\n${reply.message.slice(0, 1000)}\nObserve the actual tool results above. Replan after errors. Run only relevant verification and stop when the task is verified.`);
      // A queue built from addresses no page printed is a queue of 404s. Say it once, in the
      // round it happens, before the run burns its whole budget submitting to pages that do not exist.
      if (queueDoubts.length && batchUsed) {
        const invented = [...new Set(queueDoubts.splice(0))].slice(0, 8);
        history.push(`[BATCH TARGET UNSEEN] You queued ${invented.length} target(s) whose address does not appear in anything this run has read: ${invented.join(", ")}. A URL written from memory is not the link on the page, and those addresses will 404. Open the listing with read_page, take the hrefs it actually returns, queue_batch those, and close the invented ones with report_batch skipped and the note "not a link on the page". Follow the link instead of guessing where it goes.`);
      }
    }
    return { status: "limit", ...carried() };
  } catch (error) {
    if (options.signal.aborted) return { status: "stopped" };
    // A throw inside the loop is still not something the user reads. The turn ends on what the
    // agent last said; the failure itself goes to the console, not into the chat.
    console.warn(`[agent loop failed] ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    return { status: "blocked", ...(lastNarration ? { message: lastNarration } : {}), ...carried() };
  }
}
