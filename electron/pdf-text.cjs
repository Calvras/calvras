'use strict';
const zlib = require('zlib');

function inflateStream(buf) {
  try { return zlib.inflateSync(buf); } catch {}
  try { return zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch {}
  try { return zlib.inflateRawSync(buf); } catch {}
  return null;
}

function decodePdfString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const n = raw[++i];
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n === '(' || n === ')' || n === '\\') out += n;
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else if (n === '\n' || n === '\r') {
      if (n === '\r' && raw[i + 1] === '\n') i++;
    } else out += n || '';
  }
  return out;
}

function decodeHexString(hex) {
  const clean = hex.replace(/\s+/g, '');
  const bytes = [];
  for (let i = 0; i + 1 < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  return bytes.map(b => String.fromCharCode(b)).join('');
}

function extractTextFromContent(content) {
  const parts = [];
  let pending = [];
  const flush = () => { if (pending.length) { parts.push(pending.join('')); pending = []; } };
  const tokenRe = /\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]+)>|(-?[\d.]+)|\bTj\b|\bTJ\b|\bTd\b|\bTD\b|\bT\*\b|\bET\b|\bBT\b/g;
  let m;
  while ((m = tokenRe.exec(content)) !== null) {
    if (m[1] !== undefined) pending.push(decodePdfString(m[1]));
    else if (m[2] !== undefined) pending.push(decodeHexString(m[2]));
    else if (m[3] !== undefined) {
      if (Number(m[3]) < -120) pending.push(' ');
    } else if (m[0] === 'Tj' || m[0] === 'TJ') flush();
    else if (m[0] === 'Td' || m[0] === 'TD' || m[0] === 'T*' || m[0] === 'ET') { flush(); parts.push('\n'); }
  }
  flush();
  return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractPdfText(buf) {
  const latin = buf.toString('latin1');
  const pages = [];
  const streamRe = /stream\r?\n/g;
  let m;
  while ((m = streamRe.exec(latin)) !== null) {
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end === -1) break;
    streamRe.lastIndex = end;
    let data = buf.slice(start, end);
    while (data.length && (data[data.length - 1] === 0x0a || data[data.length - 1] === 0x0d)) data = data.slice(0, -1);
    const dictStart = latin.lastIndexOf('<<', m.index);
    const dict = dictStart === -1 ? '' : latin.slice(dictStart, m.index);
    let content = null;
    if (/FlateDecode/.test(dict)) content = inflateStream(data);
    else if (!/\/Filter/.test(dict)) content = data;
    if (!content) continue;
    const cs = content.toString('latin1');
    if (/\bTj\b|\bTJ\b/.test(cs)) {
      const text = extractTextFromContent(cs);
      if (text) pages.push(text);
    }
  }
  return pages.join('\n\n').trim();
}

module.exports = { extractPdfText };