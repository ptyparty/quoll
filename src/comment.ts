import { basename } from "node:path";
import type { Block, Heading } from "./document.ts";

export type Comment = { text: string; label: string };

export type CommentTarget = { page: string; file: string; source: string; block: Block; headings: Heading[]; asset?: string };

const maxQuotedLines = 12;
const labelSnippet = 28;

export function commentContext(target: CommentTarget): Comment {
  const { page, file, block } = target;
  const first = block.startLine + 1;
  const last = block.endLine + 1;
  const lines = first === last ? `line ${first}` : `lines ${first}–${last}`;
  const path = headingPath(target.headings, block.startLine);
  const kind = block.kind === "image" ? `, image ${target.asset ?? block.target}` : block.kind === "mermaid" ? ", a mermaid diagram" : block.kind === "conflict" ? ", a merge conflict" : "";
  const where = path ? ` under "${path}"` : "";
  const quoted = quote(target.source.split("\n").slice(block.startLine, block.endLine + 1));
  const text = `Comment on ${page}, ${lines}${where}${kind}:\nFile: ${file}\n${quoted}\n`;
  const range = first === last ? `${first}` : `${first}–${last}`;
  return { text, label: `${page}:${range} · ${describe(block)}` };
}

function headingPath(headings: Heading[], line: number): string {
  const stack: Heading[] = [];
  for (const heading of headings) {
    if (heading.line > line) break;
    while (stack.length > 0 && stack.at(-1)!.level >= heading.level) stack.pop();
    stack.push(heading);
  }
  return stack.map((heading) => heading.text).join(" › ");
}

function quote(lines: string[]): string {
  const shown = lines.length > maxQuotedLines ? [...lines.slice(0, maxQuotedLines - 1), "…"] : lines;
  return shown.map((line) => (line === "" ? ">" : `> ${line}`)).join("\n");
}

function describe(block: Block): string {
  if (block.kind === "image") return `image ${basename(block.target)}`;
  if (block.kind === "mermaid") return "diagram";
  if (block.kind === "conflict") return "merge conflict";
  const first = block.text.split("\n").find((line) => line.trim() !== "") ?? "";
  const fenceMatch = /^\s*(?:`{3,}|~{3,})\s*([\w+-]*)/.exec(first);
  if (fenceMatch) return fenceMatch[1] ? `${fenceMatch[1]} code` : "code";
  if (/^\s*\|/.test(first)) return "table";
  const words = first.replace(/^\s*(?:(?:#+|[-*+]|\d+[.)]|>)\s*)*(?:\[[ xX]\]\s*)?/, "").trim();
  if (!words) return "block";
  return words.length > labelSnippet ? `"${words.slice(0, labelSnippet - 1).trimEnd()}…"` : `"${words}"`;
}
