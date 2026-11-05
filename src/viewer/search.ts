import { RGBA, type TextChunk } from "@opentui/core";
import { theme } from "../render/theme.ts";

export type Range = { start: number; end: number };

const matchBg = RGBA.fromHex(theme.selection);
const currentBg = RGBA.fromHex(theme.match);
const currentFg = RGBA.fromHex(theme.text);
const bold = 1;

export function findMatches(text: string, query: string): Range[] {
  if (query === "") return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), query === query.toLowerCase() ? "giu" : "gu");
  return [...text.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

export function markMatches(chunks: TextChunk[], query: string, current: number | undefined): TextChunk[] {
  const ranges = findMatches(chunks.map((chunk) => chunk.text).join(""), query);
  if (ranges.length === 0) return chunks;
  const marked: TextChunk[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const end = offset + chunk.text.length;
    let at = offset;
    ranges.forEach((range, index) => {
      const from = Math.max(range.start, offset);
      const to = Math.min(range.end, end);
      if (from >= to) return;
      if (from > at) marked.push({ ...chunk, text: chunk.text.slice(at - offset, from - offset) });
      const highlight = index === current ? { bg: currentBg, fg: currentFg, attributes: (chunk.attributes ?? 0) | bold } : { bg: matchBg };
      marked.push({ ...chunk, ...highlight, text: chunk.text.slice(from - offset, to - offset) });
      at = to;
    });
    if (at < end) marked.push({ ...chunk, text: chunk.text.slice(at - offset) });
    offset = end;
  }
  return marked;
}
