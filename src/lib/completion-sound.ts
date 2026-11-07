import { readPreferences } from "./preferences";

/** Plays a short completion chime when the app is unfocused and a task reaches a terminal state. */
export function playCompletionChimeWhenUnfocused(): boolean {
  try {
    if (typeof window === "undefined" || typeof document === "undefined") return false;
    if (!readPreferences().completionSound) return false;
    if (document.hasFocus() && !document.hidden) return false;
    const AudioCtx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return false;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = now + index * 0.1;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.55);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.6);
    });
    window.setTimeout(() => void ctx.close().catch(() => undefined), 1500);
    return true;
  } catch {
    return false;
  }
}
