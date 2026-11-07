import { useState, useEffect, useRef } from "react";

// Window control helpers via Electron IPC bridge
const e = typeof window !== "undefined" ? (window as any).__electron : null;

function MinimizeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
      <path d="M1 5.5h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function MaximizeIcon({ isMax }: { isMax: boolean }) {
  return isMax ? (
    <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
      <rect x="3" y="1" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <path d="M1 3v6a1 1 0 0 0 1 1h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </svg>
  ) : (
    <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
      <rect x="1.5" y="1.5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
      <path d="M1.5 1.5l8 8M9.5 1.5l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// A simple dropdown menu for File / View / Window
function TitleBarMenu({ label, items }: { label: string; items: { label?: string; action?: () => void; separator?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative" style={{ WebkitAppRegion: "no-drag" } as any}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="h-full px-3 text-[12px] font-medium text-white/80 hover:bg-white/10 hover:text-white transition-colors"
      >
        {label}
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-[9999] min-w-[160px] rounded-b-md border border-white/10 bg-[#1a1a1a] shadow-xl py-1"
          onClick={() => setOpen(false)}
        >
          {items.map((item, i) =>
            item.separator ? (
              <div key={i} className="my-1 border-t border-white/10" />
            ) : (
              <button
                key={i}
                onClick={item.action}
                className="w-full text-left px-4 py-1.5 text-[11px] text-white/80 hover:bg-white/10 transition-colors"
              >
                {item.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

export function WindowControls() {
  const [isMax, setIsMax] = useState(false);

  useEffect(() => {
    if (!e) return;
    const sync = async () => setIsMax(await e.isMaximized());
    sync();
    // Poll every 500ms as a fallback (no maximize event on preload bridge)
    const id = setInterval(sync, 500);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      {/* Minimize */}
      <button
        onClick={() => e?.minimize()}
        title="Minimize"
        aria-label="Minimize"
        className="flex h-full w-[38px] items-center justify-center text-white/80 hover:bg-white/10 hover:text-white transition-colors"
      >
        <MinimizeIcon />
      </button>

      {/* Maximize / Restore */}
      <button
        onClick={() => { e?.maximize(); setIsMax((m) => !m); }}
        title={isMax ? "Restore" : "Maximize"}
        aria-label={isMax ? "Restore" : "Maximize"}
        className="flex h-full w-[38px] items-center justify-center text-white/80 hover:bg-white/10 hover:text-white transition-colors"
      >
        <MaximizeIcon isMax={isMax} />
      </button>

      {/* Close */}
      <button
        onClick={() => e?.close()}
        title="Close"
        aria-label="Close"
        className="flex h-full w-[38px] items-center justify-center text-white/80 hover:bg-red-600 hover:text-white transition-colors"
      >
        <CloseIcon />
      </button>
    </>
  );
}

export function TitleBar() {
  const fileItems = [
    { label: "New Chat", action: () => (window as any).__calvrasNewChat?.() },
    { separator: true },
    { label: "Quit", action: () => e?.close() },
  ];

  const viewItems = [
    { label: "Toggle Full Screen", action: () => e?.maximize() },
  ];

  const windowItems = [
    { label: "Minimize", action: () => e?.minimize() },
    { label: "Maximize / Restore", action: () => e?.maximize() },
    { separator: true },
    { label: "Close", action: () => e?.close() },
  ];

  return (
    <div
      data-titlebar=""
      className="fixed top-0 left-0 right-0 z-[100] flex items-center select-none"
      style={{
        height: 34,
        paddingLeft: 8,
        WebkitAppRegion: "drag",
      } as any}
    >
      {/* Left: menus */}
      <div className="flex items-center h-full" style={{ WebkitAppRegion: "no-drag" } as any}>
        <TitleBarMenu label="File" items={fileItems} />
        <TitleBarMenu label="View" items={viewItems} />
        <TitleBarMenu label="Window" items={windowItems} />
      </div>

      {/* Center drag region */}
      <div className="flex-1 h-full" style={{ WebkitAppRegion: "drag" } as any} />

      {/* Right: window controls */}
      <div
        className="flex items-center h-full"
        style={{ WebkitAppRegion: "no-drag" } as any}
      >
        <WindowControls />
      </div>
    </div>
  );
}
