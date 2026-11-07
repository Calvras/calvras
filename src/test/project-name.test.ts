import { describe, expect, it } from "vitest";
import { projectNameFrom } from "../lib/project-name";

describe("new project folder name", () => {
  it("names the thing being built, not the whole request", () => {
    expect(projectNameFrom("Build a scheduling website with a week view and a form that adds an appointment to it.")).toBe("calvras-scheduling-website");
  });
  it("keeps a name that is already short", () => {
    expect(projectNameFrom("make a portfolio site")).toBe("calvras-portfolio-site");
  });
  it("falls back to a workspace when the request carries no usable words", () => {
    expect(projectNameFrom("build me a ???")).toBe("calvras-workspace");
  });
  it("stays a safe slug", () => {
    expect(projectNameFrom("Créer un Tableau de Bord — 2026!")).toBe("calvras-creer-un-tableau");
  });
});
