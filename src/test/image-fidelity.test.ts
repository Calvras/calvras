import { describe, expect, it } from "vitest";
import {
  FIDELITY_DIFF_LIMIT,
  FIDELITY_PALETTE_LIMIT,
  FIDELITY_STRUCTURE_LIMIT,
  fidelityNote,
  pixelDiffScript,
  summarizeFidelity,
} from "../lib/image-fidelity";

// Numbers arrive from the page as fractions, so the fixtures read the same way.
const raw = (overrides: Record<string, unknown> = {}) => ({
  similarity: 0.99,
  changedShare: 0.01,
  paletteDiff: 0.002,
  structureShare: 0.01,
  referenceWidth: 1440, referenceHeight: 900,
  currentWidth: 1440, currentHeight: 900,
  hotspots: [],
  heatmap: "data:image/png;base64,AAAA",
  ...overrides,
});

describe("screenshot fidelity measurement", () => {
  it("passes when the picture, the colours and the layout all line up", () => {
    expect(summarizeFidelity(raw()).matched).toBe(true);
    expect(summarizeFidelity(raw({ similarity: 1 - FIDELITY_DIFF_LIMIT / 100 })).matched).toBe(true);
    expect(summarizeFidelity(raw({ paletteDiff: FIDELITY_PALETTE_LIMIT / 100 })).matched).toBe(true);
    expect(summarizeFidelity(raw({ structureShare: FIDELITY_STRUCTURE_LIMIT / 100 })).matched).toBe(true);
  });

  it("fails each check on its own and says which one", () => {
    const tooDifferent = summarizeFidelity(raw({ similarity: 0.89 }));
    expect(tooDifferent.matched).toBe(false);
    expect(tooDifferent.diff).toBe(11);
    expect(tooDifferent.reasons).toContain("the picture itself is different");

    const wrongColours = summarizeFidelity(raw({ paletteDiff: 0.03 }));
    expect(wrongColours.matched).toBe(false);
    expect(wrongColours.reasons).toContain("the colours are not the ones in the screenshot");

    const movedLayout = summarizeFidelity(raw({ structureShare: 0.2 }));
    expect(movedLayout.matched).toBe(false);
    expect(movedLayout.reasons).toContain("the layout or content is arranged differently");
  });

  it("only judges layout when both screens are the same shape", () => {
    const summary = summarizeFidelity(raw({ structureShare: 0.4, currentWidth: 800, currentHeight: 1200 }));
    expect(summary.shapeComparable).toBe(false);
    expect(summary.reasons).toContain("the render is a different shape than the screenshot");
    // Same pixels stretched to the same grid score no structure difference at all.
    expect(summarizeFidelity(raw({ currentWidth: 2880, currentHeight: 1800 })).shapeComparable).toBe(true);
  });

  it("keeps the worst regions first and drops unusable input", () => {
    const summary = summarizeFidelity(raw({
      similarity: 0.6,
      hotspots: [{ region: "centre", diff: 33 }, { region: "top-left", diff: 41 }, { region: "junk", diff: Number.NaN }],
    }));
    expect(summary.hotspots.map((item) => item.region)).toEqual(["top-left", "centre"]);
    expect(summarizeFidelity(undefined).similarity).toBe(0);
    expect(summarizeFidelity(undefined).palettePercent).toBe(100);
    expect(summarizeFidelity(undefined).matched).toBe(false);
    expect(summarizeFidelity({}).heatmap).toBeUndefined();
  });

  it("tells the agent what to fix and what to look at when the screens differ", () => {
    const note = fidelityNote(summarizeFidelity(raw({ paletteDiff: 0.04, hotspots: [{ region: "lower-right", diff: 25 }] })));
    expect(note).toContain("is NOT the screen the user sent");
    expect(note).toContain("colours 4% apart");
    expect(note).toContain("lower-right (25% different)");
    expect(note).toContain("compare_to_reference");
    expect(note).toContain("attached panels");

    const pass = fidelityNote(summarizeFidelity(raw({ similarity: 0.99 })));
    expect(pass).toContain("line up with the screen the user sent");
    expect(pass).toContain("Look at the three panels");
  });

  it("embeds both images and the sample grid into the page script", () => {
    const script = pixelDiffScript("data:image/png;base64,REF", "data:image/png;base64,CUR");
    expect(script).toContain("data:image/png;base64,REF");
    expect(script).toContain("data:image/png;base64,CUR");
    expect(script).toContain("getImageData");
    expect(script).toContain("paletteDiff");
    expect(script).toContain("structureShare");
  });
});
