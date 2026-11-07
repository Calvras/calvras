/**
 * A saved page is only a copy if its stylesheet comes with it. Marketing sites load their CSS from a
 * CDN through <link> tags, so the markup alone renders as unstyled text — which is the "rubbish, wrong
 * spacing, wrong colour" a hand-written clone gets blamed for, only here there is nothing to hand-write.
 * These helpers turn the links the page reported into one local file: every url() resolved against the
 * sheet it came from, @import pulled in (once, and never in a circle), and the page's own <style> blocks
 * kept in the order the document had them.
 */
const URL_CALL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
const IMPORT_RULE = /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?[^;]*;/gi;

const absolute = (value: string, base: string) => {
  if (!value || /^(?:data:|blob:|#|about:)/i.test(value)) return value;
  try { return new URL(value, base).href; } catch { return value; }
};

export function absolutizeCssUrls(css: string, base: string): string {
  return css.replace(URL_CALL, (match, double, single, bare) => {
    const value = (double ?? single ?? bare ?? "").trim();
    if (!value) return match;
    return `url("${absolute(value, base)}")`;
  });
}

export function importUrls(css: string, base: string): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(IMPORT_RULE)) {
    const href = absolute(match[1]!, base);
    if (/^https?:/i.test(href)) found.push(href);
  }
  return [...new Set(found)];
}

export function dropImportRules(css: string): string {
  return css.replace(IMPORT_RULE, "");
}

/** One file, in document order, with each sheet's own URLs resolved against its own origin. */
export function buildStylesheet(sheets: { href: string; css: string }[], inlineStyles: string[]): string {
  const parts = sheets.map((sheet) => `/* ${sheet.href} */\n${sheet.css}`);
  inlineStyles.forEach((style, index) => parts.push(`/* inline <style> ${index + 1} */\n${style}`));
  return parts.join("\n\n");
}
