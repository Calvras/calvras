// @vitest-environment node
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { TOOL_NAMES, TOOL_RISK } from '../lib/tool-catalog';
import { FILE_TOOLS } from '../lib/runtime/file-tools';
import { COMMAND_TOOLS } from '../lib/runtime/command-tools';
import { CODE_INTELLIGENCE_TOOLS } from '../lib/runtime/code-intelligence';
import { BROWSER_TOOLS } from '../lib/runtime/browser-tools';
import { COMPUTER_TOOLS } from '../lib/runtime/computer-tools';
import { handleAgentApi } from '../lib/runtime/api';
import { getSession } from '../lib/runtime/agent-runtime';

const roots: string[] = [];
const sessionIds: string[] = [];
const infer = async () => '{"tasks":[{"title":"Inspect current project","status":"pending"}]}';
const request = (route: string, body?: any, headers: Record<string, string> = {}) => new Request(`http://localhost:3000/api/agent/${route}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
async function api(route: string, body?: any, headers?: Record<string, string>) {
  const response = await handleAgentApi(request(route, body, headers), infer);
  expect(response).not.toBeNull();
  return response!;
}
async function session(mode = 'ask') {
  const root = await mkdtemp(path.join(tmpdir(), 'calvras-runtime-api-test-'));
  roots.push(root);
  await writeFile(path.join(root, 'example.txt'), 'original');
  const data = await (await api('session', { projectPath: root, mode })).json();
  expect(data.ok).toBe(true);
  sessionIds.push(data.id);
  return { root, id: data.id };
}
async function event(body: any) {
  const response = await api('tools', body);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  return (await response.text()).split('\n\n').filter(Boolean).map((line) => JSON.parse(line.slice(6))).at(-1);
}
afterEach(async () => {
  for (const id of sessionIds.splice(0)) getSession(id).stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('runtime tool coverage', () => {
  it('routes every advertised tool to an executor or advanced implementation', async () => {
    const source = await readFile(new URL('../lib/runtime/agent-runtime.ts', import.meta.url), 'utf8');
    const advanced = [...source.matchAll(/case\s+"([^"]+)"\s*:/g)].map((match) => match[1]!);
    const supported = new Set<string>([...FILE_TOOLS, ...COMMAND_TOOLS, ...CODE_INTELLIGENCE_TOOLS, ...BROWSER_TOOLS, ...COMPUTER_TOOLS, ...advanced]);
    expect(TOOL_NAMES.filter((name) => !supported.has(name))).toEqual([]);
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
    for (const tool of TOOL_NAMES) expect(TOOL_RISK[tool]).toBeTruthy();
  });
  it('gives the tools that run beyond one turn a plain-words timeline label', async () => {
    // A row without one falls back to its raw name, which is what the user reads while the agent
    // works, so these durable tools must be named in the timeline's own words.
    const source = await readFile(new URL('../routes/index.tsx', import.meta.url), 'utf8');
    const block = source.slice(source.indexOf('TOOL_NARRATION: Record<string, string> = {'));
    const labelled = new Set([...block.slice(0, block.indexOf('\n};')).matchAll(/^\s*([a-z_0-9]+):/gm)].map((match) => match[1]!));
    for (const tool of ['build_knowledge', 'search_knowledge', 'read_module', 'schedule_run', 'list_scheduled', 'cancel_scheduled']) expect(labelled.has(tool), tool).toBe(true);
  });
  it('asks the person where a build should live before making a folder for them', async () => {
    // Full access no longer buys the workspace, and with nothing open the folder is the one
    // decision the app will not take out of the model's hands: the ask comes before the create.
    const source = await readFile(new URL('../routes/index.tsx', import.meta.url), 'utf8');
    const question = source.indexOf('Create a new project folder');
    const created = source.indexOf('/api/fs/create-project');
    expect(question).toBeGreaterThan(-1);
    expect(created).toBeGreaterThan(question);
    expect(source.slice(question, created)).toContain('answer === "deny"');
  });
});

describe('real agent API approvals', () => {
  it('streams approval without modifying files and denies the action permanently for the task', async () => {
    const { root, id } = await session();
    const action = { type: 'write_file', path: 'example.txt', content: 'changed' };
    const pending = await event({ sessionId: id, action });
    expect(pending.approval.question).toContain('example.txt');
    expect(await readFile(path.join(root, 'example.txt'), 'utf8')).toBe('original');
    expect((await (await api('approve', { sessionId: id, approvalId: pending.approval.id, choice: 'deny' })).json()).ok).toBe(true);
    expect((await event({ sessionId: id, action })).result).toMatchObject({ ok: false });
    expect(await readFile(path.join(root, 'example.txt'), 'utf8')).toBe('original');
  });
  it('consumes an approval once and prevents token reuse and action substitution', async () => {
    const { root, id } = await session();
    const action = { type: 'write_file', path: 'example.txt', content: 'approved edit' };
    const pending = await event({ sessionId: id, action });
    const decision = await (await api('approve', { sessionId: id, approvalId: pending.approval.id, choice: 'once' })).json();
    expect((await event({ sessionId: id, action, approvalToken: decision.token })).result.ok).toBe(true);
    expect(await readFile(path.join(root, 'example.txt'), 'utf8')).toBe('approved edit');
    expect((await event({ sessionId: id, action, approvalToken: decision.token })).result).toMatchObject({ ok: false });
    const second = await event({ sessionId: id, action: { ...action, content: 'next change' } });
    const nextDecision = await (await api('approve', { sessionId: id, approvalId: second.approval.id, choice: 'once' })).json();
    expect((await event({ sessionId: id, action: { ...action, content: 'unauthorized change' }, approvalToken: nextDecision.token })).result.ok).toBe(false);
    expect(await readFile(path.join(root, 'example.txt'), 'utf8')).toBe('approved edit');
  });
  it('writes files and runs commands silently in full access but still asks before removing work', async () => {
    const { root, id } = await session('full');
    expect((await event({ sessionId: id, action: { type: 'run_command', command: 'node -v' } })).result.ok).toBe(true);
    // The workspace is part of the deal: creating and editing go through with no prompt.
    const written = { type: 'write_file', path: 'automatic.txt', content: 'automatic edit' };
    expect((await event({ sessionId: id, action: written })).result.ok).toBe(true);
    expect(await readFile(path.join(root, 'automatic.txt'), 'utf8')).toBe('automatic edit');
    expect((await event({ sessionId: id, action: { type: 'search_replace', path: 'automatic.txt', search: 'automatic', replace: 'quiet' } })).result.ok).toBe(true);
    // Removing what already exists is the one thing that still interrupts, and it waits for a yes.
    const removal = await event({ sessionId: id, action: { type: 'delete_file', path: 'automatic.txt' } });
    expect(removal.approval.question).toContain('automatic.txt');
    expect(await readFile(path.join(root, 'automatic.txt'), 'utf8')).toBe('quiet edit');
    const decision = await (await api('approve', { sessionId: id, approvalId: removal.approval.id, choice: 'once' })).json();
    expect((await event({ sessionId: id, action: { type: 'delete_file', path: 'automatic.txt' }, approvalToken: decision.token })).result.ok).toBe(true);
    await expect(readFile(path.join(root, 'automatic.txt'), 'utf8')).rejects.toThrow();
  });
  it('blocks requests from external origins before touching a session', async () => {
    const response = await api('session', { projectPath: 'C:/' }, { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    const crossSite = await api('session', { projectPath: 'C:/' }, { 'sec-fetch-site': 'cross-site' });
    expect(crossSite.status).toBe(403);
  });
});
