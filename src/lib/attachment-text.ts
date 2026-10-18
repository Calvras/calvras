/** Client-side extraction for non-image attachments so the model can read their contents. */

export function isTextLikeAttachment(name: string, type: string): boolean {
  if (type.startsWith("text/")) return true;
  if (["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript", "application/typescript"].includes(type)) return true;
  return /\.(txt|md|markdown|json|csv|tsv|log|xml|yaml|yml|toml|ini|cfg|conf|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sql|sh|bash|zsh|bat|ps1|cmd|html|htm|css|scss|less|vue|svelte|graphql|prisma)$/i.test(name);
}

export function isPdfAttachment(name: string, type: string): boolean {
  return type === "application/pdf" || name.toLowerCase().endsWith(".pdf");
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const base64 = dataUrl.slice(comma + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function decodeTextDataUrl(dataUrl: string): string {
  return new TextDecoder().decode(dataUrlToBytes(dataUrl));
}

/** Extracts selectable text from a PDF data URL. Complex layouts may lose spacing; scans have no text layer. */
export async function extractPdfText(dataUrl: string, maxChars = 60_000): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const workerUrl = (await import("./pdf-worker.ts?worker&url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const loadingTask = pdfjs.getDocument({ data: dataUrlToBytes(dataUrl) });
  const pdf = await loadingTask.promise;
  const pages: string[] = [];
  let total = 0;
  const pageCount = Math.min(pdf.numPages, 100);
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => (item as { str?: string }).str ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    page.cleanup();
    if (text) {
      pages.push(`--- Page ${pageNumber} ---\n${text}`);
      total += text.length;
    }
    if (total >= maxChars) break;
  }
  const pageLabel = pdf.numPages > pageCount ? `${pageCount} of ${pdf.numPages}` : String(pdf.numPages);
  await loadingTask.destroy();
  const extracted = pages.length ? pages.join("\n\n") : "(No selectable text found — the PDF may be a scan of images.)";
  return `[PDF: ${pageLabel} page(s)]\n${extracted}`.slice(0, maxChars);
}
