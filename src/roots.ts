import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { notebookPath } from "./notebook.ts";
import { stateDir } from "./state.ts";

export function notebookRoots(value: string | undefined): string[] {
  return (value ?? "").split(":").filter((root) => root !== "");
}

export function tildePath(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function rootChoicesFile(env: Record<string, string | undefined> = process.env): string {
  return join(stateDir(env), "roots.json");
}

export class RootChoices {
  constructor(private readonly file: string) {}

  chosen(dir: string, roots: string[]): string | undefined {
    const choices = this.read();
    for (let at = notebookPath(dir); ; at = dirname(at)) {
      const chosen = roots.find((root) => notebookPath(root) === choices[at]);
      if (chosen !== undefined || dirname(at) === at) return chosen;
    }
  }

  choose(dir: string, root: string): void {
    const choices = { ...this.read(), [notebookPath(dir)]: notebookPath(root) };
    mkdirSync(dirname(this.file), { recursive: true });
    const partial = `${this.file}.${process.pid}`;
    writeFileSync(partial, `${JSON.stringify(choices, null, 2)}\n`);
    renameSync(partial, this.file);
  }

  private read(): Record<string, string> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }
}
