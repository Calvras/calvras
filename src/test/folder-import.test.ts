// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { importFolder } from "../lib/folder-import";

vi.mock("node:fs", () => ({ mkdirSync: vi.fn(), mkdtempSync: vi.fn((prefix: string) => `${prefix}test`), writeFileSync: vi.fn(), rmSync: vi.fn() }));

function upload(filename: string) {
  const form = new FormData();
  form.append("name", "sample");
  form.append("files", new Blob(["hello"]), filename);
  return new Request("http://localhost:8080/api/fs/import", { method: "POST", headers: { origin: "http://localhost:8080" }, body: form });
}

describe("folder imports", () => {
  it("imports actual contents under a separate workspace", async () => {
    const response = await importFolder(upload("sample/src/app.txt"));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(fs.writeFileSync).toHaveBeenCalledWith(path.join(data.projectPath, "src", "app.txt"), Buffer.from("hello"));
  });
  it("imports a flat file that arrives without its folder prefix", async () => {
    const response = await importFolder(upload("app.txt"));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(fs.writeFileSync).toHaveBeenCalledWith(path.join(data.projectPath, "app.txt"), Buffer.from("hello"));
  });
  it("rejects paths escaping the workspace", async () => {
    expect((await importFolder(upload("sample/../outside.txt"))).status).toBe(400);
  });
  it("rejects cross-origin uploads", async () => {
    const request = new Request("http://localhost:8080/api/fs/import", { method: "POST", headers: { origin: "https://other.example" } });
    expect((await importFolder(request)).status).toBe(403);
  });
});
