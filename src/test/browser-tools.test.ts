// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeBrowserSessions, executeBrowserTool } from '../lib/runtime/browser-tools';

describe('real browser tools', () => {
  let server: Server;
  let url: string;
  let project: string;
  const artifacts: string[] = [];
  beforeAll(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'calvras-browser-test-'));
    server = createServer((request, response) => {
      if (request.url === '/redirect') { response.writeHead(302, { location: 'http://localhost:19441/unapproved' }).end(); return; }
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>Browser fixture</title><style>body{margin:0}main{width:600px}</style><main><input id="name"><button id="go" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Submit</button><p id="result"></p></main><script>console.error("fixture error")</script>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    await closeBrowserSessions();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(project, { recursive: true, force: true });
    await Promise.all(artifacts.map((file) => rm(file, { force: true })));
  });
  it('opens a website, fills an input, clicks and inspects the resulting DOM', async () => {
    expect(await executeBrowserTool('open_browser', { url }, project)).toMatchObject({ title: 'Browser fixture', status: 200 });
    await executeBrowserTool('fill_input', { selector: '#name', value: 'Calvras' }, project);
    await executeBrowserTool('click_element', { selector: '#go' }, project);
    expect(await executeBrowserTool('inspect_element', { selector: '#result' }, project)).toMatchObject({ text: 'Calvras', tag: 'p' });
    expect(await executeBrowserTool('check_console_errors', {}, project)).toMatchObject({ errors: ['fixture error'], count: 1 });
  }, 30000);
  it('captures actual screenshots and measures responsive overflow', async () => {
    const shot = await executeBrowserTool('take_screenshot', {}, project);
    artifacts.push(shot.path);
    expect(shot.image).toMatch(/^data:image\/png;base64,iVBOR/);
    const results = await executeBrowserTool('test_responsive_layout', { widths: [375, 1280] }, project);
    for (const layout of results.layouts) artifacts.push(layout.path);
    expect(results.layouts.map((layout: any) => layout.horizontalOverflow)).toEqual([true, false]);
    expect(await executeBrowserTool('navigate_browser', { url: `${url}/other` }, project)).toMatchObject({ status: 200 });
  }, 30000);
  it('rejects filesystem URLs and invalid viewport requests', async () => {
    await expect(executeBrowserTool('open_browser', { url: 'file:///C:/secret.env' }, project)).rejects.toThrow('HTTP');
    await expect(executeBrowserTool('open_browser', { url: 'javascript:alert(1)' }, project)).rejects.toThrow('HTTP');
    await expect(executeBrowserTool('test_responsive_layout', { widths: [10] }, project)).rejects.toThrow('240');
  });
  it('blocks cross-origin redirects rather than extending localhost approval', async () => {
    await expect(executeBrowserTool('navigate_browser', { url: `${url}/redirect` }, project)).rejects.toThrow();
    const result = await executeBrowserTool('check_console_errors', {}, project);
    expect(result.errors.some((error: string) => error.includes('Blocked unapproved browser origin'))).toBe(true);
  });
});
