import { describe, expect, it } from "vitest";
import { evaluatePreviewHealth, meaningfulConsoleErrors, type PreviewLayout } from "../lib/preview-health";

const healthyPage: PreviewLayout = {
  url: "http://localhost:5173/",
  title: "Portfolio",
  text: "A calm portfolio for a product designer with selected work and contact details.",
  textLength: 82,
  visibleElements: 34,
  richElements: 6,
  styleTags: 3,
  stylesheetLinks: 0,
  stylesheetCount: 3,
  cssRules: 214,
  overlaps: 0,
  defaultFont: false,
  controls: 6,
  designedControls: 4,
  overlay: "",
};

describe("preview health", () => {
  it("accepts a rendered page with content, media, and styles", () => {
    expect(evaluatePreviewHealth(healthyPage, [])).toEqual({ healthy: true, issues: [] });
  });

  it("fails a blank page", () => {
    const health = evaluatePreviewHealth({ ...healthyPage, text: "", textLength: 0, visibleElements: 2, richElements: 0, styleTags: 1, stylesheetCount: 1, cssRules: 0, title: "" }, []);
    expect(health.healthy).toBe(false);
    expect(health.issues.join(" ")).toContain("blank");
  });

  it("fails a page where no CSS rule is in effect", () => {
    const health = evaluatePreviewHealth({ ...healthyPage, styleTags: 0, stylesheetLinks: 0, stylesheetCount: 0, cssRules: 0 }, []);
    expect(health.healthy).toBe(false);
    expect(health.issues.join(" ")).toContain("unstyled");
  });

  // The scheduling-site failure: Tailwind injected a <style> tag, so the old tag count passed,
  // while the page still rendered as raw serif text with no design applied.
  it("fails a page whose stylesheet loaded but never applied, judged by the browser's default font", () => {
    const health = evaluatePreviewHealth({ ...healthyPage, defaultFont: true }, []);
    expect(health.healthy).toBe(false);
    expect(health.issues.join(" ")).toContain("default serif font");
  });

  // The scheduling-site shape exactly: preflight is applied so the font is sans-serif and rules
  // exist, but no utility class ever reached the markup, leaving every control a flat box.
  it("fails a page whose design system loaded but styled not one control", () => {
    const health = evaluatePreviewHealth({ ...healthyPage, designedControls: 0 }, []);
    expect(health.healthy).toBe(false);
    expect(health.issues.join(" ")).toContain("no design has been applied");
  });

  it("accepts a page with controls but none of them pressable things", () => {
    expect(evaluatePreviewHealth({ ...healthyPage, controls: 2, designedControls: 0 }, []).healthy).toBe(true);
  });

  it("fails when every linked stylesheet failed to load", () => {
    const health = evaluatePreviewHealth({ ...healthyPage, styleTags: 0, stylesheetLinks: 2, stylesheetCount: 0, cssRules: 0 }, []);
    expect(health.healthy).toBe(false);
    expect(health.issues.join(" ")).toContain("stylesheet");
  });

  it("fails when a dev-server error overlay is present", () => {
    const health = evaluatePreviewHealth({ ...healthyPage, overlay: "vite-error-overlay", overlayText: "Failed to resolve import ./missing" }, []);
    expect(health.healthy).toBe(false);
    expect(health.issues.join(" ")).toContain("vite-error-overlay");
    expect(health.issues.join(" ")).toContain("Failed to resolve import");
  });

  it("fails on meaningful console errors but ignores dev noise", () => {
    const noise = [
      "Download the React DevTools for a better development experience: https://react.dev/link/react-devtools",
      "Failed to load resource: the server responded with a status of 404 (Not Found) favicon.ico",
      "[vite] connecting...",
      "net::ERR_ABORTED http://localhost:5173/src/main.tsx",
    ];
    expect(meaningfulConsoleErrors(noise)).toEqual([]);
    const errors = meaningfulConsoleErrors(noise.concat(["Uncaught TypeError: Cannot read properties of undefined (reading 'map')"]));
    expect(errors).toEqual(["Uncaught TypeError: Cannot read properties of undefined (reading 'map')"]);
    const health = evaluatePreviewHealth(healthyPage, errors);
    expect(health.healthy).toBe(false);
    expect(health.issues.join(" ")).toContain("Cannot read properties of undefined");
  });

  it("fails when the preview could not be inspected", () => {
    expect(evaluatePreviewHealth(null, [])).toEqual({ healthy: false, issues: ["The preview could not be inspected in the browser panel."] });
  });

  // The real-browser failure the user photographed: the page is a light column centred in a dark
  // body, so in the narrow panel it looked fine and on a wide window it is a strip with gutters.
  it("fails a page whose content paints only a band of the window on a contrasting backdrop", () => {
    const health = evaluatePreviewHealth({ ...healthyPage, viewportWidth: 1600, contentWidth: 1180, backdrop: "rgb(15, 23, 42)", surfaceColor: "rgb(248, 250, 252)" }, []);
    expect(health.healthy).toBe(false);
    expect(health.issues.join(" ")).toContain("paints only 74%");
    expect(health.issues.join(" ")).toContain("unpainted bands");
  });

  it("accepts the same column when the backdrop is the colour it was designed against", () => {
    expect(evaluatePreviewHealth({ ...healthyPage, viewportWidth: 1600, contentWidth: 1180, backdrop: "rgb(241, 245, 249)", surfaceColor: "rgb(248, 250, 252)" }, []).healthy).toBe(true);
  });

  it("accepts a full-bleed page and a page measured in the narrow panel", () => {
    expect(evaluatePreviewHealth({ ...healthyPage, viewportWidth: 1600, contentWidth: 1600, backdrop: "rgb(15, 23, 42)", surfaceColor: "rgb(248, 250, 252)" }, []).healthy).toBe(true);
    expect(evaluatePreviewHealth({ ...healthyPage, viewportWidth: 700, contentWidth: 520, backdrop: "rgb(15, 23, 42)", surfaceColor: "rgb(248, 250, 252)" }, []).healthy).toBe(true);
  });
});
