/** The shape a stopped turn has to expose for its work to be carried on. */
type StoppedTurn = {
  text: string;
  phases: { trace: unknown[]; message?: string | undefined }[];
  openSteps?: string[] | undefined;
};

/**
 * The prompt sent when the user presses "Pick it back up". It continues the stopped run from its
 * own unfinished steps instead of re-sending the original request, which restarted the whole task,
 * and it is never shown as a bubble — the run carries on inside the turn it stopped in, so a fresh
 * user message there would read as the user having asked twice.
 */
export function resumeBrief(message: StoppedTurn, history: { role: string; text: string }[]): string {
  const open = (message.openSteps ?? []).filter((step) => step.trim()).slice(0, 8);
  // The stopped turn carries the agent's own narration, not the ask, so the request has to come
  // from the user messages that led to it.
  const request = [...history].reverse().find((item) => item.role === "user" && item.text.trim())?.text ?? message.text;
  const rounds = message.phases.filter((phase) => phase.trace.length || phase.message?.trim()).length;
  return [
    "Continue the task below inside this same run. Nothing new was asked and nothing is being re-started: do not greet, do not restate the request, and do not redo work already in the project. Check what the files actually hold now, then carry on from the earliest step that is still open.",
    rounds ? `The last run already took ${rounds} round(s) of real work in this turn — their results are your state, so build on them rather than repeating them.` : "",
    open.length
      ? `Steps the last run never finished:\n${open.map((step) => `- ${step}`).join("\n")}\nWrite those remaining steps down again first with plan_tasks, then work them one at a time and close each with track_progress.`
      : "The last run stopped with no steps recorded, so read the current state of the project to work out what is already done, plan the rest with plan_tasks, and continue.",
    request.trim() ? `Original request:\n${request.slice(0, 1500)}` : "",
  ].filter(Boolean).join("\n\n");
}
