// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runManualTerminal } from "../lib/manual-terminal";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "calvras-terminal-"));
fs.mkdirSync(path.join(root, "src"));

function call(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost:8080/api/terminal/exec", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:8080", ...headers },
    body: JSON.stringify(body),
  });
}

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("manual terminal", () => {
  it("runs a command inside the project folder without approvals", async () => {
    const response = await runManualTerminal(call({ projectPath: root, command: "echo calvras-terminal-ok" }));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.output).toContain("calvras-terminal-ok");
    expect(data.cwd).toBe(".");
  });

  it("runs from a subfolder and reports the relative cwd", async () => {
    const response = await runManualTerminal(call({ projectPath: root, cwd: "src", command: "echo subfolder-ok" }));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.output).toContain("subfolder-ok");
    expect(data.cwd.replaceAll("\\", "/")).toBe("src");
  });

  it("rejects a cwd that leaves the project folder", async () => {
    const response = await runManualTerminal(call({ projectPath: root, cwd: "..", command: "echo nope" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/inside this folder/i);
  });

  it("rejects cross-origin commands", async () => {
    const response = await runManualTerminal(call({ projectPath: root, command: "echo nope" }, { origin: "https://other.example" }));
    expect(response.status).toBe(403);
  });

  it("rejects empty commands, missing folders, and unknown folders", async () => {
    expect((await runManualTerminal(call({ projectPath: root, command: "   " }))).status).toBe(400);
    expect((await runManualTerminal(call({ command: "echo hi" }))).status).toBe(400);
    expect((await runManualTerminal(call({ projectPath: path.join(root, "missing"), command: "echo hi" }))).status).toBe(400);
  });
});
