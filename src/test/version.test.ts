import { describe, it, expect } from "vitest";
import { parseSemVer, isNewerSemver } from "@/lib/version";

describe("version semver comparison", () => {
  it("correctly parses semver strings with or without v prefix", () => {
    expect(parseSemVer("1.0.0")).toEqual([1, 0, 0]);
    expect(parseSemVer("v10.0.0")).toEqual([10, 0, 0]);
    expect(parseSemVer("v10.1.2")).toEqual([10, 1, 2]);
  });

  it("returns true only when remote release is strictly newer", () => {
    // Newer major, minor, patch
    expect(isNewerSemver("v10.0.1", "10.0.0")).toBe(true);
    expect(isNewerSemver("10.1.0", "10.0.0")).toBe(true);
    expect(isNewerSemver("11.0.0", "10.0.0")).toBe(true);
  });

  it("returns false when current version is equal or newer than remote release", () => {
    // Exact same version (button must not show)
    expect(isNewerSemver("v10.0.0", "10.0.0")).toBe(false);
    expect(isNewerSemver("10.0.0", "10.0.0")).toBe(false);
    // Older remote version (button must not show)
    expect(isNewerSemver("v9.0.0", "10.0.0")).toBe(false);
    expect(isNewerSemver("1.0.0", "10.0.0")).toBe(false);
  });
});
