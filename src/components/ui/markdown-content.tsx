import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.css";
import React, { useState, useCallback } from "react";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

/* ── Math Block (display) ── */
function MathBlock({ formula }: { formula: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative my-3 overflow-x-auto rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-center font-mono text-[13px] leading-relaxed text-foreground select-text group">
      <span className="absolute top-1.5 right-2 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/40 select-none">math</span>
      <button
        type="button"
        onClick={() => { navigator.clipboard.writeText(formula).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        className="absolute top-1.5 right-10 text-[10px] text-muted-foreground/40 hover:text-muted-foreground transition-colors opacity-0 group-hover:opacity-100"
      >{copied ? "✓" : "copy"}</button>
      {/* Render LaTeX-like formula with basic prettification */}
      <span className="italic">{prettifyLatex(formula)}</span>
    </div>
  );
}

/** Very lightweight LaTeX → readable text prettifier (no KaTeX needed) */
function prettifyLatex(s: string): string {
  return s
    .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "($1)/($2)")
    .replace(/\\sqrt\{([^}]+)\}/g, "√($1)")
    .replace(/\\sqrt/g, "√")
    .replace(/\\pm/g, "±")
    .replace(/\\times/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\leq/g, "≤")
    .replace(/\\geq/g, "≥")
    .replace(/\\neq/g, "≠")
    .replace(/\\approx/g, "≈")
    .replace(/\\infty/g, "∞")
    .replace(/\\sum/g, "Σ")
    .replace(/\\prod/g, "Π")
    .replace(/\\int/g, "∫")
    .replace(/\\alpha/g, "α").replace(/\\beta/g, "β").replace(/\\gamma/g, "γ")
    .replace(/\\delta/g, "δ").replace(/\\epsilon/g, "ε").replace(/\\theta/g, "θ")
    .replace(/\\lambda/g, "λ").replace(/\\mu/g, "μ").replace(/\\pi/g, "π")
    .replace(/\\sigma/g, "σ").replace(/\\phi/g, "φ").replace(/\\omega/g, "ω")
    .replace(/\^2/g, "²").replace(/\^3/g, "³").replace(/\^n/g, "ⁿ")
    .replace(/\^/g, "^")
    .replace(/\\_/g, "_")
    .replace(/\{|\}/g, "")
    .replace(/\\\\/g, " ")
    .trim();
}

/* ── Copyable Code Block ── */
function CopyableCodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div className="relative my-3 overflow-hidden rounded-lg border border-border/70 bg-card font-mono text-xs shadow-xs group">
      {/* Header row with language label + copy button */}
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-3 py-1.5">
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          {lang || "code"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? "Copied!" : "Copy code"}
          title={copied ? "Copied!" : "Copy"}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 active:scale-[0.93] transition-all duration-150 cursor-pointer"
        >
          {copied ? (
            <>
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M2.5 7.5L5.5 10.5L11.5 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-500" />
              </svg>
              <span className="text-emerald-500">Copied</span>
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <rect x="5" y="1.5" width="7.5" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
                <rect x="1.5" y="4.5" width="7.5" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none" className="fill-card" />
              </svg>
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[12.5px] leading-relaxed text-foreground select-text">
        <code dangerouslySetInnerHTML={{ __html: lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : hljs.highlightAuto(code).value }} />
      </pre>
    </div>
  );
}

/**
 * Robust zero-dependency markdown & table renderer for Calvras responses.
 * Accurately parses:
 * - Bold (**text** or __text__)
 * - Italic (*text* or _text_)
 * - Inline code (`code`)
 * - Code blocks (```lang ... ```)
 * - Headers (# H1, ## H2, ### H3, #### H4)
 * - Blockquotes (> quote)
 * - Bullet lists (- item or * item)
 * - Numbered lists (1. item)
 * - Markdown tables (| Col 1 | Col 2 | ...) with header styling and clean borders
 * - Links ([text](url))
 * - Horizontal rules (---)
 */
export function MarkdownContent({ content, className = "" }: MarkdownContentProps) {
  if (!content) return null;

  const elements = parseMarkdown(content);

  return (
    <div className={`markdown-body space-y-3 leading-[1.7] text-foreground ${className}`}>
      {elements}
    </div>  );
}

function parseMarkdown(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 0. Block math $$...$$ (may span multiple lines)
    if (line.trim().startsWith("$$")) {
      const rest = line.trim().slice(2);
      // single-line: $$formula$$
      if (rest.endsWith("$$") && rest.length > 2) {
        nodes.push(<MathBlock key={`math-${i}`} formula={rest.slice(0, -2).trim()} />);
        i++;
        continue;
      }
      // multi-line: $$ ... $$
      const mathLines: string[] = [];
      if (rest.trim()) mathLines.push(rest);
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("$$")) {
        mathLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing $$
      nodes.push(<MathBlock key={`math-${i}`} formula={mathLines.join("\n").trim()} />);
      continue;
    }

    // 1. Code Block ```
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing ```
      nodes.push(
        <CopyableCodeBlock key={`codeblock-${i}`} lang={lang} code={codeLines.join("\n")} />
      );
      continue;
    }

    // 2. Markdown Table (| col | col |)
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|") && lines[i]!.trim().endsWith("|")) {
        tableLines.push(lines[i]!.trim());
        i++;
      }

      if (tableLines.length >= 2) {
        const headerRow = parseTableRow(tableLines[0]!);
        const isDivider = tableLines[1]!.replace(/[\s|:-]/g, "").length === 0;
        const bodyRows = tableLines.slice(isDivider ? 2 : 1).map(parseTableRow);

        nodes.push(
          <div key={`table-${i}`} className="my-3 overflow-x-auto rounded-lg border border-border/80 shadow-xs">
            <table className="min-w-full divide-y divide-border/80 text-left text-[13px]">
              <thead className="bg-muted/50 font-semibold text-foreground">
                <tr>
                  {headerRow.map((cell, cIdx) => (
                    <th key={cIdx} className="px-3.5 py-2.5 font-semibold text-foreground border-b border-border/70">
                      {renderInline(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50 bg-card/40">
                {bodyRows.map((row, rIdx) => (
                  <tr key={rIdx} className="hover:bg-muted/30 transition-colors">
                    {row.map((cell, cIdx) => (
                      <td key={cIdx} className="px-3.5 py-2 text-foreground/90 align-top">
                        {renderInline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }
    }

    // 3. Horizontal Rule
    if (/^(\*\*\*|---|___)$/.test(line.trim())) {
      nodes.push(<hr key={`hr-${i}`} className="my-4 border-t border-border/60" />);
      i++;
      continue;
    }

    // 4. Headers (#, ##, ###, ####)
    const h1Match = line.match(/^#\s+(.+)$/);
    if (h1Match) {
      nodes.push(<h1 key={`h1-${i}`} className="mt-4 mb-2 text-xl font-bold tracking-tight text-foreground">{renderInline(h1Match[1]!)}</h1>);
      i++;
      continue;
    }
    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      nodes.push(<h2 key={`h2-${i}`} className="mt-3.5 mb-1.5 text-lg font-semibold tracking-tight text-foreground">{renderInline(h2Match[1]!)}</h2>);
      i++;
      continue;
    }
    const h3Match = line.match(/^###\s+(.+)$/);
    if (h3Match) {
      nodes.push(<h3 key={`h3-${i}`} className="mt-3 mb-1 text-base font-semibold text-foreground">{renderInline(h3Match[1]!)}</h3>);
      i++;
      continue;
    }
    const h4Match = line.match(/^####\s+(.+)$/);
    if (h4Match) {
      nodes.push(<h4 key={`h4-${i}`} className="mt-2.5 mb-1 text-sm font-semibold text-foreground">{renderInline(h4Match[1]!)}</h4>);
      i++;
      continue;
    }

    // 5. Blockquote (> quote)
    if (line.trim().startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ""));
        i++;
      }
      nodes.push(
        <blockquote key={`quote-${i}`} className="my-2 border-l-3 border-primary/70 pl-3.5 italic text-muted-foreground bg-muted/20 py-1 rounded-r">
          {quoteLines.map((ql, qIdx) => (
            <p key={qIdx}>{renderInline(ql)}</p>
          ))}
        </blockquote>
      );
      continue;
    }

    // 6. Unordered Lists (- or *)
    if (/^[\*\-]\s+/.test(line.trim())) {
      const listItems: string[] = [];
      while (i < lines.length && /^[\*\-]\s+/.test(lines[i]!.trim())) {
        listItems.push(lines[i]!.trim().replace(/^[\*\-]\s+/, ""));
        i++;
      }
      nodes.push(
        <ul key={`ul-${i}`} className="my-2 list-disc list-outside pl-5 space-y-1 text-[14.5px]">
          {listItems.map((item, idx) => (
            <li key={idx} className="text-foreground/90 leading-relaxed">{renderInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // 7. Ordered Lists (1. 2.)
    if (/^\d+\.\s+/.test(line.trim())) {
      const listItems: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!.trim())) {
        listItems.push(lines[i]!.trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      nodes.push(
        <ol key={`ol-${i}`} className="my-2 list-decimal list-outside pl-5 space-y-1 text-[14.5px]">
          {listItems.map((item, idx) => (
            <li key={idx} className="text-foreground/90 leading-relaxed">{renderInline(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // 8. Empty lines
    if (line.trim() === "") {
      i++;
      continue;
    }

    // 9. Standard Paragraph
    nodes.push(
      <p key={`p-${i}`} className="text-[14.5px] leading-[1.7] text-foreground select-text text-pretty">
        {renderInline(line)}
      </p>
    );
    i++;
  }

  return nodes;
}

function parseTableRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

/** Render inline formatting: **bold**, *italic*, `code`, [link](url) */
function renderInline(text: string): React.ReactNode {
  if (!text) return null;

  // Split tokens by inline patterns
  const tokens: React.ReactNode[] = [];
  let remaining = text;
  let keyIdx = 0;

  // Regex matches:
  // 1. **bold** or __bold__
  // 2. *italic* or _italic_
  // 3. `inline code`
  // 4. [label](url)
  // 5. bare URLs (http/https or localhost)
  // 6. inline math $...$
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s)>\]"']+|localhost:\d+[^\s)>\]"']*|\$[^$\n]+\$|\*[^*]+\*|_[^_]+_)/;

  while (remaining) {
    const match = remaining.match(pattern);
    if (!match || match.index === undefined) {
      tokens.push(remaining);
      break;
    }

    if (match.index > 0) {
      tokens.push(remaining.slice(0, match.index));
    }

    const matchedStr = match[0];

    // Bold (**...** or __...__)
    if ((matchedStr.startsWith("**") && matchedStr.endsWith("**")) || (matchedStr.startsWith("__") && matchedStr.endsWith("__"))) {
      const inner = matchedStr.slice(2, -2);
      tokens.push(
        <strong key={keyIdx++} className="font-semibold text-foreground">
          {renderInline(inner)}
        </strong>
      );
    }
    // Inline code (`...`)
    else if (matchedStr.startsWith("`") && matchedStr.endsWith("`")) {
      const code = matchedStr.slice(1, -1);
      tokens.push(
        <code key={keyIdx++} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[12.5px] text-foreground font-medium border border-border/50">
          {code}
        </code>
      );
    }
    // Link ([label](url)) or bare URL
    else if (matchedStr.startsWith("[") && matchedStr.includes("](") && matchedStr.endsWith(")")) {
      const linkMatch = matchedStr.match(/^\[(.*?)\]\((.*?)\)$/);
      if (linkMatch) {
        const label = linkMatch[1];
        const url = linkMatch[2];
        tokens.push(
          <a
            key={keyIdx++}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all font-medium text-link underline decoration-link/45 decoration-1 underline-offset-[3px] transition-colors hover:decoration-link"
          >
            {label}
          </a>
        );
      } else {
        tokens.push(matchedStr);
      }
    }
    // Bare URL (http/https or bare localhost:PORT)
    else if (matchedStr.startsWith("http://") || matchedStr.startsWith("https://") || matchedStr.startsWith("localhost:")) {
      const href = matchedStr.startsWith("localhost:") ? `http://${matchedStr}` : matchedStr;
      tokens.push(
        <a
          key={keyIdx++}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all font-medium text-link underline decoration-link/45 decoration-1 underline-offset-[3px] transition-colors hover:decoration-link"
        >
          {matchedStr}
        </a>
      );
    }
    // Inline math ($...$)
    else if (matchedStr.startsWith("$") && matchedStr.endsWith("$") && matchedStr.length > 2) {
      const formula = matchedStr.slice(1, -1).trim();
      tokens.push(
        <span
          key={keyIdx++}
          title={formula}
          className="rounded bg-muted/50 border border-border/40 px-1 py-0.5 font-mono text-[12.5px] text-foreground/90 italic mx-0.5"
        >
          {prettifyLatex(formula)}
        </span>
      );
    }
    // Italic (*...* or _..._)
    else if ((matchedStr.startsWith("*") && matchedStr.endsWith("*")) || (matchedStr.startsWith("_") && matchedStr.endsWith("_"))) {
      const inner = matchedStr.slice(1, -1);
      tokens.push(
        <em key={keyIdx++} className="italic text-foreground/95">
          {renderInline(inner)}
        </em>
      );
    } else {
      tokens.push(matchedStr);
    }

    remaining = remaining.slice(match.index + matchedStr.length);
  }

  return <>{tokens}</>;
}

const BARE_URL = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+\.[^\s<>"']+|(?:localhost|127\.0\.0\.1):\d+[^\s<>"']*)/gi;

/**
 * Renders text with any URL inside it shown as a real, distinctly styled link.
 * Used for the user's own message, where markdown must not be interpreted — the
 * bubble has to show exactly what they typed, only with the address picked out.
 */
export function LinkifiedText({ text }: { text: string }) {
  const parts = text.split(BARE_URL);
  return (
    <>
      {parts.map((part, index) => {
        if (!part) return null;
        // split() with a capture group places every matched URL at an odd index.
        if (index % 2 === 0) return <span key={index}>{part}</span>;
        // "see https://acme.com/about," ends the sentence, it does not belong to the address.
        const trailing = part.match(/[.,;:!?)]+$/)?.[0] ?? "";
        const url = trailing ? part.slice(0, -trailing.length) : part;
        const href = /^www\.|^localhost:|^127\.0\.0\.1:/i.test(url) ? (/^127\.0\.0\.1:|^localhost:/i.test(url) ? `http://${url}` : `https://${url}`) : url;
        return (
          <React.Fragment key={index}>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="break-all font-medium text-link underline decoration-link/45 decoration-1 underline-offset-[3px] transition-colors hover:decoration-link"
            >
              {url}
            </a>
            {trailing}
          </React.Fragment>
        );
      })}
    </>
  );
}
