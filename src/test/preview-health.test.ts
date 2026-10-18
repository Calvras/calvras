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
  overlay: "",
};

describe("preview health", () => {
  it("accepts a rendered page with content, media, and styles", () => {
    expect(evaluatePreviewHealth(healthyPage, [])).toEqual({ healthy: true, issues: [] });
  });

  it("fails a blank page", () => {
    const health = evaluatePreviewHealth({ ...healthyPage, text: "", textLength: 0, visibleElements: 2, richElements: 0, styleTags: 1, stylesheetCount: 1, title: "" }, []);
    expect(health.healthy).toBe(false);
    expect(health.issues.join(" ")).toContain("blank");
  });

  it("fails a page that renders without any styles", () => {
    const health = evaluatePreviewHealth({ ...healthyPage, styleTags: 0, stylesheetLinks: 0, stylesheetCount: 0 }, []);
    expect(health.healthy).toBe(false);
    expect(health.issues.join(" ")).toContain("unstyled");
  });

  it("fails when every linked stylesheet failed to load", () => {
    const health = evaluatePreviewHealth({ ...healthyPage, styleTags: 0, stylesheetLinks: 2, stylesheetCount: 0 }, []);
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
});
