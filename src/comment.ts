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
  const kind = block.kind === "image" ? `, image ${target.asset ?? block.target}` : block.kind === "mermaid" ? ", a mermaid diagram" : "";
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
  const first = block.text.split("\n").find((line) => line.trim() !== "") ?? "";
  const fenceMatch = /^\s*(?:`{3,}|~{3,})\s*([\w+-]*)/.exec(first);
  if (fenceMatch) return fenceMatch[1] ? `${fenceMatch[1]} code` : "code";
  if (/^\s*\|/.test(first)) return "table";
  const words = first.replace(/^\s*(?:(?:#+|[-*+]|\d+[.)]|>)\s*)*(?:\[[ xX]\]\s*)?/, "").trim();
  if (!words) return "block";
  return words.length > labelSnippet ? `"${words.slice(0, labelSnippet - 1).trimEnd()}…"` : `"${words}"`;
}

export function commandWords(command: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quoteChar: string | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quoteChar) {
      if (char === quoteChar) quoteChar = undefined;
      else if (char === "\\" && quoteChar === '"' && index + 1 < command.length) word = (word ?? "") + command[++index];
      else word = (word ?? "") + char;
    } else if (char === "'" || char === '"') {
      quoteChar = char;
      word ??= "";
    } else if (char === "\\" && index + 1 < command.length) {
      word = (word ?? "") + command[++index];
    } else if (/\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

export type Delivery = { copy: (text: string) => boolean; env: Record<string, string | undefined> };

export async function deliverComment(comment: Comment, delivery: Delivery): Promise<string> {
  const words = commandWords(delivery.env.QUOLL_COMMENT_COMMAND ?? "");
  if (words.length === 0) return copyContext(comment, delivery);
  try {
    const child = Bun.spawn(withLabel(words, comment.label), { stdin: new Blob([comment.text]), stdout: "ignore", stderr: "pipe" });
    const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code === 0) return `Commenting on ${comment.label}`;
    return `Could not comment: ${errors.trim().split("\n").at(-1) || `${words[0]} exited with ${code}`}`;
  } catch (error) {
    return `Could not comment: ${(error as Error).message}`;
  }
}

function copyContext(comment: Comment, delivery: Delivery): string {
  let copied = false;
  try {
    copied = delivery.copy(comment.text);
  } catch {}
  return copied ? "Copied the context to the clipboard; set QUOLL_COMMENT_COMMAND to send comments" : "Could not copy the context; set QUOLL_COMMENT_COMMAND to send comments";
}

export function withLabel(words: string[], label: string): string[] {
  const last = words.at(-1)!;
  return /^--[^=]+$/.test(last) ? [...words.slice(0, -1), `${last}=${label}`] : [...words, label];
}
