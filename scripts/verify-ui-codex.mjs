// Verifies the Codex-style UI rebuild on the real Electron app: home, active
// chat with task checklist + worked-for trace, env panel, diff viewer, pickers.
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const OUT = ".agents/artifacts/codex-ui";
await fs.mkdir(OUT, { recursive: true });
const checks = [];
const check = (label, ok) => { checks.push([label, Boolean(ok)]); console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); };

// Scratch git repo with one uncommitted change so env + diff have real content.
const repo = await fs.mkdtemp(path.join(os.tmpdir(), "calvras-ui-"));
execSync("git init -q", { cwd: repo });
await fs.writeFile(path.join(repo, "app.js"), "const a = 1;\nconsole.log(a);\n");
execSync("git add app.js && git commit -qm init", { cwd: repo, shell: "cmd.exe", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } });
await fs.writeFile(path.join(repo, "app.js"), "const a = 2;\nconst b = 3;\nconsole.log(a + b);\n");
await fs.writeFile(path.join(repo, "new.txt"), "hello\nworld\n");
console.log("scratch repo:", repo);

const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: ["main.cjs", "--user-data-dir=" + await fs.mkdtemp(path.join(os.tmpdir(), "calvras-ui-profile-"))],
  env,
  timeout: 60_000,
});

let shot = 0;
const snap = async (page, name) => {
  const p = path.join(OUT, `${String(++shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: p, animations: "disabled" }).catch(() => {});
  console.log("shot:", p);
};

let fatal = null;
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(new URL('../app.html', import.meta.url).href);
  await page.waitForSelector("#prompt-input", { timeout: 30_000 });
  await page.waitForTimeout(1500);

  // HOME
  const home = await page.evaluate(() => ({
    heading: document.getElementById('welcome-heading')?.textContent || '',
    folderLabel: document.getElementById('folder-name-label')?.textContent || '',
    mode: document.querySelector('.selected-mode-name')?.textContent || '',
    noModelPicker: !document.getElementById('home-model-btn') && !document.getElementById('capsule-model-btn') && document.querySelectorAll('.model-picker-menu').length === 0,
    sendCircle: Boolean(document.querySelector('.codex-send-circle')),
    topHidden: document.getElementById('codex-top-actions')?.style.display === 'none',
  }));
  console.log("home:", JSON.stringify(home));
  check("home heading is Codex 'What should we build?'", home.heading === 'What should we build?');
  check("home folder bar says 'Choose project'", home.folderLabel === 'Choose project');
  check("home mode shows 'Full access'", home.mode === 'Full access');
  check("home has circular send button", home.sendCircle);
  check("top actions hidden on home", home.topHidden);
  check("no model picker in either composer", home.noModelPicker);
  await snap(page, "home");

  // Set the scratch repo as workspace
  await page.evaluate(async (dir) => {
    const ipc = window.require('electron').ipcRenderer;
    await ipc.invoke('workspace:set-folder', dir);
    await refreshWorkspaceInfo();
  }, repo);
  await page.waitForTimeout(400);

  // Start a conversation + render a plan checklist and a worked-for trace
  await page.evaluate(() => {
    showConversationView('Build a demo');
    updateTaskChecklist([
      { done: true, text: 'Scaffold the project files' },
      { done: true, text: 'Wire the API client' },
      { done: false, text: 'Add the settings screen' },
      { done: false, text: 'Test and publish' },
    ]);
    const phase = createAgentPhase(messagesContainer);
    phase.setThought('Reading the existing files to plan the change.');
    const h1 = phase.previewTool({ kind: 'read', arg: 'app.js', body: '' });
    phase.completeTool(h1, { kind: 'read', label: 'Read', path: 'app.js', code: 'const a = 1;', lineStart: 1, lineEnd: 1, totalLines: 2 });
    const h2 = phase.previewTool({ kind: 'edit', arg: 'app.js', body: '' });
    phase.completeTool(h2, { kind: 'edit', label: 'Edit', path: 'app.js', add: 2, del: 1 });
    const h3 = phase.previewTool({ kind: 'run', arg: 'node app.js', body: '' });
    phase.completeTool(h3, { kind: 'run', label: 'Run', command: 'node app.js', output: '5', exitCode: 0, success: true, durationMs: 320 });
    phase.setFinalMessage('Updated the calculation and verified the output.');
    phase.finalize();
  });
  await page.waitForTimeout(600);
  const active = await page.evaluate(() => ({
    checklist: Boolean(document.querySelector('.task-checklist')),
    checklistHead: document.querySelector('.task-checklist-head')?.textContent || '',
    doneRows: document.querySelectorAll('.task-check-row.done').length,
    currentRows: document.querySelectorAll('.task-check-row.current').length,
    summary: document.querySelector('.agent-group-summary')?.textContent || '',
    topVisible: document.getElementById('codex-top-actions')?.style.display !== 'none',
    firstRow: document.querySelector('.agent-tool-item:not(.agent-thought-item) .agent-tool-label')?.textContent || '',
  }));
  console.log("active:", JSON.stringify(active));
  check("task checklist card renders", active.checklist);
  check("checklist counts 2 of 4", /2 out of 4/.test(active.checklistHead));
  check("done items struck + current highlighted", active.doneRows === 2 && active.currentRows === 1);
  check("phase header shows 'Worked for …'", /^Worked for /.test(active.summary));
  check("top actions visible in conversation", active.topVisible);
  check("tool row uses flat 'Read …' text", /^Read /.test(active.firstRow));
  await snap(page, "active-chat");

  // ENV panel
  await page.click('#env-toggle-btn');
  await page.evaluate(() => refreshEnvPanel());
  await page.waitForTimeout(1500);
  const numRaw = await page.evaluate(() => gitExec('git diff --numstat HEAD').then(r => r.stdout));
  console.log("numstat raw:", JSON.stringify(numRaw));
  const envState = await page.evaluate(() => ({
    open: document.getElementById('env-panel')?.style.display !== 'none',
    branch: document.getElementById('env-branch-name')?.textContent || '',
    changes: document.getElementById('env-changes-count')?.textContent || '',
    badge: document.getElementById('diff-stats-badge')?.style.display || '',
    add: document.getElementById('diff-stat-add')?.textContent || '',
  }));
  console.log("env:", JSON.stringify(envState));
  check("env panel opens", envState.open);
  check("env shows git branch", envState.branch.length > 0 && envState.branch !== '—');
  check("env shows changed count", /changed|Clean/.test(envState.changes));
  check("diff stats badge populated", envState.badge !== 'none' && /\+\d/.test(envState.add));
  await snap(page, "env-panel");

  // DIFF viewer (close env first so the split layout is visible cleanly)
  await page.click('#env-toggle-btn');
  await page.waitForTimeout(200);
  await page.evaluate(() => openDiffPanel());
  await page.waitForTimeout(1200);
  const diff = await page.evaluate(() => ({
    open: document.getElementById('diff-panel')?.classList.contains('open'),
    files: document.querySelectorAll('.diff-file').length,
    addLines: document.querySelectorAll('.diff-line.add').length,
    delLines: document.querySelectorAll('.diff-line.del').length,
    treeFiles: document.querySelectorAll('.diff-tree-file').length,
    inLayout: document.getElementById('diff-panel')?.parentElement?.classList.contains('app-layout'),
  }));
  console.log("diff:", JSON.stringify(diff));
  check("diff viewer opens in layout", diff.open && diff.inLayout);
  check("diff parses changed files", diff.files >= 1);
  check("diff shows added + removed lines", diff.addLines >= 1 && diff.delLines >= 1);
  check("diff file tree populated", diff.treeFiles >= 1);
  await snap(page, "diff-viewer");

  check("no renderer page errors", errors.length === 0);
  if (errors.length) console.log("page errors:", errors);
} catch (err) {
  fatal = err;
  console.error("FATAL:", err);
} finally {
  await app.close().catch(() => {});
}

const passed = checks.filter(c => c[1]).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (fatal || passed !== checks.length) process.exit(1);