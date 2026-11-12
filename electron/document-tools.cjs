'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { zipSync, strToU8 } = require('./vendor/fflate.cjs');

function validateDocument(input) {
  if (!input || !['pdf', 'docx'].includes(input.format)) throw new Error('Choose pdf or docx.');
  if (typeof input.filePath !== 'string' || !input.filePath || input.filePath.length > 240 || path.isAbsolute(input.filePath) || /[\x00-\x1f:]/.test(input.filePath) || input.filePath.split(/[\\/]/).some(part => !part || part === '..' || part.startsWith('.'))) throw new Error('Use a relative document filename without hidden folders or traversal.');
  if (path.extname(input.filePath).toLowerCase() !== '.' + input.format) throw new Error('The filename must match the document format.');
  if (typeof input.title !== 'string' || input.title.length > 300) throw new Error('Provide a title up to 300 characters.');
  if (!Array.isArray(input.blocks) || !input.blocks.length || input.blocks.length > 500) throw new Error('Provide 1–500 document blocks.');
  const text = value => typeof value === 'string' && value.length <= 20000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
  if (!text(input.title)) throw new Error('The document title contains unsupported characters.');
  for (const block of input.blocks) {
    if (!block || !['heading', 'paragraph', 'list', 'table'].includes(block.type)) throw new Error('Supported blocks: heading, paragraph, list, table.');
    if (['heading', 'paragraph'].includes(block.type) && !text(block.text)) throw new Error('Document text must be a string up to 20,000 characters.');
    if (block.type === 'heading' && block.level !== undefined && ![1, 2, 3].includes(block.level)) throw new Error('Heading levels are 1, 2 or 3.');
    if (block.type === 'list' && (!Array.isArray(block.items) || !block.items.length || block.items.length > 200 || !block.items.every(text))) throw new Error('Lists need 1–200 text items.');
    if (block.type === 'table' && (!Array.isArray(block.rows) || !block.rows.length || block.rows.length > 200 || !block.rows.every(row => Array.isArray(row) && row.length > 0 && row.length <= 20 && row.length === block.rows[0].length && row.every(text)))) throw new Error('Tables need equal-length text rows, up to 200 rows and 20 columns.');
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 500000) throw new Error('The document exceeds the 500 KB content limit.');
  return input;
}
const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const xml = body => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + body;
function documentHtml(input) {
  const blocks = input.blocks.map(block => {
    if (block.type === 'heading') { const tag = 'h' + (block.level || 1); return `<${tag}>${escape(block.text)}</${tag}>`; }
    if (block.type === 'list') return '<ul>' + block.items.map(item => `<li>${escape(item)}</li>`).join('') + '</ul>';
    if (block.type === 'table') return '<table>' + block.rows.map(row => '<tr>' + row.map(cell => `<td>${escape(cell)}</td>`).join('') + '</tr>').join('') + '</table>';
    return `<p>${escape(block.text)}</p>`;
  }).join('');
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>' + escape(input.title) + '</title><style>@page{size:A4;margin:20mm}body{font:11pt Arial,sans-serif;color:#202020;line-height:1.5}h1{font-size:22pt}h2{font-size:16pt}h3{font-size:13pt}h1,h2,h3{break-after:avoid}p,li,td{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;table-layout:fixed}td{border:1px solid #ccc;padding:7px;vertical-align:top}tr{break-inside:avoid}</style></head><body><h1>' + escape(input.title) + '</h1>' + blocks + '</body></html>';
}
function documentDocx(input) {
  const run = text => '<w:r>' + text.split('\n').map((line, index) => (index ? '<w:br/>' : '') + '<w:t xml:space="preserve">' + escape(line) + '</w:t>').join('') + '</w:r>';
  const paragraph = (text, style = '') => '<w:p>' + (style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '') + run(text) + '</w:p>';
  const blocks = input.blocks.map(block => {
    if (block.type === 'heading') return paragraph(block.text, 'Heading' + (block.level || 1));
    if (block.type === 'list') return block.items.map(item => paragraph('• ' + item)).join('');
    if (block.type === 'table') return '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="CCCCCC"/>`).join('') + '</w:tblBorders></w:tblPr><w:tblGrid>' + block.rows[0].map(() => '<w:gridCol w:w="2400"/>').join('') + '</w:tblGrid>' + block.rows.map(row => '<w:tr>' + row.map(cell => '<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>' + paragraph(cell) + '</w:tc>').join('') + '</w:tr>').join('') + '</w:tbl>';
    return paragraph(block.text);
  }).join('');
  const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const files = {
    '[Content_Types].xml': xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'),
    '_rels/.rels': xml(`<Relationships xmlns="${rel}"><Relationship Id="rId1" Type="${office}officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/_rels/document.xml.rels': xml(`<Relationships xmlns="${rel}"><Relationship Id="rId1" Type="${office}styles" Target="styles.xml"/></Relationships>`),
    'word/document.xml': xml(`<w:document xmlns:w="${word}"><w:body>` + paragraph(input.title, 'Title') + blocks + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>'),
    'word/styles.xml': xml(`<w:styles xmlns:w="${word}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` + [['Title', 44], ['Heading1', 36], ['Heading2', 30], ['Heading3', 26]].map(([name, size]) => `<w:style w:type="paragraph" w:styleId="${name}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`).join('') + '</w:styles>'),
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)]))));
}
function documentTarget(rootPath, filePath) {
  fs.mkdirSync(rootPath, { recursive: true });
  const root = fs.realpathSync(rootPath);
  const parts = filePath.split(/[\\/]/);
  let folder = root;
  for (const part of parts.slice(0, -1)) {
    const next = path.join(folder, part);
    if (!fs.existsSync(next)) fs.mkdirSync(next);
    folder = fs.realpathSync(next);
    const relative = path.relative(root, folder);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Document folders must remain inside the output folder.');
  }
  return path.join(folder, parts.at(-1));
}
async function createDocument({ BrowserWindow, root, input, isCancelled = () => false }) {
  validateDocument(input);
  if (isCancelled()) throw new Error('Document creation was cancelled.');
  const target = documentTarget(root, input.filePath);
  if (fs.existsSync(target)) throw new Error('That document already exists. Choose a new filename; existing documents are not overwritten.');
  let buffer;
  if (input.format === 'docx') buffer = documentDocx(input);
  else {
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, javascript: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    try {
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(documentHtml(input)));
      buffer = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    } finally { win.destroy(); }
  }
  if (isCancelled()) throw new Error('Document creation was cancelled.');
  if (buffer.length > 20 * 1024 * 1024) throw new Error('The generated document exceeds 20 MB.');
  fs.writeFileSync(target, buffer, { flag: 'wx' });
  return { path: target, format: input.format, bytes: buffer.length, title: input.title };
}
module.exports = { createDocument, validateDocument, documentHtml, documentDocx };
