import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const run = promisify(execFile);
const ps = async (script) => (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: 30000, maxBuffer: 12 * 1024 * 1024, windowsHide: true })).stdout.trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cursorPosition = async () => (await ps('Add-Type -AssemblyName System.Windows.Forms; "$([System.Windows.Forms.Cursor]::Position.X),$([System.Windows.Forms.Cursor]::Position.Y)"')).split(",").map(Number);
const wtIds = async () => {
  const raw = await ps("Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id | ConvertTo-Json -Compress");
  const parsed = raw ? JSON.parse(raw) : [];
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
};

const evidenceFile = path.join(os.tmpdir(), "calvras-computer-control.txt");
await fs.rm(evidenceFile, { force: true });
const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-computer-"));

const cursorBefore = await cursorPosition().catch(() => [0, 0]);
const clipboardBackup = await ps("Get-Clipboard -Raw -ErrorAction SilentlyContinue").catch(() => "");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve("node_modules/electron/dist/electron.exe"), args: ["."], env, timeout: 30000 });
let sessionId = "";
let wtBefore = new Set();
const evidence = { approvalsRequested: 0 };
try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 20000 });

  // Drive the app's own agent API from inside the packaged app — the exact same
  // endpoints the renderer uses, with full access and no model in the loop.
  const call = (route, body) => page.evaluate(async ({ route, body }) => {
    const response = await fetch(`/api/agent/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.headers.get("content-type")?.includes("json")) return response.json();
    const text = await response.text();
    const events = text.split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
    return events[events.length - 1] ?? null;
  }, { route, body });
  const tool = async (action) => {
    const event = await call("tools", { sessionId, action });
    if (event?.approval) { evidence.approvalsRequested += 1; throw new Error(`Full access asked for approval: ${event.approval.question}`); }
    return event?.result;
  };

  const session = await call("session", { projectPath: sessionRoot, mode: "full" });
  assert.equal(session.ok, true);
  sessionId = session.id;

  // 1. Real desktop windows.
  const windows = await tool({ type: "list_windows" });
  assert.equal(windows.ok, true);
  assert.ok(windows.windows.length >= 1, "At least one real window must be visible");
  evidence.windowCount = windows.windows.length;
  evidence.windowTitles = windows.windows.slice(0, 6).map((w) => `${w.ProcessName}: ${w.MainWindowTitle}`);

  // 2. Real screen capture.
  const shot = await tool({ type: "take_screen_screenshot" });
  assert.equal(shot.ok, true);
  assert.match(shot.image, /^data:image\/jpeg;base64,/);
  const imageBytes = Buffer.from(shot.image.split(",")[1], "base64");
  assert.ok(imageBytes.length > 20000, "A real screen capture should not be a blank frame");
  await fs.writeFile(".agents/artifacts/runtime/computer-control-screen.jpg", imageBytes);
  evidence.screen = shot.screen;
  evidence.screenBytes = imageBytes.length;

  // 3. Real mouse movement, read back from the OS cursor, then restored.
  const target = { x: cursorBefore[0] + 140, y: cursorBefore[1] + 90 };
  const moved = await tool({ type: "move_mouse", x: target.x, y: target.y });
  assert.equal(moved.ok, true);
  const [mx, my] = await cursorPosition();
  evidence.mouse = { requested: target, actual: { x: mx, y: my }, matched: Math.abs(mx - target.x) <= 4 && Math.abs(my - target.y) <= 4 };
  assert.equal(evidence.mouse.matched, true, "OS cursor must land where the agent asked");

  // 4. Closed loop: launch our own console (title-marked), focus it, type through
  //    the real keyboard path and verify the OS executed what was typed. On this
  //    machine consoles are hosted by Windows Terminal, so the window to focus is
  //    the one titled after our /k title marker. Only windows and processes this
  //    test created are ever touched.
  wtBefore = new Set(await wtIds().catch(() => []));
  const launched = await tool({ type: "open_app", app: "cmd", args: "/k title calvras-verify-console" });
  assert.equal(launched.ok, true);
  await sleep(2500);
  const windowList = await tool({ type: "list_windows" });
  const consoleWindow = windowList.windows.find((w) => /calvras-verify-console/.test(w.MainWindowTitle || ""));
  evidence.consoleTitle = consoleWindow?.MainWindowTitle ?? null;
  assert.ok(consoleWindow, "The launched console must appear as a real titled window");
  const focused = await tool({ type: "focus_window", title: "calvras-verify-console" });
  assert.equal(focused.ok, true, "The console window must be focusable by title");
  await sleep(300);
  const typed = await tool({ type: "type_text", text: `echo calvras-typed-ok>"${evidenceFile}"` });
  assert.equal(typed.ok, true);
  assert.equal((await tool({ type: "press_keys", keys: "enter" })).ok, true);
  let typedOk = false;
  for (let attempt = 0; attempt < 24 && !typedOk; attempt++) { await sleep(250); typedOk = await fs.readFile(evidenceFile, "utf8").then((text) => text.includes("calvras-typed-ok")).catch(() => false); }
  evidence.keyboardLoop = typedOk;
  assert.equal(typedOk, true, "The typed command must reach the real console and execute");
  assert.equal(evidence.approvalsRequested, 0, "Full access must never prompt for computer control");
  console.log(JSON.stringify({ ok: true, evidence }));
} finally {
  // Stop only the console this test launched (matched by its marker command line),
  // then any Windows Terminal process that exists solely because of this test.
  await ps(`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'calvras-verify-console' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`).catch(() => {});
  await sleep(700);
  const wtAfter = await wtIds().catch(() => []);
  const newWt = wtAfter.filter((id) => !wtBefore.has(id));
  if (newWt.length) await ps(`Stop-Process -Id ${newWt.join(",")} -Force -ErrorAction SilentlyContinue`).catch(() => {});
  await fs.rm(evidenceFile, { force: true }).catch(() => {});
  await ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${cursorBefore[0]}, ${cursorBefore[1]})`).catch(() => {});
  await ps(`Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(clipboardBackup ?? "", "utf8").toString("base64")}')))`).catch(() => {});
  await fs.rm(sessionRoot, { recursive: true, force: true }).catch(() => {});
  await app.close();
}
