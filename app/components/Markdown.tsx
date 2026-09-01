import React from "react";

// Small markdown renderer for AI chat answers. Deliberately renders to React
// elements (never dangerouslySetInnerHTML) so model output can't inject markup.
// Supports the subset the assistant actually uses: headings, bold/italic/code,
// bullet and numbered lists, tables, fenced code, and horizontal rules.

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Split on `code`, **bold**, *italic* / _italic_ — longest markers first.
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|_[^_\n]+_)/g;
  const parts = text.split(pattern);
  parts.forEach((part, i) => {
    if (!part) return;
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      nodes.push(
        <code key={key} className="px-1 py-0.5 rounded bg-gray-100 text-[13px] font-mono text-gray-800">
          {part.slice(1, -1)}
        </code>
      );
    } else if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      nodes.push(<strong key={key} className="font-semibold text-gray-900">{part.slice(2, -2)}</strong>);
    } else if (
      (part.startsWith("*") && part.endsWith("*") && part.length > 2) ||
      (part.startsWith("_") && part.endsWith("_") && part.length > 2)
    ) {
      nodes.push(<em key={key}>{part.slice(1, -1)}</em>);
    } else {
      nodes.push(<React.Fragment key={key}>{part}</React.Fragment>);
    }
  });
  return nodes;
}

const isTableRow = (line: string) => line.trim().startsWith("|") && line.trim().endsWith("|");
const splitRow = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code
    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key++} className="my-2 p-3 rounded-lg bg-gray-900 text-gray-100 text-xs font-mono overflow-x-auto">
          <code>{body.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // Table
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(splitRow(lines[i++]));
      blocks.push(
        <div key={key++} className="my-3 overflow-x-auto">
          <table className="data-table text-sm">
            <thead>
              <tr>
                {header.map((h, hi) => (
                  <th key={hi}>{renderInline(h, `th-${hi}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} className={ci > 0 && /^[\d,.$%+-]+$/.test(c) ? "tabular-nums" : ""}>
                      {renderInline(c, `td-${ri}-${ci}`)}
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

    // Headings
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const size = level <= 2 ? "text-base" : "text-sm";
      blocks.push(
        <p key={key++} className={`${size} font-semibold text-gray-900 mt-3 mb-1`}>
          {renderInline(heading[2], `h-${key}`)}
        </p>
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="my-3 border-gray-200" />);
      i++;
      continue;
    }

    // Lists
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
        i++;
      }
      const cls = "my-2 ml-5 space-y-1 text-sm text-gray-800";
      blocks.push(
        ordered ? (
          <ol key={key++} className={`${cls} list-decimal`}>
            {items.map((it, ii) => (
              <li key={ii}>{renderInline(it, `li-${key}-${ii}`)}</li>
            ))}
          </ol>
        ) : (
          <ul key={key++} className={`${cls} list-disc`}>
            {items.map((it, ii) => (
              <li key={ii}>{renderInline(it, `li-${key}-${ii}`)}</li>
            ))}
          </ul>
        )
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph — gather until a blank line or the start of another block.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isTableRow(lines[i]) &&
      !lines[i].trim().startsWith("```") &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
      !/^#{1,4}\s+/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    blocks.push(
      <p key={key++} className="text-sm text-gray-800 leading-relaxed my-2 whitespace-pre-wrap">
        {renderInline(para.join("\n"), `p-${key}`)}
      </p>
    );
  }

  return <>{blocks}</>;
}
