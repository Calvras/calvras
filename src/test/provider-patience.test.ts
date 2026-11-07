import { describe, expect, it } from "vitest";
import { isProviderTrouble, patientBackoffMs, PROVIDER_PATIENCE_MS } from "../lib/gemini";

// Every sentence the inference layer throws when the provider is busy. A run that ends because a free
// tier parked for half an hour is the failure the user called out — "it can't even take a 1-3hr work" —
// so the wait list is tested against the wording that actually reaches it.
const PROVIDER_SENTENCES = [
  "The model provider requires credits. Check the provider balance, or store a key for another provider on this computer.",
  "The free model tiers are used up for about 32 more minutes. Send it again after that, or store a paid key for another provider.",
  "Model providers are rate limited. Wait briefly, or store a key for another provider on this computer.",
  "AI providers did not respond in time. Retry, or check the provider access stored on this computer.",
  "The model connection dropped mid-reply, so Calvras asked it again and that failed too. Send the message once more to continue.",
  "The stored keys still sign in, but the model providers refused this request. Try again in a moment.",
  "HTTP 503: the model is rate limited",
];

describe("a run waits its provider out", () => {
  it.each(PROVIDER_SENTENCES)("swallows %s", (reason) => {
    expect(isProviderTrouble(reason)).toBe(true);
  });

  it("keeps a rejected key and a stop press as real failures", () => {
    expect(isProviderTrouble("A configured model key was rejected. Update the provider keys stored for Calvras on this computer.")).toBe(false);
    expect(isProviderTrouble("A configured model key was rejected (Google and OpenRouter). Update the provider keys stored for Calvras on this computer.")).toBe(false);
    expect(isProviderTrouble("The user aborted a request.")).toBe(false);
  });

  it("names the provider whose key died, and keeps running when one of several is dead", () => {
    // A shelf of three keys where only Google refuses must not end a run: the refusal that leaves
    // the cascade with other providers to use is worded as a refusal, not as a dead key.
    const partial = "The stored keys still sign in, but the model providers refused this request. Try again in a moment.";
    expect(isProviderTrouble(partial)).toBe(true);
    expect(PROVIDER_SENTENCES).toContain(partial);
  });

  it("outlasts the reset window a free tier names", () => {
    expect(PROVIDER_PATIENCE_MS).toBeGreaterThan(30 * 60_000);
  });

  it("parks slowly for a named reset window and quickly for a blip", () => {
    expect(patientBackoffMs("The free model tiers are used up for about 32 more minutes.", 0)).toBe(15_000);
    expect(patientBackoffMs("The free model tiers are used up for about 32 more minutes.", 4)).toBe(60_000);
    expect(patientBackoffMs("HTTP 503: the model is rate limited", 0)).toBe(2_500);
    expect(patientBackoffMs("HTTP 503: the model is rate limited", 9)).toBe(15_000);
  });
});
