import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
const require = createRequire(import.meta.url);
const { unzipSync, strFromU8 } = require('../electron/vendor/fflate.cjs');
const { validateDocument, documentHtml } = require('../electron/document-tools.cjs');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-documents-'));
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-documents-work-'));
const out = path.resolve('.agents/artifacts/documents');
await fs.mkdir(out, { recursive: true });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['main.cjs', '--user-data-dir=' + profile], env, timeout: 60000 });
let count = 0;
const check = (name, ok) => { assert(ok, name); count++; console.log('PASS ' + name); };
const content = { title: 'Quarterly Report', blocks: [{ type: 'heading', level: 1, text: 'Overview' }, { type: 'paragraph', text: 'Verified content & editable text.\nSecond line with café.' }, { type: 'list', items: ['Completed work', 'Remaining work'] }, { type: 'table', rows: [['Item', 'Status'], ['Document output', 'Verified']] }, { type: 'paragraph', text: '<script>globalThis.injected=true</script>' }] };
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve('app.html')).href);
  await page.waitForSelector('#prompt-input');
  await page.evaluate(async folder => { await getElectronIpc().invoke('workspace:set-folder', folder); activeWorkspaceDir = folder; activeChatId = 'docs'; chats.push({ id: 'docs', title: 'Documents', messages: [] }); showConversationView('Documents'); }, workspace);
  for (const format of ['pdf', 'docx']) {
    const result = await page.evaluate(async ({ content, format }) => {
      const raw = '```document:report.' + format + '\n' + JSON.stringify(content) + '\n```';
      const blocks = parseAgentBlocks(raw);
      if (blocks.length !== 1 || stripToolBlocks(raw).trim()) throw new Error('Document syntax is not parsed or hidden correctly.');
      const result = await executeAgentBlock(blocks[0]);
      if (result.node.failed) throw new Error(result.node.error);
      const row = document.createElement('div'); row.className = 'message-row assistant';
      const drawer = buildToolDrawer(result.node); drawer.classList.add('open'); row.append(drawer); messagesContainer.append(row);
      return result.node;
    }, { content, format });
    const bytes = await fs.readFile(result.path);
    check(format.toUpperCase() + ' tool creates a real nonempty file', result.bytes === bytes.length && result.bytes > 500 && result.path === path.join(workspace, 'report.' + format));
    await fs.copyFile(result.path, path.join(out, 'report.' + format));
    if (format === 'pdf') {
      check('PDF has actual PDF header', bytes.subarray(0, 5).toString() === '%PDF-');
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
      const pdf = await loadingTask.promise;
      const strings = [];
      for (let i = 1; i <= pdf.numPages; i++) strings.push(...(await (await pdf.getPage(i)).getTextContent()).items.map(item => item.str || ''));
      const text = strings.join(' ');
      check('PDF pages contain title, body, table and escaped code', pdf.numPages >= 1 && ['Quarterly Report', 'Verified content & editable text.', 'Document output', '<script>'].every(value => text.includes(value)));
      const firstPage = await pdf.getPage(1), viewport = firstPage.getViewport({ scale: 1.5 });
      const rendered = pdf.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await firstPage.render({ canvasContext: rendered.context, viewport }).promise;
      await fs.writeFile(path.join(out, 'pdf-page.png'), rendered.canvas.toBuffer('image/png'));
      pdf.canvasFactory.destroy(rendered);
      await loadingTask.destroy();
    } else {
      const files = unzipSync(bytes);
      const xml = strFromU8(files['word/document.xml']);
      check('DOCX contains required OOXML parts and editable text', ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels'].every(name => files[name]) && xml.includes('Verified content &amp; editable text.') && xml.includes('<w:tbl>'));
      check('Every DOCX XML part parses without errors', await page.evaluate(entries => entries.every(text => !new DOMParser().parseFromString(text, 'application/xml').querySelector('parsererror')), Object.values(files).map(value => strFromU8(value))));
    }
  }
  check('Document result cards expose Show in folder', await page.getByRole('button', { name: 'Show in folder' }).count() === 2);
  await page.screenshot({ path: path.join(out, 'cards.png') });
  const before = await fs.readFile(path.join(workspace, 'report.pdf'));
  const overwrite = await page.evaluate(async input => { try { await getElectronIpc().invoke('document:create', input); return false; } catch { return true; } }, { ...content, format: 'pdf', filePath: 'report.pdf' });
  check('Existing documents cannot be overwritten', overwrite && before.equals(await fs.readFile(path.join(workspace, 'report.pdf'))));
  for (const filePath of ['../escape.pdf', '.git/report.pdf', 'C:/escape.pdf', 'folder\\..\\escape.pdf', 'bad.exe', 'file.pdf:stream']) assert.throws(() => validateDocument({ ...content, format: 'pdf', filePath }));
  check('Traversal, hidden folders, alternate streams and wrong extensions fail', true);
  const html = documentHtml(content);
  check('PDF markup escapes active content and blocks network resources', html.includes('&lt;script&gt;') && !html.includes('<script>') && html.includes("default-src 'none'"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'calvras-doc-outside-'));
  await fs.symlink(outside, path.join(workspace, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  check('Symlink escape is rejected', await page.evaluate(async input => { try { await getElectronIpc().invoke('document:create', input); return false; } catch { return true; } }, { ...content, format: 'docx', filePath: 'redirect/escape.docx' }));
  check('No renderer errors', errors.length === 0);
  console.log(`${count}/${count} passed`);
} finally { await app.close(); }
