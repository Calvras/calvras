// Unit test for the PDF text extractor used by pdf:extract-text uploads.
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractPdfText } = require('../electron/pdf-text.cjs');

const checks = [];
function check(name, ok) { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }

function makePdf(streamBody, { flate = true } = {}) {
  const data = flate ? zlib.deflateSync(Buffer.from(streamBody)) : Buffer.from(streamBody);
  const filter = flate ? ' /Filter /FlateDecode' : '';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${data.length}${filter} >>\nstream\n${data.toString('latin1')}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objs.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

const flatePdf = makePdf('BT /F1 12 Tf 72 720 Td (Hello Calvras PDF) Tj 0 -20 Td (Second line here) Tj ET');
const flateText = extractPdfText(flatePdf);
check('flate stream text extracted', flateText.includes('Hello Calvras PDF') && flateText.includes('Second line here'));

const plainPdf = makePdf('BT /F1 12 Tf (Uncompressed text works) Tj ET', { flate: false });
check('uncompressed stream text extracted', extractPdfText(plainPdf).includes('Uncompressed text works'));

const escPdf = makePdf('BT (Escaped \\(parens\\) and \\\\ backslash) Tj ET');
const escText = extractPdfText(escPdf);
check('escape sequences decoded', escText.includes('Escaped (parens) and \\ backslash'));

const hexPdf = makePdf('BT <4865782074657874> Tj ET');
check('hex string decoded', extractPdfText(hexPdf).includes('Hex text'));

const kernPdf = makePdf('BT [(Wide) -300 (gap)] TJ ET');
check('TJ kerning inserts space', extractPdfText(kernPdf).includes('Wide gap'));

const empty = extractPdfText(Buffer.from('%PDF-1.4\n%%EOF'));
check('no streams yields empty string', empty === '');

const failed = checks.filter(c => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);