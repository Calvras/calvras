import { useEffect, useRef, useState } from "react";
import { checkForUpdate, type PublishedRelease } from "@/lib/update";

type UpdatePhase = "hidden" | "download" | "downloading" | "restart" | "failed";

// Read per call, not once at import: the bridge only exists in the desktop app, and a test has to
// be able to put one there after this module is loaded.
const desktop = () => (typeof window !== "undefined" ? (window as any).__electron : null);

// Sits in the workspace tools row next to the task icons. The pill only exists once a newer build
// is actually published, and it never claims an update it could not deliver: an unreachable feed
// or a failed download leaves the app alone.
export function UpdatePill() {
  const [phase, setPhase] = useState<UpdatePhase>("hidden");
  const [release, setRelease] = useState<PublishedRelease | null>(null);
  const [percent, setPercent] = useState(0);
  const [installer, setInstaller] = useState("");
  const [error, setError] = useState("");
  // Two clicks in the same tick both read phase "download" before React commits, so a guard that
  // lives outside state is what keeps one press from starting the installer download twice.
  const busy = useRef(false);

  useEffect(() => {
    const bridge = desktop();
    if (!bridge?.appVersion || !bridge?.updateDownload) return;
    let mounted = true;
    const ask = async () => {
      const result = await checkForUpdate(String((await bridge.appVersion()) || "0.0.0"));
      if (!mounted || result.state !== "available") return;
      setRelease(result.release);
      setPhase((current) => (current === "downloading" || current === "restart" ? current : "download"));
    };
    const stopProgress = bridge.onUpdateState?.((state: any) => {
      if (state?.state === "downloading") setPercent(Number(state.percent) || 0);
      if (state?.state === "ready") { setInstaller(String(state.file || "")); setPhase("restart"); }
      if (state?.state === "failed") { setError(String(state.error || "The update could not be downloaded.")); setPhase("failed"); }
    });
    ask();
    const poll = setInterval(ask, 30 * 60 * 1000);
    return () => { mounted = false; clearInterval(poll); stopProgress?.(); };
  }, []);

  if (phase === "hidden" || !release) return null;

  const onClick = async () => {
    const bridge = desktop();
    if (!bridge || busy.current || phase === "downloading") return;
    if (phase === "restart") {
      busy.current = true;
      const result = await bridge.updateInstall(installer);
      busy.current = false;
      if (!result?.ok) { setError(result?.error || "The installer could not start."); setPhase("failed"); }
      return;
    }
    setError("");
    setPercent(0);
    setPhase("downloading");
    busy.current = true;
    const result = await bridge.updateDownload({ url: release.installer, version: release.version });
    busy.current = false;
    if (!result?.ok) { setError(result?.error || "The update could not be downloaded."); setPhase("failed"); }
  };

  const label =
    phase === "downloading" ? (percent > 0 ? `Updating ${percent}%` : "Updating") :
    phase === "restart" ? "Restart" :
    phase === "failed" ? "Try again" : "Update";
  const title =
    phase === "failed" ? error :
    phase === "restart" ? `Calvras ${release.version} is on this computer. Click to close Calvras and install it.` :
    phase === "downloading" ? `Downloading Calvras ${release.version}.` :
    `Calvras ${release.version} is published. Click to download it.`;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={phase === "downloading"}
      title={title}
      aria-label={title}
      className="settings-milk update-pill"
    >
      {label}
    </button>
  );
}
