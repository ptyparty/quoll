export type Block =
  | { kind: "markdown"; text: string; startLine: number; endLine: number }
  | { kind: "image"; target: string; alt: string; startLine: number; endLine: number };

export type Heading = { level: number; text: string; line: number };

export type Link = { label: string; target: string; line: number };

export type Document = { blocks: Block[]; headings: Heading[]; links: Link[] };

const imageExtensions = /\.(png|jpe?g|gif|webp)$/i;
const fence = /^\s*(`{3,}|~{3,})/;
const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const wikiEmbedLine = /^\s*!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]\s*$/;
const markdownImageLine = /^\s*!\[([^\]]*)\]\(<?([^)>\s]+)>?(?:\s+"[^"]*")?\)\s*$/;
const wikiLink = /(!?)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
const markdownLink = /(?<!!)\[([^\]]+)\]\(<?([^)>\s]+)>?(?:\s+"[^"]*")?\)/g;

export function parseDocument(source: string): Document {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  const headings: Heading[] = [];
  const links: Link[] = [];
  let pending: { lines: string[]; startLine: number } | undefined;
  const flush = (endLine: number) => {
    if (pending && pending.lines.some((line) => line.trim() !== "")) {
      blocks.push({ kind: "markdown", text: pending.lines.join("\n"), startLine: pending.startLine, endLine });
    }
    pending = undefined;
  };
  const append = (line: string, index: number) => {
    if (!pending) pending = { lines: [], startLine: index };
    pending.lines.push(line);
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
    const fenceMatch = fence.exec(raw);
    if (fenceMatch && !inComment) {
      openFence = fenceMatch[1]!;
      append(raw, index);
      continue;
    }
    const stripped = stripComments(raw, inComment);
    inComment = stripped.inComment;
    const line = stripped.text;
    if (stripped.removed && line.trim() === "") continue;

    const embed = wikiEmbedLine.exec(line);
    if (embed && imageExtensions.test(embed[1]!.trim())) {
      flush(index - 1);
      blocks.push({ kind: "image", target: embed[1]!.trim(), alt: embed[2]?.trim() ?? "", startLine: index, endLine: index });
      continue;
    }
    const image = markdownImageLine.exec(line);
    if (image && !isExternal(image[2]!)) {
      flush(index - 1);
      blocks.push({ kind: "image", target: decodeTarget(image[2]!), alt: image[1]!, startLine: index, endLine: index });
      continue;
    }
    const headingMatch = heading.exec(line);
    if (headingMatch) {
      flush(index - 1);
      headings.push({ level: headingMatch[1]!.length, text: headingMatch[2]!, line: index });
    }
    links.push(...linksIn(line, index));
    append(rewriteWikiLinks(line), index);
  }
  flush(lines.length - 1);
  return { blocks, headings, links };
}

function skipFrontmatter(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return end === -1 ? 0 : end + 1;
}

function stripComments(line: string, inComment: boolean): { text: string; inComment: boolean; removed: boolean } {
  let text = "";
  let rest = line;
  let removed = false;
  while (true) {
    const marker = rest.indexOf("%%");
    if (marker === -1) {
      if (!inComment) text += rest;
      else removed = true;
      return { text, inComment, removed };
    }
    if (!inComment) text += rest.slice(0, marker);
    removed = true;
    inComment = !inComment;
    rest = rest.slice(marker + 2);
  }
}

function linksIn(line: string, index: number): Link[] {
  const found: Link[] = [];
  for (const match of line.matchAll(wikiLink)) {
    const target = match[2]!.trim();
    found.push({ label: match[3]?.trim() || target, target, line: index });
  }
  for (const match of line.matchAll(markdownLink)) {
    found.push({ label: match[1]!, target: decodeTarget(match[2]!), line: index });
  }
  return found;
}

function rewriteWikiLinks(line: string): string {
  return line.replace(wikiLink, (_whole, bang: string, target: string, alias: string | undefined) => {
    const label = alias?.trim() || target.trim();
    return bang ? `↪ **${label}**` : `**${label}**`;
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
