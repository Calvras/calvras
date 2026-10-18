import { createElement, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { ArrowLeft, ArrowRight, Globe2, LockKeyhole, RotateCw } from "lucide-react";
import { browserBridge, type BrowserSnapshot } from "@/lib/browser-bridge";

const EMPTY: BrowserSnapshot = { attached: false, ready: false, url: "", title: "", loading: false };

function displayUrl(url: string) {
  return url === "about:blank" ? "" : url;
}

function createWebview(attach: (element: HTMLElement | null) => void, userAgent?: string): ReactElement {
  return createElement("webview", {
    ref: attach,
    src: "about:blank",
    partition: "persist:calvras-browser",
    ...(userAgent ? { useragent: userAgent } : {}),
    style: { width: "100%", height: "100%", border: "0", background: "#ffffff" },
  });
}

/** The page Calvras drives. It lives inside the workspace dock so the file list, the local
 * preview and the live browser share one right-hand surface; the <webview> element itself is
 * never unmounted, so switching tabs cannot throw away a page the agent is mid-task on. */
export function BrowserPanel({ active }: { active: boolean }) {
  const elementRef = useRef<any>(null);
  const [address, setAddress] = useState("");
  const [focused, setFocused] = useState(false);
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState({ back: false, forward: false });
  const snapshot = useSyncExternalStore(browserBridge.subscribe, browserBridge.getSnapshot, () => EMPTY);

  useEffect(() => {
    if (!focused) setAddress(displayUrl(snapshot.url));
    setNotice("");
  }, [snapshot.url, focused]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const sync = () => {
      try { setHistory({ back: element.canGoBack(), forward: element.canGoForward() }); } catch { /* mid-navigation */ }
    };
    const names = ["dom-ready", "did-navigate", "did-navigate-in-page", "did-stop-loading"];
    names.forEach((name) => element.addEventListener(name, sync));
    sync();
    return () => names.forEach((name) => element.removeEventListener(name, sync));
  }, [snapshot.attached]);

  const run = async (operation: () => Promise<unknown>) => {
    setNotice("");
    try { await operation(); } catch (error) { setNotice(error instanceof Error ? error.message : "The browser could not do that."); }
  };

  const submitAddress = () => {
    if (!address.trim() || active) return;
    void run(() => browserBridge.navigate(address));
  };

  const chrome = typeof window !== "undefined" ? (window as any).__electron?.chromeVersion : "";
  const userAgent = chrome
    ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
    : undefined;

  return (
    <>
      <div className="dock-caption" title={snapshot.url}>{snapshot.title && snapshot.url !== "about:blank" ? snapshot.title : snapshot.url ? displayUrl(snapshot.url) : "No page open"}</div>
      <div className="browser-dock-toolbar">
        <button type="button" onClick={() => { if (!active) void run(() => browserBridge.goBack()); }} disabled={active || !history.back} title="Back" aria-label="Back"><ArrowLeft className="size-4" aria-hidden="true" /></button>
        <button type="button" onClick={() => { if (!active) void run(() => browserBridge.goForward()); }} disabled={active || !history.forward} title="Forward" aria-label="Forward"><ArrowRight className="size-4" aria-hidden="true" /></button>
        <button type="button" onClick={() => { const element = elementRef.current; if (element && !active) { setNotice(""); element.reload(); } }} disabled={active || !snapshot.url} title="Reload" aria-label="Reload"><RotateCw className={`size-4 ${snapshot.loading ? "animate-spin" : ""}`} aria-hidden="true" /></button>
        <div className="browser-dock-address">
          <span className={`browser-dock-scheme ${snapshot.url.startsWith("https:") ? "is-secure" : ""}`} aria-hidden="true">
            <LockKeyhole className="size-3" />
          </span>
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(event) => { if (event.key === "Enter") submitAddress(); }}
            placeholder="Search or enter an address"
            aria-label="Browser address"
            disabled={active}
            spellCheck={false}
          />
          <button type="button" onClick={submitAddress} disabled={active || !address.trim()}>Go</button>
        </div>
      </div>
      {notice ? <div className="browser-dock-notice" role="alert">{notice}</div> : null}
      <div className="browser-dock-surface">
        {createWebview((element) => {
          elementRef.current = element;
          browserBridge.attach(element as any);
        }, userAgent)}
        {!snapshot.url || snapshot.url === "about:blank" ? (
          <div className="browser-dock-empty">
            <Globe2 className="size-8" aria-hidden="true" />
            <p>Calvras opens websites here when a task needs the web.</p>
            <span>Leave this panel open to review the page, or close it when the task is done.</span>
          </div>
        ) : null}
        {active ? (
          <div className="browser-dock-lock" role="status" aria-live="polite">
            <div className="browser-dock-lock-pill">
              <span className="is-working" aria-hidden="true" />
              <span>Calvras is using the browser</span>
              <LockKeyhole className="size-3.5" aria-hidden="true" />
            </div>
            <p>Please don't touch the page until the task finishes.</p>
          </div>
        ) : null}
      </div>
    </>
  );
}
