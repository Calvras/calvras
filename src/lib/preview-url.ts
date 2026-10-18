/** Only an HTTP preview served by this machine may be embedded, so a page the agent was
 * redirected to can never point the dock's iframe at someone else's host. */
export function safePreviewUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
