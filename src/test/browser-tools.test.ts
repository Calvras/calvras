// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
      const route = String(request.url || '/');
      if (route === '/redirect') { response.writeHead(302, { location: 'http://localhost:19441/unapproved' }).end(); return; }
      if (route === '/site.css') { response.setHeader('content-type', 'text/css'); response.end('@import url("/cdn.css");\n.card{background:url(/tile.png) no-repeat}'); return; }
      if (route === '/cdn.css') { response.setHeader('content-type', 'text/css'); response.end('body{font-family:system-ui}'); return; }
      if (route === '/app.js') { response.setHeader('content-type', 'text/javascript'); response.end('window.__fixtureRan = true;'); return; }
      if (route === '/logo.svg') { response.setHeader('content-type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"></svg>'); return; }
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>Browser fixture</title><link rel="stylesheet" href="/site.css"><style>body{margin:0}main{width:600px}a{background:url("/ribbon.png")}</style><main><input id="name"><button id="go" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Submit</button><p id="result"></p><img id="mark" src="/logo.svg" alt="" width="24" height="24"><a id="home" href="/">Home</a></main><script src="/app.js"></script><script>console.error("fixture error")</script>');
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
  it('saves the page as its own markup and its own resolved stylesheet', async () => {
    const result = await executeBrowserTool('duplicate_page', { url, dir: 'page-copy' }, project);
    expect(result).toMatchObject({ ok: true, title: 'Browser fixture', dir: 'page-copy', styleSheetsSaved: 1, styleSheetsSkipped: 0, inlineStyleBlocks: 1, scriptsRemoved: 2 });
    const html = await readFile(path.join(project, 'page-copy', 'index.html'), 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<link rel="stylesheet" href="./calvras-page.css">');
    expect(html).not.toContain('<script');
    expect(html).toContain(`src="${url}/logo.svg"`);
    expect(html).toContain(`href="${url}/"`);
    const css = await readFile(path.join(project, 'page-copy', 'calvras-page.css'), 'utf8');
    expect(css).toContain('body{font-family:system-ui}');
    expect(css).toContain(`url("${url}/tile.png")`);
    expect(css).toContain(`url("${url}/ribbon.png")`);
    expect(css).not.toContain('@import');
    expect(result.next).toContain('change ONLY what the user named');
  }, 60000);
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
