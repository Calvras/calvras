import { afterEach, describe, expect, it, vi } from "vitest";
import { playCompletionChimeWhenUnfocused } from "../lib/completion-sound";

afterEach(() => vi.unstubAllGlobals());

function stubAudio() {
  const started: number[] = [];
  class FakeOscillator {
    type = "";
    frequency = { value: 0 };
    connect() {}
    start() { started.push(this.frequency.value); }
    stop() {}
  }
  const context = {
    currentTime: 0,
    destination: {},
    createOscillator: () => new FakeOscillator(),
    createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }),
    close: () => Promise.resolve(),
  };
  vi.stubGlobal("AudioContext", function () { return context; });
  return started;
}

describe("completion chime", () => {
  it("plays a short tone sequence when the app is unfocused and a task settles", () => {
    const started = stubAudio();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    expect(playCompletionChimeWhenUnfocused()).toBe(true);
    expect(started).toHaveLength(3);
  });

  it("stays silent while the user is looking at the app", () => {
    const started = stubAudio();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    expect(playCompletionChimeWhenUnfocused()).toBe(false);
    expect(started).toHaveLength(0);
  });
});
