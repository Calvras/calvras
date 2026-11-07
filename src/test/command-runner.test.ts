// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runCommand, startServer, checkServer, stopServers } from "../lib/command-runner";

let cwd: string;
const node = `"${process.execPath}"`;
beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "calvras-runtime-"));
  await writeFile(path.join(cwd, "server.mjs"), `import http from 'node:http'; const server = http.createServer((req,res) => res.end('ready')); server.listen(0,'127.0.0.1',() => console.log('http://127.0.0.1:'+server.address().port));`);
});
afterEach(async () => { await stopServers(); });
afterAll(async () => {
  if (path.resolve(cwd).startsWith(path.join(tmpdir(), "calvras-runtime-"))) await rm(cwd, { recursive: true, force: true });
});
describe("nonblocking command execution and readiness", () => {
  it("does not pass app hosting ports or provider credentials into project commands", async () => {
    vi.stubEnv("PORT","3344"); vi.stubEnv("OPENROUTER_API_KEY","fixture-private-key");
    try {
      const result=await runCommand(`${node} -e "console.log(JSON.stringify({port:process.env.PORT||null,key:process.env.OPENROUTER_API_KEY||null,path:!!process.env.PATH}))"`,cwd);
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.output.trim())).toEqual({port:null,key:null,path:true});
    } finally { vi.unstubAllEnvs(); }
  });
  it("streams output before the command exits without blocking other work", async () => {
    const chunks: string[] = [];
    let finished = false;
    const command = runCommand(`${node} -e "console.log('first');setTimeout(()=>console.log('last'),500)"`, cwd, { onOutput: (text) => chunks.push(text) }).then((result) => { finished = true; return result; });
    const deadline = Date.now() + 3000;
    while (!chunks.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chunks.join("")).toContain("first");
    expect(finished).toBe(false);
    expect((await command).output).toContain("last");
  });
  it("verifies a real HTTP server and reuses the running process", async () => {
    const started = performance.now();
    const result = await startServer(`${node} server.mjs`, cwd);
    expect(result).toMatchObject({ ok: true, ready: true, running: true });
    expect(performance.now() - started).toBeLessThan(5000);
    expect((await fetch(result.url!)).status).toBe(200);
    expect((await startServer(`${node} server.mjs`, cwd)).pid).toBe(result.pid);
    expect((await checkServer(cwd)).ready).toBe(true);
  });
  it("does not report readiness for a failed server", async () => {
    const result = await startServer(`${node} -e "console.error('failed');process.exit(1)"`, cwd);
    expect(result).toMatchObject({ ok: false, ready: false, running: false });
    expect(result.output).toContain("failed");
  });
  it("cancels a finite command and its child process", async () => {
    const controller = new AbortController();
    const pending = runCommand(`${node} -e "setInterval(()=>console.log('working'),50)"`, cwd, { signal: controller.signal, onOutput: () => controller.abort() });
    expect((await pending).ok).toBe(false);
  });
});
