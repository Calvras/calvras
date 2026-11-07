// Run against a built, running Calvras backend: node scripts/benchmark-agent.mjs [origin]
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const origin = process.argv[2] || "http://127.0.0.1:3344";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-speed-"));
// Transpile the actual agent engine; no alternate implementation in this benchmark.
for (const name of ["agent-run", "agent-context", "streaming", "system-prompt", "tool-catalog"]) {
  const source = await fs.readFile(`src/lib/${name}.ts`, "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/from "\.\/([a-z-]+)"/g, 'from "./$1.mjs"');
  await fs.writeFile(path.join(temp, `${name}.mjs`), code);
}
const { runAgent } = await import(pathToFileURL(path.join(temp, "agent-run.mjs")));
const { readSSE } = await import(pathToFileURL(path.join(temp, "streaming.mjs")));
const { CALVRAS_SYSTEM_PROMPT } = await import(pathToFileURL(path.join(temp, "system-prompt.mjs")));
const results = [];
let commandStreaming;
let sessionId;

async function executeTool(action, onEvent = () => {}) {
  const response = await fetch(`${origin}/api/agent/tools`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, action }), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Tool endpoint returned ${response.status}: ${await response.text()}`);
  let result;
  await readSSE(response, event => {
    onEvent(event);
    if (event.approval) throw new Error(`Unexpected approval in Full mode: ${event.approval.question}`);
    if (event.result) result = event.result;
  });
  if (!result) throw new Error(`Tool ${action.type} returned no result`);
  return result;
}

async function benchmark(prompt, initialActions = []) {
  const started = performance.now();
  let firstTokenMs, firstProgressMs, firstActionMs, firstFeedbackMs, inferenceError;
  const actions = [];
  const controller = new AbortController();
  const outcome = await runAgent({
    prompt,
    signal: controller.signal,
    initialActions,
    requiresTools: initialActions.length > 0,
    finishOnServerReady: initialActions.length > 0,
    infer: async (text, onDelta) => {
      const response = await fetch(`${origin}/api/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "system", content: CALVRAS_SYSTEM_PROMPT }, { role: "user", content: text }], stream: true, max_tokens: 2048 }), signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Inference returned HTTP ${response.status}: ${await response.text()}`);
      let accumulated = "";
      try { await readSSE(response, (event) => {
        if (event.error) throw new Error(event.error.message);
        const delta = event.choices?.[0]?.delta?.content;
        if (delta) { firstTokenMs ??= Math.round(performance.now() - started); accumulated += delta; onDelta?.(accumulated); }
      }); } catch (error) { inferenceError = error.message; throw error; }
      return accumulated;
    },
    onMessageDelta: () => { firstProgressMs ??= Math.round(performance.now() - started); },
    onFeedback: message => { if (message) firstFeedbackMs ??= Math.round(performance.now() - started); },
    execute: async (batch) => {
      const feedback = [];
      for (const action of batch) {
        firstActionMs ??= Math.round(performance.now() - started);
        actions.push(action.type);
        const result = await executeTool(action);
        feedback.push({ action, ok: result.ok, result });
      }
      return feedback;
    },
    maxSteps: 5,
  });
  const result = { prompt, firstActionMs, firstTokenMs, firstProgressMs, firstFeedbackMs, totalMs: Math.round(performance.now() - started), actions, outcome, ...(inferenceError ? { inferenceError } : {}) };
  results.push(result);
  console.log(JSON.stringify(result));
}

// The temporary fixture exits itself so a benchmark never leaves a server behind.
await fs.writeFile(path.join(temp, "server.mjs"), `import http from 'node:http'; const server=http.createServer((req,res)=>res.end('ready')); server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port)); setTimeout(()=>{server.close();process.exit(0)},45000).unref();`);
await fs.writeFile(path.join(temp, "package.json"), JSON.stringify({ name: "speed-test", scripts: { dev: "node server.mjs" }, type: "module" }));
try {
const sessionResponse = await fetch(`${origin}/api/agent/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectPath: temp, mode: "full", task: "Benchmark live progress, command output, and server launch" }) });
const session = await sessionResponse.json();
if (!sessionResponse.ok || !session.ok || !session.id) throw new Error(`Could not create benchmark session: ${JSON.stringify(session)}`);
sessionId = session.id;
await benchmark("hey");
{
  const started = performance.now();
  let firstOutputMs, concurrentReadMs, exitCode;
  const commandResult = await executeTool({ type: "run_command", command: `node -e "console.log('stream started');setTimeout(()=>console.log('finished'),600)"` }, (event) => {
    if (event.output && firstOutputMs === undefined) firstOutputMs = Math.round(performance.now() - started);
    if (event.result) exitCode = event.result.exitCode;
  });
  const commandMs = Math.round(performance.now() - started);
  // A second command stays active while the independent API request completes.
  let markFirstOutput;
  const firstOutput = new Promise(resolve => { markFirstOutput = resolve; });
  const running = executeTool({ type: "run_command", command: `node -e "console.log('running');setTimeout(()=>{},600)"` }, event => { if (event.output) markFirstOutput(); });
  await Promise.race([firstOutput, running]);
  const readStarted = performance.now();
  const concurrentRead = await executeTool({ type: "read_file", path: "package.json" });
  concurrentReadMs = Math.round(performance.now() - readStarted);
  await running;
  commandStreaming = { firstOutputMs, commandMs, concurrentReadMs, exitCode, ok: commandResult.ok && concurrentRead.ok };
  console.log(JSON.stringify({ commandStreaming }));
}
await benchmark("run the server", [{ type: "read_file", path: "package.json" }]);
await benchmark("run the server", [{ type: "read_file", path: "package.json" }]);
await benchmark(`[CONVERSATION HISTORY]\nUser: run the server\nAssistant: ${results.at(-1).outcome.message}\n[CURRENT USER MESSAGE]\nlaunch it`, [{ type: "list_dir", path: "." }]);
await fs.mkdir(".agents/tasks", { recursive: true });
await fs.writeFile(".agents/tasks/agent-speed-results.json", JSON.stringify({ measuredAt: new Date().toISOString(), origin, results, commandStreaming }, null, 2));
} finally {
  if (sessionId) {
    await executeTool({ type: "stop_dev_server" }).catch(error => console.error(`Server cleanup: ${error.message}`));
    await fetch(`${origin}/api/agent/session?id=${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(error => console.error(`Session cleanup: ${error.message}`));
  }
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
