// Drives six hard senior-engineering tasks through the real Electron app.
// Usage: node scripts/hard-tasks-electron.mjs <taskId>   (ids: provider-chat, sse-streaming, race-bugfix, sqlite-crud, jwt-auth, prod-readiness)
import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RUN_TIMEOUT = Number(process.env.RUN_TIMEOUT || 8 * 60_000);
const ARTIFACTS = ".agents/artifacts/hard-tasks";

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: process.platform === "win32" });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => resolve({ code, out }));
  });
}

const wav = () => {
  const rate = 8000, seconds = 1, data = Buffer.alloc(rate * seconds * 2);
  for (let i = 0; i < data.length / 2; i++) data.writeInt16LE(Math.round(Math.sin(i / 12) * 6000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

// A stand-in for the user's own AI service: key-gated chat completion plus speech synthesis.
function startProvider(key) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const auth = req.headers["authorization"] || "";
      if (!auth.includes(key)) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "invalid api key" } })); return; }
      if (req.url === "/v1/models") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "tiny-chat" }, { id: "tiny-tts" }] })); return; }
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (req.url === "/v1/chat/completions") {
          const last = (JSON.parse(body || "{}").messages || []).filter((m) => m.role === "user").pop();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `reply to: ${String(last?.content || "").slice(0, 60)}` } }] }));
          return;
        }
        if (req.url === "/v1/audio/speech") { res.writeHead(200, { "Content-Type": "audio/wav" }); res.end(wav()); return; }
        res.writeHead(404).end("not found");
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function readAll(root, names) {
  const out = [];
  for (const name of names) out.push(await fs.readFile(path.join(root, name), "utf8").catch(() => ""));
  return out.join("\n");
}

const TASKS = {
  "provider-chat": {
    port: 0,
    async fixture(root, ctx) {
      await fs.writeFile(path.join(root, "README.md"), "# Pocket Chat\n\nEmpty app. Node 24, no dependencies.\n");
      return `I am building my own AI product and this is the API key for the model I made: ${ctx.providerKey}. My model server is already running at http://127.0.0.1:${ctx.providerPort}. It is OpenAI-compatible: POST /v1/chat/completions returns {"choices":[{"message":{"content":"..."}}]} and it needs the header "Authorization: Bearer <key>". POST /v1/audio/speech returns audio/wav for text-to-speech, and GET /v1/models lists live model ids.
Build pocket chat here: server.mjs on port 4131 that proxies chat and speech to my provider using the key kept in .env.local (never hardcode the key in browser code), plus public/index.html with a message input, a send button that renders the assistant reply into the page, and a Speak button that plays the returned audio. Store the key with manage_environment_variables, probe the key against the provider before writing the integration, use the real model ids from /v1/models, then start the server and prove the feature in the browser panel: open the page, type a message into the input, click send, screenshot the reply, and check the browser console for errors. Work through all of it automatically.`;
    },
    async verify(root, ctx) {
      const checks = [];
      const code = await readAll(root, ["server.mjs", "index.html", "public/index.html", "app.js", "public/app.js"]);
      checks.push(["server proxies chat completions", /\/v1\/chat\/completions/.test(code)]);
      checks.push(["key kept out of browser code", !code.includes(ctx.providerKey)]);
      checks.push(["reads key from env", /process\.env\.[A-Z_]*(KEY|SECRET)/i.test(code)]);
      checks.push(["text to speech wired", /\/v1\/audio\/speech|audio\/wav/i.test(code)]);
      checks.push(["server listens on 4131", /4131/.test(code)]);
      const env = await fs.readFile(path.join(root, ".env.local"), "utf8").catch(() => "");
      checks.push([".env.local holds the key", env.includes(ctx.providerKey)]);
      // Independent probe: the generated app must be reachable on the port it was given.
      let live = { ok: false, speak: false };
      try {
        const page = await fetch("http://127.0.0.1:4131/").then((r) => r.text());
        live = { ok: /<(input|textarea)/i.test(page) && /<button/i.test(page), speak: /speak|speech|audio/i.test(page) };
      } catch { /* dev server not running */ }
      checks.push([`app served on 4131 with an input and buttons (${live.ok})`, live.ok && live.speak]);
      return checks;
    },
  },
  "sse-streaming": {
    port: 4132,
    async fixture(root) {
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "streamer", type: "module", scripts: { dev: "node server.mjs", test: "node --test" } }, null, 2));
      return `This empty Node project must stream a completion token by token. Implement server.mjs on port 4132: GET /stream?text=hello responds with text/event-stream and emits one data: frame per word, ending with data: [DONE]. GET / serves index.html whose JavaScript reads the stream with fetch + ReadableStream and appends each word into #output as it arrives, with no polling and no library. Export the request handler so node:test can import it without listening, and add stream.test.mjs that starts the server on an ephemeral port, consumes /stream, and asserts the frames arrive in order and end with [DONE]. Keep the scripts field working: npm test and npm run dev. Run the tests, start the dev server, open the page in the browser panel and screenshot the streamed output.`;
    },
    async verify(root) {
      const checks = [];
      const code = await readAll(root, ["server.mjs", "index.html", "stream.test.mjs"]);
      checks.push(["uses text/event-stream", /text\/event-stream/.test(code)]);
      checks.push(["client uses ReadableStream", /getReader\(\)|ReadableStream|TextDecoder/.test(code)]);
      const test = await run("npm", ["test"], root);
      checks.push(["generated tests pass", test.code === 0]);
      // Independent probe of the real endpoint.
      let frames = 0, done = false, streamOk = false;
      try {
        const response = await fetch("http://127.0.0.1:4132/stream?text=alpha beta gamma");
        const reader = response.body.getReader(); const decoder = new TextDecoder();
        let buffer = "";
        for (;;) { const { value, done: fin } = await reader.read(); if (fin) break; buffer += decoder.decode(value, { stream: true }); }
        frames = (buffer.match(/^data:/gm) || []).length; done = buffer.includes("[DONE]"); streamOk = true;
      } catch { /* dev server not up */ }
      checks.push([`live stream delivered ${frames} frames`, streamOk && frames >= 4 && done]);
      return checks;
    },
  },
  "race-bugfix": {
    port: 0,
    async fixture(root) {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "cache-fix", type: "module", scripts: { test: "node --test" }, engines: { node: ">=20" } }, null, 2));
      // Deliberately broken: a shared in-flight map keyed by resource, so a second
      // distinct request for the same resource receives the first caller's payload,
      // and the entry is deleted by whoever finishes first.
      await fs.writeFile(path.join(root, "src/cache.mjs"), `// SENTINEL: keep this file's public API exactly as it is.
const inflight = new Map();
export async function load(resource, fetcher) {
  const cached = load.cache.get(resource);
  if (cached && Date.now() - cached.at < 50) return cached.value;
  let pending = inflight.get("shared");
  if (!pending) {
    pending = fetcher(resource).then((value) => {
      load.cache.set(resource, { at: Date.now(), value });
      inflight.delete("shared");
      return value;
    });
    inflight.set("shared", pending);
  }
  return pending;
}
load.cache = new Map();
`);
      await fs.writeFile(path.join(root, "src/cache.test.mjs"), `import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./cache.mjs";

test("concurrent loads resolve each resource with its own value", async () => {
  const calls = [];
  const fetcher = (resource) => { calls.push(resource); return new Promise((resolve) => setTimeout(() => resolve(\`value:\${resource}\`), 20)); };
  const [a, b] = await Promise.all([load("alpha", fetcher), load("beta", fetcher)]);
  assert.equal(a, "value:alpha");
  assert.equal(b, "value:beta");
  assert.deepEqual(calls.sort(), ["alpha", "beta"]);
});

test("expired entries are refetched", async () => {
  let n = 0;
  const fetcher = async () => ++n;
  await load("counter", fetcher);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(await load("counter", fetcher), 2);
});
`);
      return `src/cache.mjs in this project has a real concurrency bug: two simultaneous load() calls for different resources receive the same payload, and the second test sometimes refetches wrongly. Reproduce it by running npm test first, explain the root cause in one sentence, then fix src/cache.mjs with a targeted edit (search_replace, not a rewrite) while keeping the exported API and the SENTINEL comment intact. Confirm npm test is green afterwards.`;
    },
    async verify(root) {
      const checks = [];
      const source = await fs.readFile(path.join(root, "src/cache.mjs"), "utf8").catch(() => "");
      checks.push(["public API intact", /export async function load\(/.test(source)]);
      checks.push(["sentinel comment preserved", /SENTINEL/.test(source)]);
      checks.push(["in-flight keyed per resource", !inflightShared(source)]);
      const test = await run("npm", ["test"], root);
      checks.push(["npm test green", test.code === 0]);
      checks.push([`test output: ${test.out.split("\n").filter((l) => /fail |pass /.test(l)).join(" | ").slice(0, 160)}`, true]);
      return checks;
    },
  },
  "sqlite-crud": {
    port: 4134,
    async fixture(root) {
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "roster", type: "module", scripts: { dev: "node server.mjs", test: "node --test" } }, null, 2));
      return `Build a users roster API in this empty Node project using only Node built-ins, with node:sqlite for storage (database file roster.db, table users with id, email unique, name, created_at). server.mjs listens on port 4134 and exports the handler so tests can import it without listening. POST /users creates a user (reject a missing or malformed email with 400 and a duplicate email with 409), GET /users lists them, GET /users/:id returns one or 404, DELETE /users/:id removes one. Use a prepared statement for every query, never string interpolation. Export each route handler so node:test can import it without listening, and add server.test.mjs that boots the server on an ephemeral port, then runs a full CRUD cycle with real HTTP requests, including the 400, the duplicate 409, and the 404 cases. npm test and npm run dev must both work. Run the tests, start the server, and prove POST plus GET with the terminal tools.`;
    },
    async verify(root) {
      const checks = [];
      const source = await readAll(root, ["server.mjs", "server.test.mjs", "src/server.mjs", "src/server.test.mjs"]);
      checks.push(["uses node:sqlite", /node:sqlite/.test(source)]);
      checks.push(["prepared statements", /\.prepare\(/.test(source) && !/SELECT \* FROM users WHERE email = '\$\{/.test(source)]);
      const test = await run("npm", ["test"], root);
      checks.push(["generated tests pass", test.code === 0]);
      let live = { ok: false };
      try {
        const email = `probe-${Date.now()}@example.com`;
        const create = await fetch("http://127.0.0.1:4134/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, name: "Probe" }) });
        const again = await fetch("http://127.0.0.1:4134/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, name: "Probe" }) });
        const bad = await fetch("http://127.0.0.1:4134/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "not-an-email" }) });
        const list = await fetch("http://127.0.0.1:4134/users").then((r) => r.json()).catch(() => null);
        live = { ok: create.status === 200 || create.status === 201, conflict: again.status === 409, invalid: bad.status === 400, listed: Array.isArray(list?.users || list) && (list.users || list).some((u) => u.email === email) };
      } catch { /* server not running */ }
      checks.push([`live API: create=${live.ok} duplicate=${live.conflict} invalid=${live.invalid} list=${live.listed}`, live.ok && live.conflict && live.invalid && live.listed]);
      return checks;
    },
  },
  "jwt-auth": {
    port: 4135,
    async fixture(root) {
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "auth", type: "module", scripts: { dev: "node server.mjs", test: "node --test" } }, null, 2));
      return `Implement token auth in this empty Node project with no third-party libraries. server.mjs listens on port 4135 and exports the handler so tests import it without listening. POST /login accepts {"email":"dev@example.com","password":"hunter2"} and returns {"token":"<header>.<payload>.<signature>"} where the payload is base64url JSON with sub, iat and exp (60 seconds), signed with HS256 using node:crypto createHmac against the secret in SECRET env (default "fixture-secret"). GET /me returns the token subject only when Authorization: Bearer <token> verifies, and 401 otherwise, 401 for a tampered signature, and 401 once exp has passed. GET /refresh issues a fresh token from a valid one. Write the sign/verify helpers in auth.mjs and auth.test.mjs covering a valid token, a wrong secret, a modified payload, and an expired token. npm test and npm run dev must work. Run the tests and start the server, then prove /login and /me over real HTTP from the terminal.`;
    },
    async verify(root) {
      const checks = [];
      const source = await readAll(root, ["auth.mjs", "server.mjs", "auth.test.mjs", "src/auth.mjs"]);
      checks.push(["uses createHmac", /createHmac\(["']sha256/.test(source)]);
      checks.push(["base64url encoding", /base64url|replace\(/.test(source)]);
      checks.push(["rejects tampered tokens", /timingSafeEqual|sign/i.test(source)]);
      const test = await run("npm", ["test"], root);
      checks.push(["generated tests pass", test.code === 0]);
      let live = { ok: false };
      try {
        const login = await fetch("http://127.0.0.1:4135/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dev@example.com", password: "hunter2" }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
        const token = login.body?.token || "";
        const me = await fetch("http://127.0.0.1:4135/me", { headers: { authorization: `Bearer ${token}` } });
        const forged = await fetch("http://127.0.0.1:4135/me", { headers: { authorization: `Bearer ${token.split(".")[0]}.${Buffer.from(JSON.stringify({ sub: "admin", iat: 0, exp: 9999999999 })).toString("base64url")}.deadbeef` } });
        const anon = await fetch("http://127.0.0.1:4135/me");
        live = { ok: login.status === 200 && token.split(".").length === 3, accepted: me.status === 200, forgedRejected: forged.status === 401, anonRejected: anon.status === 401 };
      } catch { /* server not running */ }
      checks.push([`live auth: login=${live.ok} me=${live.accepted} forged=${live.forgedRejected} anon=${live.anonRejected}`, live.ok && live.accepted && live.forgedRejected && live.anonRejected]);
      return checks;
    },
  },
  "prod-readiness": {
    port: 4136,
    async fixture(root) {
      await fs.mkdir(path.join(root, "public"), { recursive: true });
      await fs.writeFile(path.join(root, "server.mjs"), `import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
const server = createServer(async (req, res) => {
  if (req.url === "/api/status") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); return; }
  const body = await readFile(path.join(import.meta.dirname, "public", "index.html"));
  res.writeHead(200, { "content-type": "text/html" }); res.end(body);
});
server.listen(Number(process.env.PORT || 4136), "127.0.0.1", () => console.log("ready"));
`);
      await fs.writeFile(path.join(root, "public/index.html"), "<!doctype html><title>Service</title><h1>Calvras demo service</h1>");
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo-service", type: "module", scripts: { start: "node server.mjs" }, engines: { node: ">=20" } }, null, 2));
      return `Prepare this Node service for production publishing. Add a Dockerfile (multi-stage is unnecessary, but it must be distroless or slim, non-root via an explicit USER, declare NODE_ENV=production, EXPOSE 4136, HEALTHCHECK against the status route, and use an ENTRYPOINT that runs the service), a matching .dockerignore, and a compose.yaml with a health check and restart policy. Make the server respect the PORT environment variable and exit cleanly on SIGTERM so an orchestrator can drain it, and add a /healthz route that reports process uptime. Add build.mjs that copies the runtime files into dist/ and a "build" script; npm run build must produce dist. Prove the service still answers on port 4136 after your changes by starting it and checking both /healthz and /api/status.`;
    },
    async verify(root) {
      const checks = [];
      const docker = await fs.readFile(path.join(root, "Dockerfile"), "utf8").catch(() => "");
      checks.push(["Dockerfile exists", docker.length > 0]);
      checks.push(["runs non-root", /^USER\s+(?!root)\S+/m.test(docker)]);
      checks.push(["healthcheck declared", /HEALTHCHECK/.test(docker)]);
      checks.push(["exposes 4136", /EXPOSE\s+4136/.test(docker)]);
      checks.push(["production env", /NODE_ENV=production/.test(docker)]);
      const compose = await fs.readFile(path.join(root, "compose.yaml"), "utf8").catch(() => "");
      checks.push(["compose health + restart", /healthcheck/i.test(compose) && /restart:/i.test(compose)]);
      checks.push(["dockerignore", (await fs.readFile(path.join(root, ".dockerignore"), "utf8").catch(() => "")).includes("node_modules")]);
      const build = await run("npm", ["run", "build"], root);
      const dist = await fs.readdir(path.join(root, "dist")).catch(() => []);
      checks.push([`npm run build produced dist (${build.code})`, build.code === 0 && dist.length > 0]);
      const source = await readAll(root, ["server.mjs"]);
      checks.push(["handles SIGTERM", /SIGTERM/.test(source)]);
      let live = { ok: false };
      try {
        const health = await fetch("http://127.0.0.1:4136/healthz").then((r) => r.json()).catch(() => null);
        const status = await fetch("http://127.0.0.1:4136/api/status").then((r) => r.json()).catch(() => null);
        live = { ok: Boolean(health) && Boolean(health?.uptime !== undefined || health?.ok), status: status?.ok === true };
      } catch { /* not running */ }
      checks.push([`live /healthz=${live.ok} /api/status=${live.status}`, live.ok && live.status]);
      return checks;
    },
  },
};

function inflightShared(source) { return /inflight\.(get|set)\(\s*["']shared["']/.test(source); }

async function main() {
  const id = process.argv[2];
  const task = TASKS[id];
  if (!task) { console.error(`Unknown task. Choose: ${Object.keys(TASKS).join(", ")}`); process.exit(2); }
  await fs.mkdir(ARTIFACTS, { recursive: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `calvras-hard-${id}-`));
  const providerKey = `sk-fixture-${Math.random().toString(36).slice(2, 10)}`;
  const provider = await startProvider(providerKey);
  const ctx = { root, providerKey, providerPort: provider.address().port, appPort: 0, sessionId: "" };
  const prompt = await task.fixture(root, ctx);

  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 60_000 });
  const report = { task: id, root, checks: [], error: "", finishedAt: "" };
  let page;
  try {
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    ctx.appPort = Number(new URL(page.url()).port);
    await page.evaluate(({ root }) => {
      localStorage.setItem("calvras_projects", JSON.stringify([{ name: "Hard task", path: root }]));
      localStorage.setItem("calvras_active_project", JSON.stringify({ name: "Hard task", path: root }));
      localStorage.setItem("calvras_access_mode", "full");
      localStorage.removeItem("calvras_chat_messages");
    }, { root });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Open prompt input" }).click().catch(() => {});
    await page.getByRole("textbox", { name: "Prompt" }).fill(prompt);
    const started = Date.now();
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    await page.getByRole("button", { name: "Stop task", exact: true }).waitFor({ timeout: 30_000 }).catch(() => {});
    await page.getByRole("button", { name: "Stop task", exact: true }).waitFor({ state: "detached", timeout: RUN_TIMEOUT });
    const conversation = await page.getByLabel("Conversation", { exact: true }).innerText();
    report.elapsedMs = Date.now() - started;
    report.finishedAt = new Date().toISOString();
    report.conversationTail = conversation.slice(-7000);
    report.trace = {
      probe_key: /probe_key|probe key/i.test(conversation),
      env_store: /manage_environment_variables|manage environment variables/i.test(conversation),
      browser_open: /open_browser|navigate_browser|open browser|navigate browser/i.test(conversation),
      screenshot: /take_screenshot|take screenshot|screenshot/i.test(conversation),
      console: /read_console|console/i.test(conversation),
      tests: /run_tests|npm test|node --test|run tests/i.test(conversation),
      server: /start_server|check_server|run_command|start server/i.test(conversation),
    };
    // Real failures are rendered as alerts inside the conversation. Text like "error:" that
    // appears inside generated code snippets is not a failure and must not fail the run.
    const alerts = await page.getByLabel("Conversation", { exact: true }).locator('[role="alert"]').allInnerTexts();
    const banned = conversation.match(/quota is exhausted|repeating completed inspections|not supported for this model|did not respond in time|stopped streaming|connection dropped[^\n]{0,120}/gi) || [];
    report.userVisibleErrors = [...new Set([...alerts, ...banned].map((s) => s.trim()).filter(Boolean))];
    for (const [name, ok] of await task.verify(root, ctx)) report.checks.push({ name, ok: Boolean(ok) });
    await page.screenshot({ path: path.join(ARTIFACTS, `${id}.png`), animations: "disabled", timeout: 120_000 });
    report.passed = report.checks.every((c) => c.ok) && report.userVisibleErrors.length === 0;
  } catch (error) {
    report.error = error.message;
    report.passed = false;
    // Keep whatever the agent actually said, or a stalled run has no diagnosis.
    if (page) report.conversationTail = await page.getByLabel("Conversation", { exact: true }).innerText().then((text) => text.slice(-7000)).catch(() => "");
    if (page) await page.screenshot({ path: path.join(ARTIFACTS, `${id}-error.png`), animations: "disabled" }).catch(() => {});
  } finally {
    await app.close();
    provider.close();
  }
  await fs.writeFile(path.join(ARTIFACTS, `${id}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main();
