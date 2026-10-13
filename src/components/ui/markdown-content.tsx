import React from "react";

interface MarkdownContentProps {
  content: string;
  className?: string;
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
    <div className={`markdown-body space-y-3 leading-relaxed text-foreground ${className}`}>
      {elements}
    </div>
  );
}

function parseMarkdown(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 1. Code Block ```
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      nodes.push(
        <div key={`codeblock-${i}`} className="my-3 overflow-hidden rounded-lg border border-border/70 bg-card font-mono text-xs shadow-xs">
          {lang && (
            <div className="border-b border-border/60 bg-muted/40 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
              {lang}
            </div>
          )}
          <pre className="overflow-x-auto p-3 text-[12.5px] leading-relaxed text-foreground select-text">
            <code>{codeLines.join("\n")}</code>
          </pre>
        </div>
      );
      continue;
    }

    // 2. Markdown Table (| col | col |)
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
        tableLines.push(lines[i].trim());
        i++;
      }

      if (tableLines.length >= 2) {
        const headerRow = parseTableRow(tableLines[0]);
        const isDivider = tableLines[1].replace(/[\s|:-]/g, "").length === 0;
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
      nodes.push(<h1 key={`h1-${i}`} className="mt-4 mb-2 text-xl font-bold tracking-tight text-foreground">{renderInline(h1Match[1])}</h1>);
      i++;
      continue;
    }
    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      nodes.push(<h2 key={`h2-${i}`} className="mt-3.5 mb-1.5 text-lg font-semibold tracking-tight text-foreground">{renderInline(h2Match[1])}</h2>);
      i++;
      continue;
    }
    const h3Match = line.match(/^###\s+(.+)$/);
    if (h3Match) {
      nodes.push(<h3 key={`h3-${i}`} className="mt-3 mb-1 text-base font-semibold text-foreground">{renderInline(h3Match[1])}</h3>);
      i++;
      continue;
    }
    const h4Match = line.match(/^####\s+(.+)$/);
    if (h4Match) {
      nodes.push(<h4 key={`h4-${i}`} className="mt-2.5 mb-1 text-sm font-semibold text-foreground">{renderInline(h4Match[1])}</h4>);
      i++;
      continue;
    }

    // 5. Blockquote (> quote)
    if (line.trim().startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
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
      while (i < lines.length && /^[\*\-]\s+/.test(lines[i].trim())) {
        listItems.push(lines[i].trim().replace(/^[\*\-]\s+/, ""));
        i++;
      }
      nodes.push(
        <ul key={`ul-${i}`} className="my-2 list-disc list-outside pl-5 space-y-1 text-[14px]">
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
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        listItems.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      nodes.push(
        <ol key={`ol-${i}`} className="my-2 list-decimal list-outside pl-5 space-y-1 text-[14px]">
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
      <p key={`p-${i}`} className="text-[14.5px] leading-relaxed text-foreground select-text text-pretty">
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
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*|_[^_]+_)/;

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
    // Link ([label](url))
    else if (matchedStr.startsWith("[") && matchedStr.includes("](") && matchedStr.endsWith(")")) {
      const linkMatch = matchedStr.match(/^\[(.*?)\]\((.*?)\)$/);
      if (linkMatch) {
        tokens.push(
          <a
            key={keyIdx++}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline font-medium underline-offset-3 inline-flex items-center gap-0.5"
          >
            {linkMatch[1]}
          </a>
        );
      } else {
        tokens.push(matchedStr);
      }
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
