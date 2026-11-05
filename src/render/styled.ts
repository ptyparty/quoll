import { StyledText, bg, bold, fg, type TextChunk } from "@opentui/core";
import { theme } from "./theme.ts";

export type Part = string | TextChunk;
export type Hint = [key: string, label: string];

export function styled(parts: Part[]): StyledText {
  return new StyledText(parts.map((part) => (typeof part === "string" ? { __isChunk: true, text: part } : part)));
}

export function partsWidth(parts: Part[]): number {
  return parts.reduce((sum, part) => sum + Bun.stringWidth(typeof part === "string" ? part : part.text), 0);
}

export function pill(label: string, color: string = theme.quoll): Part {
  return bold(bg(color)(fg(theme.background)(` ${label} `)));
}

export function hintParts(hints: Hint[], separator: string): Part[] {
  return hints.flatMap(([key, label], index) => [...(index > 0 ? [separator] : []), fg(theme.text)(key), fg(theme.muted)(` ${label}`)]);
}

export function fitHints(hints: Hint[], room: number): Hint[] {
  let shown = hints;
  while (shown.length > 0 && partsWidth(hintParts(shown, "  ")) > room) shown = shown.slice(0, -1);
  return shown;
}
