import { Fragment, type ReactNode } from "react";

/**
 * Renders the small Markdown subset agents write in reports: headings, paragraphs, bullet and
 * numbered lists (one level of nesting), quotes, fenced code, rules, tables, and inline bold,
 * italics, code and http(s) links. It builds React elements, never HTML, so report text can't inject markup.
 */
export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return <div className={`prose-report ${className}`}>{blocks(text.replace(/\r\n?/g, "\n"))}</div>;
}

type ListItem = { text: string; children: string[] };

function blocks(text: string): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => out.length;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      i++;
      out.push(<pre key={key()}>{body.join("\n")}</pre>);
      continue;
    }
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const Tag = heading[1]!.length <= 2 ? "h3" : "h4";
      out.push(<Tag key={key()}>{inline(heading[2]!)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key()} />);
      i++;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!)) rows.push(cells(lines[i++]!));
      out.push(
        <div key={key()} className="table-scroll">
          <table>
            <thead>
              <tr>
                {head.map((cell, n) => (
                  <th key={n}>{inline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {head.map((_, n) => (
                    <td key={n}>{inline(row[n] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push(<blockquote key={key()}>{blocks(body.join("\n"))}</blockquote>);
      continue;
    }
    const marker = listMarker(line);
    if (marker) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const m = listMarker(current);
        if (m && m.indent <= marker.indent + 1) {
          items.push({ text: m.text, children: [] });
        } else if (items.length > 0 && current.trim() && /^\s{2,}/.test(current)) {
          items.at(-1)!.children.push(current.slice(marker.indent + 2));
        } else if (!current.trim() && i + 1 < lines.length && listMarker(lines[i + 1]!)) {
          // A blank line between items keeps the list going.
        } else {
          break;
        }
        i++;
      }
      const List = marker.ordered ? "ol" : "ul";
      out.push(
        <List key={key()}>
          {items.map((item, n) => (
            <li key={n}>
              {inline(item.text)}
              {item.children.length > 0 && blocks(item.children.join("\n"))}
            </li>
          ))}
        </List>,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !listMarker(lines[i]!) &&
      !(isTableRow(lines[i]!) && TABLE_RULE.test(lines[i + 1] ?? "")) &&
      !/^\s*(#{1,6}\s|>|`{3,}|~{3,})/.test(lines[i]!)
    ) {
      paragraph.push(lines[i++]!.trim());
    }
    out.push(
      <p key={key()}>
        {paragraph.map((part, n) => (
          <Fragment key={n}>
            {n > 0 && <br />}
            {inline(part)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return out;
}

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);

/** A table row's cells, without the outer pipes; "\|" stays a literal pipe. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replaceAll("\\|", "|").trim());
}

function listMarker(line: string): { indent: number; ordered: boolean; text: string } | null {
  const m = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
  if (!m) return null;
  return { indent: m[1]!.length, ordered: /\d/.test(m[2]!), text: m[3]! };
}

const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = out.length;
    if (m[2] !== undefined) out.push(<code key={key}>{m[2].trim()}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={key}>{inline(m[3] ?? m[4]!)}</strong>);
    else if (m[5] !== undefined) out.push(<em key={key}>{inline(m[5])}</em>);
    else
      out.push(
        <a key={key} href={m[7]} target="_blank" rel="noreferrer noopener">
          {m[6]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
