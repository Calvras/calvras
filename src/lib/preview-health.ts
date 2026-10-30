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
  /** CSS rules the browser actually parsed and applied, not the number of tags in the head. */
  cssRules?: number;
  /** Reported to the model as evidence, never gated on: a designed marketing page layers plenty of
   * decorative blocks over each other, so counting overlaps would block real work. */
  overlaps?: number;
  defaultFont?: boolean;
  /** Pressable controls on the page, and how many of them carry any styling of their own. */
  controls?: number;
  designedControls?: number;
  bodyHeight?: number;
  viewportHeight?: number;
  /** Width of the window the page was measured in, and how much of it the content actually paints. */
  viewportWidth?: number;
  contentWidth?: number;
  /** The colour behind everything (body, else html), and the largest surface painted on top of it. */
  backdrop?: string;
  surfaceColor?: string;
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

/** How far apart two painted colours are in perceived brightness, 0..1. Used to tell a
 * deliberate backdrop from an unpainted one: a centered column on a matching canvas is a design,
 * a light page floating in a dark gutter is a bug. */
function brightnessGap(a: string, b: string): number {
  const luminance = (color: string) => {
    const parts = /rgba?\(([^)]+)\)/.exec(color)?.[1]?.split(",") ?? [];
    const channels = parts.slice(0, 3).map((part) => Number.parseFloat(part));
    if (channels.length < 3 || channels.some((channel) => !Number.isFinite(channel))) return null;
    const [r, g, bl] = channels as [number, number, number];
    return (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255;
  };
  const left = luminance(a);
  const right = luminance(b);
  return left === null || right === null ? 0 : Math.abs(left - right);
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
  const cssRules = Number(layout.cssRules ?? 0);
  const defaultFont = layout.defaultFont === true;

  const blank = textLength < 12 && visibleElements < 6 && richElements === 0;
  if (blank) issues.push("The page is blank: it has no visible text, media, or interactive elements.");

  // A style tag or a stylesheet link only proves the file was fetched. These three read what the
  // browser actually applied, which is what catches the case where the CSS loaded and did nothing.
  const unstyled = !blank && cssRules === 0;
  if (unstyled) issues.push("Not one CSS rule is in effect on the page, so it is rendering as raw unstyled markup even though a stylesheet may be listed in the head.");

  const noTypography = !blank && !unstyled && defaultFont;
  if (noTypography) issues.push("The body text is still in the browser's default serif font, so no stylesheet is in charge of the page's typography.");

  // The case the tag count never caught: Tailwind's preflight is live, so CSS is technically in
  // effect and the font is sans-serif, yet not one utility class reached the markup and every
  // button is still the flat transparent box preflight left it in.
  const controls = Number(layout.controls ?? 0);
  const designedControls = Number(layout.designedControls ?? 0);
  const deadControls = !blank && !unstyled && controls >= 3 && designedControls === 0;
  if (deadControls) issues.push(`All ${controls} buttons and fields on the page are still flat, unpadded, transparent boxes — the stylesheet is loading but no design has been applied to a single control.`);

  const brokenStyles = !unstyled && stylesheetLinks > 0 && stylesheetCount === 0 && styleTags === 0;
  if (brokenStyles) issues.push("Every linked stylesheet failed to load, so the UI is unstyled.");

  // The failure a narrow preview panel hides: the page builds a fixed-width column, the root
  // element never paints a backdrop, and on a real window the site is a strip of design with
  // bare colour down both sides.
  const viewportWidth = Number(layout.viewportWidth ?? 0);
  const contentWidth = Number(layout.contentWidth ?? 0);
  const fill = viewportWidth > 0 ? Math.min(1.2, contentWidth / viewportWidth) : 1;
  const gap = brightnessGap(String(layout.backdrop || ""), String(layout.surfaceColor || ""));
  const gutted = !blank && viewportWidth >= 900 && fill < 0.85 && gap > 0.25;
  if (gutted) {
    issues.push(`The content paints only ${Math.round(fill * 100)}% of the ${viewportWidth}px-wide window, and the surface it sits on (${layout.surfaceColor}) is a different brightness from the colour behind it (${layout.backdrop}). On a real browser this reads as a narrow column with unpainted bands down both sides: make the root element carry the page background and let the layout fill the viewport, or give the side bands a backdrop that belongs to the design.`);
  }

  for (const error of meaningfulConsoleErrors(consoleErrors)) {
    issues.push(`Console error: ${error}`);
  }

  return { healthy: issues.length === 0, issues: issues.slice(0, 12) };
}
