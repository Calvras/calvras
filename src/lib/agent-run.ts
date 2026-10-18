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
export type AgentOutcome = { status: "finished" | "blocked" | "stopped" | "limit"; message?: string; error?: string; plan?: string };
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
  const fidelityArmed = () => fidelityEnforced && workDone && previewRendered();
  const fidelityPromptState = () => fidelity
    ? (fidelity.matched ? ` The render matches the user's screenshot at ${fidelity.similarity}% similar with the colours and layout in line; read the attached panels before you call it done.` : shapeOnly() ? ` The render was measured against the user's screenshot but the preview panel is a different shape (${fidelity.referenceSize.width}x${fidelity.referenceSize.height} versus ${fidelity.renderedSize.width}x${fidelity.renderedSize.height}), so layout could not be aligned; colours and the picture itself were compared. Say in the reply which part of the screen you could not verify that way.` : ` The render does NOT match the user's screenshot (${fidelity.diff}% different${fidelity.hotspots.length ? `: ${fidelity.hotspots.slice(0, 3).map((item) => `${item.region} ${item.diff}%`).join(", ")}` : ""}) — ${fidelity.reasons.join("; ")}. Fix it and call compare_to_reference; completion is blocked until it passes.`)
    : (fidelityEnforced ? " The screen has not yet been compared pixel-by-pixel with the screenshot the user sent; call compare_to_reference once the page renders." : "");
  const toolHistory: { detailed: string; summary: string }[] = [];
  const actionLedger: string[] = [];
  const pendingWorkers = new Set<string>();
  // Repeated web work ("apply to every posting on this site") lives in .calvras/batch.json.
  // A run that finishes while targets are still queued has not done what was asked, so the
  // ledger's counts gate completion the same way a failing preview does.
  const batch = { total: 0, queued: 0, running: 0, done: 0, blocked: 0, skipped: 0 };
  const BATCH_GATE_LIMIT = 3;
  let batchUsed = false;
  let batchDisarmed = false;
  let batchStuck = 0;
  const batchPending = () => batchUsed && !batchDisarmed && batch.queued + batch.running > 0;
  const inspected = new Set<string>();
  const snapshotReads = new Set(["read_file", "read_package_json", "list_dir", "list_files", "directory_tree", "analyze_project"]);
  // External tools that only observe; they cannot satisfy a change request on their own.
  const observational = new Set(["take_screenshot", "take_screen_screenshot", "inspect_element", "test_responsive_layout", "read_page", "read_page_content", "check_console_errors", "list_windows", "search_documentation", "web_search", "wait_for_element", "wait_for_window", "focus_window"]);
  const record = (results: ToolFeedback[]) => {
    toolHistory.push({ detailed: feedbackContext(results), summary: feedbackContext(results, false) });
    // Actions skipped for runtime reasons (for example no workspace) are guidance
    // for the model, not executed work or real failures. Checked strictly because a tool
    // may legitimately return a count named "skipped" — the batch ledger does exactly that.
    const effective = results.filter((result) => (result.result as { skipped?: boolean } | null)?.skipped !== true);
    executedActions += effective.length;
    for (const result of effective) {
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
          // Any ledger write proves the run is still working the queue, so the gate starts over.
          batchStuck = 0;
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
      const uiProof = ["inspect_element", "take_screenshot", "test_responsive_layout", "fill_input", "click_element", "press_page_key", "upload_file_to_page"];
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
      const raw = await options.infer(`${options.prompt}\n\n[EXECUTION STATE]\nContinuation ${step + 1}. ${executedActions} actions have already executed. Do not restart the task. Inspected snapshots: ${[...inspected].join(", ").slice(-2000)}. ${needsVerification ? "Changes need verification." : ""}${previewPromptState()}${fidelityPromptState()}\n[OBSERVED TOOL RESULTS]\n${context}\n${history.slice(-3).join("\n\n")}\nUse the observed results to take the NEXT useful action. For an implementation request, inspection must lead to actual file edits, then verification. Stop only when verified.`, (text) => {
        const message = partialMessage(text);
        if (message !== undefined) options.onMessageDelta?.(message);
      });
      options.signal.throwIfAborted();
      let reply: AgentReply;
      try { reply = parseAgentReply(raw); }
      catch (error) {
        if (++invalidReplies >= 2) throw error;
        history.push(`[RESPONSE FORMAT ERROR] ${error instanceof Error ? error.message : "Invalid response"}. Return valid JSON with message, actions, and status fields. Escape file content newlines and quotes in JSON strings. Use only supported action names. No markdown or text outside the JSON object.`);
        continue;
      }
      invalidReplies = 0;
      if (reply.actions.length && reply.actions.every((action) => snapshotReads.has(action.type) && inspected.has(JSON.stringify(action)))) {
        const strikes = ++idleRounds;
        history.push(strikes >= 3
          ? `[BUILD NOW] You have re-requested reads that already succeeded. Their results are above and nothing in the workspace has changed since, so more inspection cannot tell you anything new. Using only what you already know, make the requested change now with search_replace, insert_code or write_file, then verify it. If one specific fact is genuinely missing, name it in a single sentence and return status blocked.`
          : "[REPEATED INSPECTION BLOCKED] Those exact reads already succeeded and their results are above. No workspace mutation has occurred since. Do not restart inspection or announce that you are starting again. For an implementation task, create or edit the requested files now using the existing evidence. If information is truly missing, read a different relevant file or explain the concrete blocker.");
        // A run this stuck has to stop, but the model's own last message is the honest
        // thing to show — not a generic provider-blaming error.
        if (strikes >= 8) return { status: "blocked", ...(reply.message.trim() ? { message: reply.message } : {}) };
        continue;
      }
      if (!reply.actions.length) {
        const steering = options.getSteering?.() ?? [];
        if (steering.length) { history.push(`[USER STEERING]\n${steering.join("\n")}\nHandle this instruction before completing.`); continue; }
        if (reply.status === "blocked") {
          if (reply.message.trim()) options.onPhaseComplete?.(reply.message);
          return { status: "blocked", message: reply.message };
        }
        const announcesWork = Boolean(reply.plan?.trim()) || /\b(?:I(?:'ll| will)|let me|going to|next I)\b/i.test(reply.message);
        const unprovenServerClaim = reply.status === "complete" && !serverReadyProof && serverProbes < SERVER_PROBE_LIMIT && (serverTaskRequested || claimsLiveServer(reply.message));
        if (reply.status !== "complete" || unprovenServerClaim || unresolvedFailures || needsVerification || serverNeedsVerification || browserNeedsVerification || previewBroken() || fidelityPending() || batchPending() || pendingWorkers.size > 0 || (options.requiresWork && !workDone) || (options.requiresTools && (!executedActions || announcesWork))) {
          if (previewBroken() && reply.status === "complete") {
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
            if (previewChecks >= PREVIEW_CHECK_LIMIT) {
              if (reply.message.trim()) options.onPhaseComplete?.(reply.message);
              return { status: "blocked", message: reply.message, error: `The rendered preview still fails verification after ${previewChecks} fresh browser checks: ${problems}. Fix the actual page, then retry.` };
            }
            history.push(`[PREVIEW STILL BROKEN] A fresh reload of the preview still fails verification: ${problems}. Fix the actual page, then call check_preview yourself. ${PREVIEW_CHECK_LIMIT - previewChecks} automatic recheck(s) remain before this task is blocked.`);
            idleRounds = 0;
            continue;
          }
          if (fidelityArmed() && (fidelity === null || (fidelityMismatch() && reply.status === "complete")) && !previewBroken()) {
            // The screen the user sent is the specification. A completion claim without a
            // passing pixel comparison re-measures the live page and keeps going.
            if (reply.message.trim()) options.onFeedback(reply.message);
            if (fidelityStuck >= FIDELITY_CHECK_LIMIT) {
              if (reply.message.trim()) options.onPhaseComplete?.(reply.message);
              return { status: "blocked", message: reply.message, error: `The render still differs from the screenshot the user sent after ${fidelityStuck} fresh pixel checks (${describeFidelity(fidelity)}). Edit the code that renders those areas until the comparison passes, then retry.` };
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
            // The ledger is the job. Leaving targets queued is stopping early.
            if (reply.message.trim()) options.onFeedback(reply.message);
            batchStuck += 1;
            const left = batch.queued + batch.running;
            if (batchStuck >= BATCH_GATE_LIMIT) {
              batchDisarmed = true;
              history.push(`[BATCH LEFT OPEN] ${left} of ${batch.total} targets are still unclaimed in the batch ledger. Stop here if you must, but the reply has to say plainly how many you finished (${batch.done} done, ${batch.blocked} blocked, ${batch.skipped} skipped) and that ${left} remain — do not present the run as complete.`);
            } else {
              history.push(`[BATCH NOT FINISHED] ${left} of ${batch.total} targets are still waiting in the batch ledger (${batch.done} done so far). Claim the next chunk with next_batch, work them one at a time, and record each outcome with report_batch — done with the reference the site showed, or blocked with the reason. ${BATCH_GATE_LIMIT - batchStuck} more completion attempt(s) before this run is allowed to stop with targets left.`);
            }
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
          if (++idleRounds >= 2) {
            // After two explicit continuations, trust the model's own report when only failed
            // commands remain — surfacing an expected failure is a valid outcome. Unverified
            // edits, announced-but-undone work and pending workers still abort.
            const standsByReport = reply.status === "complete" && reply.message.trim() !== "" && !needsVerification && !previewBroken() && !announcesWork && !batchPending() && pendingWorkers.size === 0 && (!options.requiresTools || executedActions > 0) && (!options.requiresWork || workDone);
            const stillOpen = [
              unresolvedFailures ? "a tool call is still failing" : "",
              previewBroken() ? "the rendered preview still fails verification" : "",
              needsVerification ? "the latest change has not been checked" : "",
              serverNeedsVerification ? "nothing has confirmed the server is listening" : "",
              browserNeedsVerification ? "the page has not been driven end to end" : "",
              fidelityPending() ? "the screenshot comparison has not been run" : "",
              announcesWork ? "work it announced but did not do" : "",
              batchPending() ? "the batch queue still has targets left" : "",
              pendingWorkers.size ? `${pendingWorkers.size} delegated ${pendingWorkers.size === 1 ? "job" : "jobs"} never came back` : "",
              options.requiresTools && !executedActions ? "no tool ran for a request that needs the workspace" : "",
              options.requiresWork && !workDone ? "nothing in the folder actually changed" : "",
            ].filter(Boolean);
            // The agent's own words stay on screen; what it could not finish is named from the
            // state the loop actually observed, never from a canned sentence about retrying.
            return standsByReport
              ? { status: "finished", message: reply.message }
              : { status: "blocked", message: reply.message, error: stillOpen.length ? `I stopped with this still open: ${stillOpen.join("; ")}.` : "I stopped before this was finished." };
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
      options.signal.throwIfAborted();

      noteServerReady(results);

      // After executing tools the update closes the turn's thought; it is not a new reply,
      // so it is marked non-final and stays in the timeline rather than under the header.
      options.onPhaseComplete?.(reply.message, false);
      history.push(`[AGENT UPDATE]\n${reply.message.slice(0, 1000)}\nObserve the actual tool results above. Replan after errors. Run only relevant verification and stop when the task is verified.`);
    }
    return { status: "limit" };
  } catch (error) {
    if (options.signal.aborted) return { status: "stopped" };
    return { status: "blocked", error: error instanceof Error ? error.message : String(error) };
  }
}
