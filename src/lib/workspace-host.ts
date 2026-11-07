/** Calvras ships as a desktop app, so only the server running on someone's own machine has a
 * workspace to show: loopback for the app window, the LAN ranges the remote-control link hands
 * out, and mDNS names. Every other host is the marketing site, which has no workspace at all. */
export function servesWorkspace(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return host.endsWith(".local");
}

/** On the machine doing the render, the request middleware's context arrives in the loader as
 * `serverContext`. A client-side navigation re-runs the loader in the browser with no server
 * context at all, so the address bar is the authority there. */
export function workspaceHostFrom(loaderContext: unknown) {
  const injected = (loaderContext as { serverContext?: { workspaceHost?: unknown } } | undefined)
    ?.serverContext?.workspaceHost;
  if (typeof injected === "string" && injected !== "") return injected;
  return typeof window === "undefined" ? "" : window.location.hostname;
}
