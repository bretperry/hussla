/*
  The one renderer for untrusted text: descriptions, notes, news, reviews and pitches become React elements.
  In the app: every place the UI shows text an agent or a scraped page wrote goes through Markdown or MarkdownInline.
  Used by: src/features/**.

  Security model: "Untrusted text is never markup." Nothing here sets innerHTML. Raw HTML in the
  source is just text (React escapes it), event attributes can't exist, and a link keeps its href
  only for http, https, mailto and tel; any other scheme (javascript:, data:, vbscript:) renders
  as its label with no link at all. The server's CSP is the second wall, not the first.
*/
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

// Schemes a link may keep; everything else is shown as plain text.
const SAFE_LINK = /^(https?:|mailto:|tel:)/i;

export const isSafeLink = (href: string): boolean => SAFE_LINK.test(href.trim());

const INLINE =
  /(`[^`]+`)|\[([^\]]+)\]\(([^\s)]+)\)|(https?:\/\/[^\s<)]+[^\s<).,;:])|\*\*([^*]+)\*\*|(?<![*\w])\*([^*\n]+)\*(?!\w)|(?<!\w)_([^_\n]+)_(?!\w)/g;

const shortUrl = (url: string): string => url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60);

const linkNode = (href: string, label: ReactNode, key: string): ReactNode => {
  const clean = href.trim();
  if (!isSafeLink(clean)) return <span key={key}>{label}</span>;
  const external = /^https?:/i.test(clean);
  return (
    <a key={key} href={clean} className="underline underline-offset-2" {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {label}
    </a>
  );
};

// Inline markup: `code`, [label](url), bare urls, **bold**, *italic*, _italic_.
const renderInline = (text: string, keyPrefix = "i"): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const key = `${keyPrefix}-${start}`;
    const [whole, code, label, href, bareUrl, bold, starItalic, underscoreItalic] = match;
    if (code !== undefined) nodes.push(<code key={key} className="bg-hairline/40 px-1 font-mono text-small">{code.slice(1, -1)}</code>);
    else if (label !== undefined && href !== undefined) nodes.push(linkNode(href, label, key));
    else if (bareUrl !== undefined) nodes.push(linkNode(bareUrl, shortUrl(bareUrl), key));
    else if (bold !== undefined) nodes.push(<strong key={key}>{renderInline(bold, key)}</strong>);
    else if (starItalic !== undefined || underscoreItalic !== undefined) nodes.push(<em key={key}>{starItalic ?? underscoreItalic}</em>);
    cursor = start + whole.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
};

type ListItem = { depth: number; ordered: boolean; text: string };

const LIST_LINE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const BLOCK_START = /^(#{1,6}\s|\s*\||\s*([-*+]|\d+[.)])\s|```|>)/;

const renderList = (items: ListItem[], key: string): ReactNode => {
  // Builds nested lists from indentation depth.
  const build = (from: number, depth: number): [ReactNode, number] => {
    const first = items[from];
    const Tag = first?.ordered === true ? "ol" : "ul";
    const children: ReactNode[] = [];
    let index = from;
    while (index < items.length) {
      const item = items[index];
      if (item === undefined || item.depth < depth) break;
      if (item.depth > depth) {
        const [nested, next] = build(index, item.depth);
        children.push(<li key={`${key}-n${index}`} className="list-none">{nested}</li>);
        index = next;
        continue;
      }
      children.push(<li key={`${key}-${index}`}>{renderInline(item.text, `${key}-${index}`)}</li>);
      index += 1;
    }
    return [<Tag key={`${key}-${from}`} className={cn("ml-6 flex flex-col gap-1", Tag === "ol" ? "list-decimal" : "list-disc")}>{children}</Tag>, index];
  };
  const [list] = build(0, items[0]?.depth ?? 0);
  return list;
};

const cellsOf = (line: string): string[] => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

// Block structure: headings, rules, fenced code, tables, lists, quotes, paragraphs.
const renderBlocks = (markdown: string, keyPrefix = "b"): ReactNode[] => {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const key = `${keyPrefix}-${index}`;
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      blocks.push(<p key={key} className="font-display text-row font-bold">{renderInline(heading[2] ?? "", key)}</p>);
      index += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key} className="border-hairline" />);
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push(<pre key={key} className="overflow-x-auto border border-hairline p-2 font-mono text-small"><code>{code.join("\n")}</code></pre>);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows: string[] = [];
      while (index < lines.length && /^\s*\|/.test(lines[index] ?? "")) {
        rows.push(lines[index] ?? "");
        index += 1;
      }
      const hasHeader = /^[\s|:-]+$/.test(rows[1] ?? "x");
      const bodyRows = rows.slice(hasHeader ? 2 : 0);
      blocks.push(
        <div key={key} className="overflow-x-auto">
          <table className="w-full border-collapse text-ui">
            {hasHeader ? (
              <thead>
                <tr>{cellsOf(rows[0] ?? "").map((cell, column) => <th key={column} className="border-b border-ink p-2 text-left font-semibold">{renderInline(cell, `${key}-h${column}`)}</th>)}</tr>
              </thead>
            ) : null}
            <tbody>
              {bodyRows.map((row, rowIndex) => (
                <tr key={rowIndex}>{cellsOf(row).map((cell, column) => <td key={column} className="border-b border-hairline p-2 align-top">{renderInline(cell, `${key}-${rowIndex}-${column}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (LIST_LINE.test(line)) {
      const items: ListItem[] = [];
      while (index < lines.length && (LIST_LINE.test(lines[index] ?? "") || (/^\s{2,}\S/.test(lines[index] ?? "") && items.length > 0))) {
        const current = lines[index] ?? "";
        const listLine = LIST_LINE.exec(current);
        const last = items[items.length - 1];
        if (listLine !== null) items.push({ depth: Math.floor((listLine[1] ?? "").length / 2), ordered: /\d/.test(listLine[2] ?? ""), text: listLine[3] ?? "" });
        else if (last !== undefined) last.text += ` ${current.trim()}`;
        index += 1;
      }
      blocks.push(renderList(items, key));
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(<blockquote key={key} className="flex flex-col gap-2 border-l-2 border-ink pl-4 italic">{renderBlocks(quoted.join("\n"), key)}</blockquote>);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() !== "" && !BLOCK_START.test(lines[index] ?? "")) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    if (paragraph.length === 0) {
      paragraph.push(line);
      index += 1;
    }
    blocks.push(
      <p key={key}>
        {paragraph.flatMap((text, lineIndex) => (lineIndex === 0 ? renderInline(text, `${key}-${lineIndex}`) : [<br key={`${key}-br${lineIndex}`} />, ...renderInline(text, `${key}-${lineIndex}`)]))}
      </p>,
    );
  }
  return blocks;
};

// Block markdown (paragraphs, lists, tables) in a column with the page's reading rhythm.
export const Markdown = ({ source, className }: { source: string; className?: string | undefined }) => (
  <div className={cn("flex flex-col gap-2 text-ui", className)}>{renderBlocks(source)}</div>
);

// One line of markdown (bold, links, code) with no block wrapper; for headsUp, nextAction, statuses.
export const MarkdownInline = ({ source }: { source: string }) => <>{renderInline(source)}</>;
