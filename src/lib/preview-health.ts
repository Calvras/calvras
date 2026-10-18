/**
 * Decides whether a rendered preview is actually usable. Kept pure so the
 * completion gate in the agent loop is deterministic and testable.
 */

export type PreviewLayout = {
  url?: string;
  title?: string;
  text?: string;
  textLength?: number;
  visibleElements?: number;
  richElements?: number;
  styleTags?: number;
  stylesheetLinks?: number;
  stylesheetCount?: number;
  bodyHeight?: number;
  viewportHeight?: number;
  overlay?: string;
  overlayText?: string;
};

export type PreviewHealth = { healthy: boolean; issues: string[] };

const NOISE = [
  /Download the React DevTools/i,
  /React DevTools.*(?:browser extension|development build)/i,
  /favicon\.ico.*404/i,
  /Failed to load resource.*favicon/i,
  /net::ERR_ABORTED/i,
  /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/i,
  /\[vite\] connect(?:ing|ed)?/i,
  /WebSocket connection to .*failed/i,
  /\[vite\] failed to connect to websocket/i,
  /\[HMR\]/i,
  /\[hmr\]/i,
  /webpack-dev-server.*(?:websocket|client)/i,
  /Next\.js.*Fast Refresh/i,
];

/** Console errors that signal a real defect, not dev-server or extension noise. */
export function meaningfulConsoleErrors(errors: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of errors) {
    const message = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (message.length < 4) continue;
    if (NOISE.some((pattern) => pattern.test(message))) continue;
    const key = message.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(message.slice(0, 500));
    if (result.length >= 12) break;
  }
  return result;
}

export function evaluatePreviewHealth(layout: PreviewLayout | null | undefined, consoleErrors: string[] = []): PreviewHealth {
  const issues: string[] = [];
  if (!layout) {
    return { healthy: false, issues: ["The preview could not be inspected in the browser panel."] };
  }

  const overlay = String(layout.overlay || "").trim();
  if (overlay) {
    const detail = String(layout.overlayText || "").replace(/\s+/g, " ").trim().slice(0, 500);
    issues.push(`The dev server is showing an error overlay (${overlay})${detail ? `: ${detail}` : "."}`);
  }

  const textLength = Number(layout.textLength ?? String(layout.text || "").replace(/\s+/g, " ").trim().length);
  const visibleElements = Number(layout.visibleElements ?? 0);
  const richElements = Number(layout.richElements ?? 0);
  const styleTags = Number(layout.styleTags ?? 0);
  const stylesheetLinks = Number(layout.stylesheetLinks ?? 0);
  const stylesheetCount = Number(layout.stylesheetCount ?? 0);

  const blank = textLength < 12 && visibleElements < 6 && richElements === 0;
  if (blank) issues.push("The page is blank: it has no visible text, media, or interactive elements.");

  const unstyled = !blank && textLength > 40 && visibleElements > 6 && styleTags === 0 && stylesheetLinks === 0;
  if (unstyled) issues.push("The page renders without any stylesheet — the UI is unstyled.");

  const brokenStyles = !unstyled && stylesheetLinks > 0 && stylesheetCount === 0 && styleTags === 0;
  if (brokenStyles) issues.push("Every linked stylesheet failed to load, so the UI is unstyled.");

  for (const error of meaningfulConsoleErrors(consoleErrors)) {
    issues.push(`Console error: ${error}`);
  }

  return { healthy: issues.length === 0, issues: issues.slice(0, 12) };
}
