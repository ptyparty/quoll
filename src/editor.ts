import { basename } from "node:path";

export function editorCommand(file: string, line: number, env: Record<string, string | undefined> = process.env): string[] {
  const words = (env.VISUAL || env.EDITOR || "hx").trim().split(/\s+/);
  const name = basename(words[0]!);
  if (name === "hx" || name === "helix") return [...words, `${file}:${line}`];
  if (name === "code" || name === "codium" || name === "cursor" || name === "zed" || name === "subl") return [...words, ...(name === "zed" || name === "subl" ? [] : ["--goto"]), `${file}:${line}`];
  return [...words, `+${line}`, file];
}
