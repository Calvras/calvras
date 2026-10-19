import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { WindowControls } from "./TitleBar";
import { reportSignIn } from "@/lib/site-session";
import { storedUser, writeStoredUser, type CalvrasUser } from "@/lib/account";

const SPLASH_MS = 2000;

type DesktopBridge = {
  minimize?: () => void;
  maximize?: () => void;
  close?: () => void;
  appVersion?: () => Promise<string>;
  googleSignIn?: () => Promise<GoogleAnswer>;
};

/** Present only in the desktop build, where the window has no frame of its own to lean on. */
const desktopBridge = () => typeof window !== "undefined"
  ? (window as unknown as { __electron?: DesktopBridge }).__electron
  : undefined;

const installedVersion = async () => {
  try { return String((await desktopBridge()?.appVersion?.()) || ""); } catch { return ""; }
};

type GoogleAnswer = { ok?: boolean; email?: string; name?: string; picture?: string; idToken?: string | null; error?: string };

export function SplashScreen() {
  return (
    <div role="status" aria-label="Calvras is starting" className="fixed inset-0 z-[9999] flex items-center justify-center" style={{ background: "var(--background)" }}>
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes calvras-splash-in { 0% { opacity: 0; transform: scale(.86); } 60% { opacity: 1; transform: scale(1.04); } 100% { opacity: 1; transform: scale(1); } }
      ` }} />
      <img src="/calvras-logo.png" alt="Calvras" className="size-24 object-contain" style={{ animation: "calvras-splash-in .7s cubic-bezier(.16,1,.3,1) both" }} />
    </div>
  );
}

export function AuthScreen({ onContinue }: { onContinue: (user: CalvrasUser) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Google opens its own tab. If the person closes that tab instead of finishing, the bridge
  // promise can sit there forever, so Back retires the attempt and the late answer is dropped.
  const attempt = useRef(0);

  const back = () => { attempt.current += 1; setBusy(false); setError(""); };

  const google = async () => {
    const mine = attempt.current + 1;
    attempt.current = mine;
    setError("");
    const bridge = desktopBridge();
    if (!bridge?.googleSignIn) {
      setError("Google sign-in runs in the Calvras desktop app.");
      return;
    }
    setBusy(true);
    const answer: GoogleAnswer = await bridge.googleSignIn().catch((reason) => ({ ok: false, error: reason instanceof Error ? reason.message : String(reason) }));
    if (attempt.current !== mine) return;
    if (!answer?.ok || !answer.email) {
      setBusy(false);
      setError(answer?.error || "Google sign-in failed.");
      return;
    }
    // Tell the site this person signed in, so the owner's console sees them and so a plan the owner
    // granted comes back with them. A site that cannot be reached does not lock anyone out.
    const session = await reportSignIn({ ...(answer.idToken ? { idToken: answer.idToken } : {}), platform: navigator.platform, version: await installedVersion() }).catch(() => ({ ok: false } as const));
    if (attempt.current !== mine) return;
    const plan = session?.ok && session.plan ? session.plan : undefined;
    onContinue({ provider: "google", email: answer.email, name: answer.name ?? answer.email, ...(answer.picture ? { picture: answer.picture } : {}), ...(plan ? { plan } : {}), joinedAt: Date.now() });
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center overflow-y-auto px-5 py-10" style={{ background: "var(--background)" }}>
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes calvras-auth-in { from { opacity: 0; transform: translateY(14px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
      ` }} />
      {/* The overlay sits above the real title bar, so it has to carry its own controls. */}
      {desktopBridge()?.minimize && (
        <div className="absolute inset-x-0 top-0 z-10 flex h-[34px] justify-end pr-1" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
          <div className="flex h-full items-center" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            <WindowControls />
          </div>
        </div>
      )}
      <div className="relative w-full max-w-[400px]" style={{ animation: "calvras-auth-in .6s cubic-bezier(.16,1,.3,1) both" }}>
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/calvras-logo.png" alt="Calvras" className="size-14 object-contain" />
          <h1 className="mt-5 text-[26px] font-medium tracking-tight text-white/92">Welcome to Calvras</h1>
        </div>

        <button
          type="button"
          onClick={() => void google()}
          disabled={busy}
          aria-label="Continue with Google"
          className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-white/[0.12] bg-white/[0.04] px-4 py-3 text-[13px] font-medium text-white/85 transition-colors hover:bg-white/[0.08] disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : (
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M23.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.3h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.55-5.17 3.55-8.66Z" />
              <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.91l-3.88-3c-1.08.72-2.46 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.27v3.09A12 12 0 0 0 12 24Z" />
              <path fill="#FBBC05" d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56V6.63H1.27a12 12 0 0 0 0 10.74l4-3.09Z" />
              <path fill="#EA4335" d="M12 4.75c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.27 6.63l4 3.09C6.22 6.86 8.87 4.75 12 4.75Z" />
            </svg>
          )}
          {busy ? "Signing in…" : "Continue with Google"}
        </button>

        <button
          type="button"
          onClick={back}
          aria-label="Back"
          className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-[12px] text-white/45 transition-colors hover:bg-white/[0.04] hover:text-white/70"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5m7-7-7 7 7 7" /></svg>
          Back
        </button>

        {error && <p role="alert" className="mt-3 text-center text-[11px] text-red-300">{error}</p>}

        <p className="mt-6 text-center text-[10px] leading-5 text-white/25">By continuing you agree to the Calvras <a href="https://calvras.com/terms" target="_blank" rel="noopener noreferrer" className="text-white/45 underline underline-offset-2 hover:text-white/70">terms</a> and <a href="https://calvras.com/privacy" target="_blank" rel="noopener noreferrer" className="text-white/45 underline underline-offset-2 hover:text-white/70">privacy policy</a>.<br />Your projects stay on this computer; Google is only used to identify you.</p>
      </div>
    </div>
  );
}

export function LaunchGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<"splash" | "auth" | "app">("splash");

  useEffect(() => {
    // The logo holding the screen is the check: while it is up the app reads the stored
    // session, so a signed-in person lands in the workspace and nobody else does.
    let launched = false;
    try { launched = Boolean(window.sessionStorage.getItem("calvras_session_started")); } catch { /* storage unavailable */ }
    const enter = () => setPhase(storedUser() ? "app" : "auth");
    if (launched) { enter(); return; }
    const timer = window.setTimeout(() => {
      try { window.sessionStorage.setItem("calvras_session_started", "1"); } catch { /* storage unavailable */ }
      enter();
    }, SPLASH_MS);
    return () => window.clearTimeout(timer);
  }, []);

  if (phase === "splash") return <SplashScreen />;
  if (phase === "auth") {
    return <AuthScreen onContinue={(user) => {
      writeStoredUser(user);
      setPhase("app");
    }} />;
  }
  return <>{children}</>;
}
