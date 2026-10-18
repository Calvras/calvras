import { describe, expect, it } from "vitest";
import { fileDiff } from "../lib/file-diff";

describe("actual file changes", () => {
  it("preserves context and line numbers around a replacement", () => {
    expect(fileDiff("first\nold\nlast", "first\nnew\nlast")).toEqual([
      { old: 1, cur: 1, type: "ctx", text: "first" },
      { old: 2, type: "del", text: "old" },
      { cur: 2, type: "add", text: "new" },
      { old: 3, cur: 3, type: "ctx", text: "last" },
    ]);
  });
  it("shows a new file as additions", () => {
    expect(fileDiff("", "hello")).toEqual([{ cur: 1, type: "add", text: "hello" }]);
  });
  it("does not invent changes for identical content or Windows line endings", () => {
    expect(fileDiff("first\r\nlast", "first\nlast")).toEqual([]);
  });
});
