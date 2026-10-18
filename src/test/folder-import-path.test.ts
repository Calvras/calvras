// @vitest-environment node
// The native picker hands the app a folder path and Calvras works in that folder directly,
// so these run against real temporary trees and assert nothing is copied, moved or deleted.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { importFolderFromPath } from "../lib/folder-import";

function sourceFolder(build: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "calvras-folder-"));
  build(root);
  return root;
}

function pick(source: string) {
  return new Request("http://localhost:8080/api/fs/import-path", {
    method: "POST",
    headers: { origin: "http://localhost:8080", "content-type": "application/json" },
    body: JSON.stringify({ path: source }),
  });
}

describe("opening a folder the user picked natively", () => {
  it("works in the chosen folder instead of copying it", async () => {
    const source = sourceFolder((root) => {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "index.html"), "<h1>me</h1>");
      fs.writeFileSync(path.join(root, "src", "app.ts"), "export const a = 1;");
    });
    const data = await (await importFolderFromPath(pick(source))).json();
    expect(data.ok).toBe(true);
    expect(data.projectPath).toBe(source);
    expect(data.name).toBe(path.basename(source));
    expect(fs.readFileSync(path.join(source, "src", "app.ts"), "utf8")).toBe("export const a = 1;");
  });

  it("still opens a folder that is empty, which is how a new project starts", async () => {
    const source = sourceFolder(() => {});
    const data = await (await importFolderFromPath(pick(source))).json();
    expect(data.ok).toBe(true);
    expect(data.projectPath).toBe(source);
    expect(fs.readdirSync(source)).toEqual([]);
  });

  it("opens a folder far past the old 2,000-file cap", async () => {
    const source = sourceFolder((root) => {
      for (let i = 0; i < 2_100; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), "x");
    });
    const response = await importFolderFromPath(pick(source));
    expect(response.status).toBe(200);
    expect((await response.json()).projectPath).toBe(source);
  });

  it("refuses a path that is not a folder", async () => {
    const source = sourceFolder((root) => fs.writeFileSync(path.join(root, "only.txt"), "x"));
    const response = await importFolderFromPath(pick(path.join(source, "only.txt")));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/not a folder/);
  });

  it("refuses a path that was not spelled out in full", async () => {
    expect((await importFolderFromPath(pick("Desktop/me"))).status).toBe(400);
  });

  it("refuses folders that hold the whole profile rather than one project", async () => {
    for (const tooBroad of [os.homedir(), path.parse(path.resolve(os.homedir())).root, process.env["SystemRoot"] || "C:\\Windows"]) {
      const response = await importFolderFromPath(pick(tooBroad));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/not a whole drive|whole user folder|system folder/);
    }
  });

  it("rejects a cross-origin request", async () => {
    const request = new Request("http://localhost:8080/api/fs/import-path", { method: "POST", headers: { origin: "https://other.example" } });
    expect((await importFolderFromPath(request)).status).toBe(403);
  });
});
