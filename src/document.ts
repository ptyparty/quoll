import { Lexer, type Tokens } from "marked";

export type Block =
  | { kind: "markdown"; text: string; startLine: number; endLine: number; list?: number }
  | { kind: "image"; target: string; alt: string; startLine: number; endLine: number }
  | { kind: "mermaid"; source: string; startLine: number; endLine: number }
  | { kind: "conflict"; ours: string; theirs: string; oursLabel: string; theirsLabel: string; startLine: number; endLine: number };

export type Resolution = "ours" | "theirs" | "both";

export type Heading = { level: number; text: string; line: number };

export type Link = { label: string; target: string; line: number; column: number; length: number; lead: boolean };

export type Span = { line: number; column: number; length: number };

export type Document = { blocks: Block[]; headings: Heading[]; links: Link[] };

const imageExtensions = /\.(png|jpe?g|gif|webp)$/i;
const fence = /^\s*(`{3,}|~{3,})/;
const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const wikiEmbedLine = /^\s*!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]\s*$/;
const markdownImageLine = /^\s*!\[([^\]]*)\]\(<?([^)>\s]+)>?(?:\s+"[^"]*")?\)\s*$/;
const wikiLink = /(!?)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
const listLead = /^\s*(?:[-*+]|\d+[.)])\s+$/;
const markdownLink = /(?<!!)\[([^\]]+)\]\(<?([^)>\s]+)>?(?:\s+"[^"]*")?\)/g;

export function parseDocument(source: string, mark?: Span): Document {
  const lines = source.split(/\r?\n/);
  const blocks: Block[] = [];
  const headings: Heading[] = [];
  const links: Link[] = [];
  let pending: { lines: string[]; sourceLines: number[] } | undefined;
  const flush = () => {
    if (pending && pending.lines.some((line) => line.trim() !== "")) blocks.push(...markdownBlocks(pending.lines, pending.sourceLines));
    pending = undefined;
  };
  const append = (line: string, index: number) => {
    if (!pending) pending = { lines: [], sourceLines: [] };
    pending.lines.push(line);
    pending.sourceLines.push(index);
  };

  let index = skipFrontmatter(lines);
  let openFence: string | undefined;
  let inComment = false;
  for (; index < lines.length; index++) {
    const raw = lines[index]!;
    if (openFence) {
      append(raw, index);
      if (raw.trim().startsWith(openFence)) openFence = undefined;
      continue;
    }
    const opening = inComment ? null : /^(<{7,})(?: |$)/.exec(raw);
    if (opening) {
      const size = opening[1]!.length;
      const is = (candidate: string, char: string) => candidate.startsWith(char.repeat(size)) && (candidate.length === size || candidate[size] === " ");
      const middle = lines.findIndex((candidate, at) => at > index && is(candidate, "="));
      const end = middle === -1 ? -1 : lines.findIndex((candidate, at) => at > middle && is(candidate, ">"));
      if (end !== -1) {
        const base = lines.findIndex((candidate, at) => at > index && at < middle && is(candidate, "|"));
        flush();
        blocks.push({ kind: "conflict", ours: lines.slice(index + 1, base === -1 ? middle : base).join("\n"), theirs: lines.slice(middle + 1, end).join("\n"), oursLabel: raw.slice(size).trim(), theirsLabel: lines[end]!.slice(size).trim(), startLine: index, endLine: end });
        index = end;
        continue;
      }
    }
    const fenceMatch = fence.exec(raw);
    if (fenceMatch && !inComment && raw.slice(fenceMatch[0].length).trim() === "mermaid") {
      const close = lines.findIndex((candidate, at) => at > index && candidate.trim().startsWith(fenceMatch[1]!));
      const end = close === -1 ? lines.length - 1 : close;
      flush();
      blocks.push({ kind: "mermaid", source: lines.slice(index + 1, close === -1 ? lines.length : close).join("\n"), startLine: index, endLine: end });
      index = end;
      continue;
    }
    if (fenceMatch && !inComment) {
      openFence = fenceMatch[1]!;
      append(raw, index);
      continue;
    }
    const stripped = stripComments(raw, inComment);
    inComment = stripped.inComment;
    const line = mark?.line === index ? markSpan(stripped.text, mark) : stripped.text;
    if (stripped.removed && line.trim() === "") continue;

    const embed = wikiEmbedLine.exec(line);
    if (embed && imageExtensions.test(embed[1]!.trim())) {
      flush();
      blocks.push({ kind: "image", target: embed[1]!.trim(), alt: embed[2]?.trim() ?? "", startLine: index, endLine: index });
      continue;
    }
    const image = markdownImageLine.exec(line);
    if (image && !isExternal(image[2]!)) {
      flush();
      blocks.push({ kind: "image", target: decodeTarget(image[2]!), alt: image[1]!, startLine: index, endLine: index });
      continue;
    }
    const headingMatch = heading.exec(line);
    if (headingMatch) {
      flush();
      headings.push({ level: headingMatch[1]!.length, text: headingMatch[2]!, line: index });
    }
    links.push(...linksIn(stripped.text, index));
    append(rewriteWikiLinks(line), index);
  }
  flush();
  return { blocks, headings, links };
}

function markdownBlocks(lines: string[], sourceLines: number[]): Block[] {
  const blocks: Block[] = [];
  let line = 0;
  for (const token of new Lexer().lex(lines.join("\n"))) {
    const start = line;
    line += newlines(token.raw);
    const raw = token.raw.trimEnd();
    if (token.type === "space" || raw.trim() === "") continue;
    const span = (from: number, text: string) => {
      const first = Math.min(from + newlines(text.slice(0, text.length - text.trimStart().length)), lines.length - 1);
      const last = Math.min(from + newlines(text.trimEnd()), lines.length - 1);
      return { text: lines.slice(first, last + 1).join("\n"), startLine: sourceLines[first]!, endLine: sourceLines[last]! };
    };
    if (token.type === "list") {
      let at = start;
      const list = sourceLines[Math.min(start, lines.length - 1)]!;
      for (const item of (token as Tokens.List).items) {
        if (item.raw.trim() !== "") blocks.push({ kind: "markdown", ...span(at, item.raw), list });
        at += newlines(item.raw);
      }
      continue;
    }
    blocks.push({ kind: "markdown", ...span(start, token.raw) });
  }
  return blocks;
}

function newlines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
  return count;
}

export function frontmatterTags(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const end = skipFrontmatter(lines);
  if (end === 0) return [];
  let data: unknown;
  try {
    data = Bun.YAML.parse(lines.slice(1, end - 1).join("\n"));
  } catch {
    return [];
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const fields = data as Record<string, unknown>;
  const raw = fields.tags ?? fields.tag;
  const values = Array.isArray(raw) ? raw : [raw];
  const tags = values
    .filter((value) => typeof value === "string" || typeof value === "number")
    .flatMap((value) => String(value).split(/[,\s]+/))
    .map((tag) => tag.replace(/^#/, "").toLowerCase())
    .filter(Boolean);
  return [...new Set(tags)];
}

export function hasTag(tags: string[], wanted: string): boolean {
  const tag = wanted.replace(/^#/, "").toLowerCase();
  return tags.some((candidate) => candidate === tag || candidate.startsWith(`${tag}/`));
}

function skipFrontmatter(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return end === -1 ? 0 : end + 1;
}

function stripComments(line: string, inComment: boolean): { text: string; inComment: boolean; removed: boolean } {
  let text = "";
  let removed = false;
  let index = 0;
  while (index < line.length) {
    if (line.startsWith("%%", index)) {
      inComment = !inComment;
      removed = true;
      index += 2;
      continue;
    }
    if (!inComment && line[index] === "`") {
      const fence = /^`+/.exec(line.slice(index))![0];
      const close = line.indexOf(fence, index + fence.length);
      const end = close === -1 ? index + fence.length : close + fence.length;
      text += line.slice(index, end);
      index = end;
      continue;
    }
    if (inComment) removed = true;
    else text += line[index];
    index++;
  }
  return { text, inComment, removed };
}

function linksIn(line: string, index: number): Link[] {
  const found: Link[] = [];
  const leads = (at: number, length: number) => listLead.test(line.slice(0, at)) || (/\|\s*$/.test(line.slice(0, at)) && /^\s*\|/.test(line.slice(at + length)));
  for (const match of line.matchAll(wikiLink)) {
    const target = match[2]!.trim();
    found.push({ label: match[3]?.trim() || target, target, line: index, column: match.index, length: match[0].length, lead: leads(match.index, match[0].length) });
  }
  for (const match of line.matchAll(markdownLink)) {
    found.push({ label: match[1]!, target: decodeTarget(match[2]!), line: index, column: match.index, length: match[0].length, lead: leads(match.index, match[0].length) });
  }
  return found;
}

function markSpan(line: string, span: Span): string {
  const end = span.column + span.length;
  const link = linksIn(line, span.line).find((candidate) => candidate.column === span.column && candidate.length === span.length);
  return link ? `${line.slice(0, span.column)}~~${link.label}~~${line.slice(end)}` : line;
}

function rewriteWikiLinks(line: string): string {
  return line.replace(wikiLink, (whole: string, bang: string, target: string, alias: string | undefined, at: number) => {
    const label = alias?.trim() || target.trim();
    const link = `[${label.replace(/[[\]]/g, "\\$&")}]`;
    const before = !bang && line[at - 1] === "]" && line[at - 2] !== "]" ? " " : "";
    const next = line[at + whole.length];
    const after = next === "(" || next === "[" || (next === ":" && /^ {0,3}$/.test(line.slice(0, at))) ? " " : "";
    return `${before}${bang ? `↪ ${link}` : link}${after}`;
  });
}

export function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function decodeTarget(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

export function headingKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function firstChangedLine(before: string, after: string): number | undefined {
  if (before === after) return undefined;
  const old = before.split("\n");
  const next = after.split("\n");
  const shared = Math.min(old.length, next.length);
  for (let index = 0; index < shared; index++) {
    if (old[index] !== next[index]) return index;
  }
  return Math.max(0, Math.min(shared, next.length - 1));
}

export function blockAtLine(blocks: Block[], line: number): number {
  let found = 0;
  blocks.forEach((block, index) => {
    if (block.startLine <= line) found = index;
  });
  return found;
}

export type BlockChanges = { matched: Map<number, number>; changed: number[]; removed: number[] };

export function diffBlocks(before: Block[], after: Block[]): BlockChanges {
  const old = before.map(blockKey);
  const next = after.map(blockKey);
  const common = Array.from({ length: old.length + 1 }, () => new Array<number>(next.length + 1).fill(0));
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      common[i]![j] = old[i] === next[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
    }
  }
  const matched = new Map<number, number>();
  const changed: number[] = [];
  const removed: number[] = [];
  let i = 0;
  let j = 0;
  let dropped = false;
  let added = false;
  const endGap = () => {
    if (dropped && !added) removed.push(j);
    dropped = false;
    added = false;
  };
  while (i < old.length || j < next.length) {
    if (i < old.length && j < next.length && old[i] === next[j]) {
      endGap();
      matched.set(i++, j++);
    } else if (j < next.length && (i === old.length || common[i]![j + 1]! >= common[i + 1]![j]!)) {
      changed.push(j++);
      added = true;
    } else {
      i++;
      dropped = true;
    }
  }
  endGap();
  return { matched, changed, removed };
}

function blockKey(block: Block): string {
  if (block.kind === "markdown") return `markdown\n${block.text}`;
  if (block.kind === "image") return `image\n${block.target}\n${block.alt}`;
  if (block.kind === "conflict") return `conflict\n${block.ours}\n${block.theirs}`;
  return `mermaid\n${block.source}`;
}

export function resolveConflict(source: string, block: Extract<Block, { kind: "conflict" }>, resolution: Resolution): string {
  const ending = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const kept = resolution === "ours" ? [block.ours] : resolution === "theirs" ? [block.theirs] : [block.ours, block.theirs];
  const replacement = kept.filter((side) => side !== "").flatMap((side) => side.split("\n"));
  return [...lines.slice(0, block.startLine), ...replacement, ...lines.slice(block.endLine + 1)].join(ending);
}
