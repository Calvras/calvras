// Phase A checks: live web search, kill-at-timer, live tool rows + countdown,
// folder propagation, dark Run pill. Drives the real Electron app.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OUT = ".agents/artifacts/phase-a";
await fs.mkdir(OUT, { recursive: true });
const checks = [];
const check = (label, ok) => { checks.push([label, Boolean(ok)]); console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); };

const scratchA = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-phase-a-"));
const scratchB = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-phase-b-"));
console.log("scratch folders:", scratchA, scratchB);

const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: ["main.cjs", "--user-data-dir=" + await fs.mkdtemp(path.join(os.tmpdir(), "calvras-phase-profile-"))],
  env,
  timeout: 60_000,
});

let shot = 0;
const snap = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, "0")}-${name}.png`), animations: "disabled" }).catch(() => {});
};

let fatal = null;
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) console.log('Main frame navigation:', frame.url().split('?')[0]); });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(new URL('../app.html', import.meta.url).href);
  await page.waitForSelector("#prompt-input", { timeout: 30_000 });
  await page.waitForTimeout(1500);

  // 1. Real web search (main-process fetch, no CORS)
  const web = await page.evaluate(async () => {
    const t0 = Date.now();
    const out = await performWebSearch('Electron desktop framework');
    return { out, ms: Date.now() - t0 };
  });
  console.log("web search result:\n" + web.out.slice(0, 600));
  check(`web search returns real results (${web.ms}ms)`, /\d\. .+ — https?:\/\//.test(web.out) && !/returned no results/.test(web.out));

  const webBlock = await page.evaluate(async () => {
    const r = await executeAgentBlock({ kind: 'web', arg: 'DuckDuckGo search engine', body: '' });
    return r.resultText;
  });
  check("web: tool block wired into agent loop", /https?:\/\//.test(webBlock) && !/returned no results/.test(webBlock));

  // 2. Folder switch propagates to agent + terminal
  const folder = await page.evaluate(async (dir) => {
    const ipc = window.require('electron').ipcRenderer;
    await ipc.invoke('workspace:set-folder', dir);
    await refreshWorkspaceInfo();
    return {
      active: activeWorkspaceDir,
      terminalCwd: document.getElementById('terminal-cwd-label')?.textContent || '',
    };
  }, scratchA);
  check("folder change updates active workspace", folder.active === scratchA);
  check("folder change moves terminal cwd", folder.terminalCwd === scratchA);

  const pwd = await page.evaluate(async () => {
    const r = await executeAgentBlock({ kind: 'run', arg: 'Get-Location', body: '' });
    return { output: r.node.output, text: r.resultText };
  });
  check("run block executes in the NEW folder", pwd.output.includes(path.basename(scratchA)));
  await snap(page, "folder-a");

  // Switch again to prove nothing is stuck/hardcoded
  const folder2 = await page.evaluate(async (dir) => {
    const ipc = window.require('electron').ipcRenderer;
    await ipc.invoke('workspace:set-folder', dir);
    await refreshWorkspaceInfo();
    const r = await executeAgentBlock({ kind: 'run', arg: 'Get-Location', body: '' });
    return { active: activeWorkspaceDir, terminalCwd: document.getElementById('terminal-cwd-label')?.textContent || '', output: r.node.output };
  }, scratchB);
  check("second folder switch also propagates everywhere", folder2.active === scratchB && folder2.terminalCwd === scratchB && folder2.output.includes(path.basename(scratchB)));

  // 3. Kill-at-timer through the real agent path, with live countdown row
  const timer = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;bottom:0;width:640px;z-index:9999;background:#181716;';
    document.body.appendChild(host);
    const phase = createAgentPhase(host);
    const block = { kind: 'run', arg: '2s:Start-Sleep 10; Write-Output SHOULD_NOT_APPEAR', body: '' };
    const handle = phase.previewTool(block);
    const rowVisibleBeforeExec = Boolean(host.querySelector('.agent-tool-item .agent-tool-status'));
    let midStatus = '';
    const runPromise = executeAgentBlock(block, handle).then(r => { phase.completeTool(handle, r.node); return r; });
    await new Promise(res => setTimeout(() => { midStatus = handle.item.querySelector('.agent-tool-status')?.textContent || ''; res(); }, 1200));
    const r = await runPromise;
    const pill = host.querySelector('.agent-exit-pill');
    const chip = host.querySelector('.agent-tool-chip');
    const chipStyle = chip ? getComputedStyle(chip) : null;
    const label = host.querySelector('.agent-tool-label');
    const out = {
      rowVisibleBeforeExec,
      midStatus,
      timedOut: r.node.timedOut,
      durationMs: r.node.durationMs,
      output: r.node.output,
      resultText: r.resultText,
      pillClass: pill?.className || '',
      pillText: pill?.textContent || '',
      chipBg: chipStyle?.backgroundColor || '',
      labelText: label?.textContent || '',
    };
    window.__phaseAHost = host;
    return out;
  });
  console.log("timer run:", JSON.stringify({ ...timer, resultText: timer.resultText.slice(0, 300), output: timer.output.slice(0, 200) }, null, 2));
  check("tool row appears live before execution finishes", timer.rowVisibleBeforeExec);
  check("countdown status visible while running", /timer \d+s/.test(timer.midStatus));
  check("process killed at timer (~2s, not 10s)", timer.timedOut && timer.durationMs < 8000);
  check("killed output never contains post-timer echo", !timer.output.includes('SHOULD_NOT_APPEAR'));
  check("AI told TIMER REACHED + next step", /TIMER REACHED/.test(timer.resultText) && /run:4s:/.test(timer.resultText));
  check("exit pill shows timeout state", /timeout/.test(timer.pillClass) && timer.pillText === `timer ${Math.round(timer.durationMs / 1000)}s`);
  check("Run row is flat dark-on-dark, not a white pill", (timer.chipBg === 'rgba(0, 0, 0, 0)' || timer.chipBg === 'transparent') && /^Ran /.test(timer.labelText));
  await snap(page, "timer-row");

  // 4. Background server command resolves fast and says so
  const bg = await page.evaluate(async () => {
    const t0 = Date.now();
    const r = await executeAgentBlock({ kind: 'run', arg: 'bg:Start-Sleep 30', body: '' });
    return { ms: Date.now() - t0, text: r.resultText, output: r.node.output };
  });
  console.log("bg run:", JSON.stringify(bg));
  check("bg: command returns in ~5s and keeps running", bg.ms < 9000 && /background/.test(bg.text));

  await page.evaluate(() => { if (window.__phaseAHost) window.__phaseAHost.remove(); });
  check("no renderer page errors", errors.length === 0);
  if (errors.length) console.log("page errors:", errors);
  await snap(page, "final");
} catch (err) {
  fatal = err;
  console.error("FATAL:", err);
} finally {
  await app.close().catch(() => {});
}

const passed = checks.filter(c => c[1]).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (fatal || passed !== checks.length) process.exit(1);