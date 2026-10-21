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
  const previewBroken = () => previewHealth !== null && !previewHealth.healthy;
  const previewProblems = () => (previewHealth?.issues ?? []).slice(0, 5).join("; ");
  // A verification gate that has failed its own checks as many times as it is allowed stops
  // holding the rest of a long build hostage: the run finishes the remaining plan steps and
  // says plainly which part it could not verify. Without this, one dead preview port ends a
  // two-hour brief eleven minutes in.
  let previewGateDisarmed = false;
  let fidelityGateDisarmed = false;
  let serverGateDisarmed = false;
  const previewBlocking = () => previewBroken() && !previewGateDisarmed;
  const previewPromptState = () => previewHealth ? (previewHealth.healthy ? " The visible preview passed its last check." : ` The visible preview FAILS verification: ${previewProblems() || "the page did not render"}. Fix it and call check_preview; completion is blocked until it passes.`) : "";
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
  const fidelityArmed = () => fidelityEnforced && !fidelityGateDisarmed && workDone && previewRendered();
  const fidelityPromptState = () => fidelity
    ? (fidelity.matched ? ` The render matches the user's screenshot at ${fidelity.similarity}% similar with the colours and layout in line; read the attached panels before you call it done.` : shapeOnly() ? ` The render was measured against the user's screenshot but the preview panel is a different shape (${fidelity.referenceSize.width}x${fidelity.referenceSize.height} versus ${fidelity.renderedSize.width}x${fidelity.renderedSize.height}), so layout could not be aligned; colours and the picture itself were compared. Say in the reply which part of the screen you could not verify that way.` : ` The render does NOT match the user's screenshot (${fidelity.diff}% different${fidelity.hotspots.length ? `: ${fidelity.hotspots.slice(0, 3).map((item) => `${item.region} ${item.diff}%`).join(", ")}` : ""}) — ${fidelity.reasons.join("; ")}. Fix it and call compare_to_reference; completion is blocked until it passes.`)
    : (fidelityEnforced && !fidelityGateDisarmed ? " The screen has not yet been compared pixel-by-pixel with the screenshot the user sent; call compare_to_reference once the page renders." : "");
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
    for (const result of effective) {
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
        plan.total = taskState.length;
        plan.open = taskState.filter((task) => !["done", "blocked"].includes(String(task.status))).map((task) => String(task.title || "")).filter(Boolean);
        if (plan.open.length) planStuck = 0;
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
      if (result.ok && TOOL_RISK[result.action.type] === "edit" && uiIsOpen) browserNeedsVerification = true;
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
        if (previewHealth.healthy) previewHealth = { ...previewHealth, healthy: false, issues: ["The page changed after the last visual check, so it needs a fresh check."] };
      }
    }
    unresolvedFailures = effective.some((result) => !result.ok) || failedCommands.size > 0;
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
    const preview = result.preview;
    const evidence = preview
      ? preview.ok
        ? ` A visible preview was loaded and checked automatically${preview.title ? ` ("${preview.title}")` : ""}: the rendered layout, page text and ${preview.consoleErrors?.length ? `${preview.consoleErrors.length} console error(s)` : "console errors"} are in the tool result${preview.screenshot ? ", with a screenshot" : ""}. ${preview.healthy === false ? `The automatic check FAILED: ${(preview.issues ?? []).slice(0, 5).join("; ") || "the page is blank, unstyled, or erroring"}. Fix the actual rendered page, then call check_preview. Completion is blocked while the preview fails.` : "The automatic check passed: the page has real content, loads its styles, has no error overlay, and reports no meaningful console errors."} Use check_preview after UI changes.`
        : " The visible preview did not load, so the UI is not verified. Fix why the page does not load before completing."
      : "";
    history.push(`[SERVER READY] The server ${result.url ? `at ${result.url} ` : ""}is running and responded to an HTTP check.${evidence}${options.finishOnServerReady ? " If the launch goal is achieved and the preview is sound, return status complete with a short confirmation of what you checked." : " Continue the task and verify the UI before declaring it done."}`);
  };
  try {
    if (options.initialActions?.length) {
      // Opening inspection runs through the real tools; the model writes every public update.
      record(await options.execute(options.initialActions));
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
      const raw = await options.infer(`${options.prompt}\n\n[EXECUTION STATE]\nContinuation ${step + 1}. ${executedActions} actions have already executed. Do not restart the task. ${planLine}Inspected snapshots: ${[...inspected].join(", ").slice(-2000)}. ${needsVerification ? "Changes need verification." : ""}${previewPromptState()}${fidelityPromptState()}\n[OBSERVED TOOL RESULTS]\n${context}\n${history.slice(-3).join("\n\n")}\nUse the observed results to take the NEXT useful action. For an implementation request, inspection must lead to actual file edits, then verification. Stop only when verified.`, (text) => {
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
        if (reply.status !== "complete" || unprovenServerClaim || unresolvedFailures || needsVerification || (serverNeedsVerification && !serverGateDisarmed) || browserNeedsVerification || previewBlocking() || fidelityPending() || batchPending() || (planPending() && !announcesWork) || pendingWorkers.size > 0 || (options.requiresWork && !workDone) || (options.requiresTools && (!executedActions || announcesWork))) {
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
              history.push("[PREVIEW VERIFIED] A fresh reload of the preview now passes the rendered check. Do not claim anything the page does not show; return status complete with a short, accurate confirmation.");
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
          if (rounds >= IDLE_ROUND_LIMIT) {
            // Several explicit continuations in. The agent's own last words are the honest
            // thing to show; what stayed open belongs in the timeline and the journal, never
            // as a canned sentence about the state of the run.
            const standsByReport = reply.status === "complete" && reply.message.trim() !== "" && !needsVerification && !previewBlocking() && !announcesWork && !batchPending() && pendingWorkers.size === 0 && (!options.requiresTools || executedActions > 0) && (!options.requiresWork || workDone);
            return standsByReport
              ? { status: "finished", message: reply.message }
              : { status: "blocked", ...(reply.message.trim() ? { message: reply.message } : {}), ...carried() };
          }
          history.push(`[AGENT UPDATE]\n${reply.message}\n[CONTINUE] No actions were executed. ${unresolvedFailures ? "Previous tools failed — retry, recover, or return status blocked." : previewBroken() ? `The rendered preview still fails verification: ${previewProblems() || "the page did not render"}. Fix the actual page, then call check_preview before completing.` : browserNeedsVerification ? "Opening a browser is not UI verification. Drive the real page: fill_input the control that matters, click_element the button that acts, wait_for_element for the response, then take_screenshot or inspect_element and read what actually came back. If the change you just made affects this page, exercise it again after the change. A feature that was never used is not verified." : pendingWorkers.size ? `Wait for delegated jobs with read_agent or ask_subagent before completing: ${[...pendingWorkers].join(", ")}` : options.requiresWork && !workDone ? "This request asks for a real change, and nothing in the workspace has changed yet. A sentence describing the change is not the change itself. Edit the code that actually renders or defines the thing, or run the command that performs the work — deleting an attachment, screenshot, or unrelated image is not a substitute. Then verify and complete." : needsVerification || serverNeedsVerification ? "Verify the latest change or check_server readiness before completing." : "Take the first useful action now. For a fully answered question, return status complete."}`);
          continue;
        }
        if (reply.message.trim()) options.onPhaseComplete?.(reply.message);
        return { status: "finished", message: reply.message, ...(reply.plan ? { plan: reply.plan } : {}) };
      }
      if (reply.message.trim()) options.onFeedback(reply.message);
      idleRounds = 0;
      const results = await options.execute(reply.actions);
      record(results);
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
