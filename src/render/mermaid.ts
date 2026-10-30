import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Diagram = { png: string } | { error: string } | { pending: true };

export type DrawDiagram = (source: string, png: string, chrome: string) => Promise<void>;

export class MermaidRenderer {
  private readonly drawing = new Set<string>();
  private readonly failures = new Map<string, string>();

  constructor(
    private readonly dir: string,
    private readonly chrome: string | undefined,
    private readonly draw: DrawDiagram = drawWithMermaidCli,
  ) {}

  diagram(source: string, onDrawn: () => void): Diagram {
    const key = createHash("sha256").update(source).digest("hex").slice(0, 32);
    const png = join(this.dir, `${key}.png`);
    if (existsSync(png)) return { png };
    const failure = this.failures.get(key);
    if (failure) return { error: failure };
    if (!this.chrome) return { error: "Drawing mermaid diagrams needs Chrome or Chromium installed" };
    if (!this.drawing.has(key)) {
      this.drawing.add(key);
      mkdirSync(this.dir, { recursive: true });
      this.draw(source, png, this.chrome)
        .catch((error: Error) => this.failures.set(key, error.message))
        .finally(() => {
          this.drawing.delete(key);
          onDrawn();
        });
    }
    return { pending: true };
  }
}

export function mermaidCacheDir(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "quoll", "mermaid");
}

export function findChrome(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.QUOLL_CHROME) return env.QUOLL_CHROME;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = Bun.which(name);
    if (found) return found;
  }
  return undefined;
}

async function drawWithMermaidCli(source: string, png: string, chrome: string): Promise<void> {
  const input = `${png}.mmd`;
  const config = `${png}.puppeteer.json`;
  const output = `${png}.drawing.png`;
  await Bun.write(input, source);
  await Bun.write(config, JSON.stringify({ executablePath: chrome, headless: "shell" }));
  try {
    const cli = join(dirname(Bun.resolveSync("@mermaid-js/mermaid-cli", import.meta.dir)), "cli.js");
    const child = Bun.spawn([process.execPath, cli, "-q", "-p", config, "-i", input, "-o", output, "-t", "dark", "-b", "transparent", "-s", "2"], { stdout: "ignore", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0 || !existsSync(output)) throw new Error(`Couldn't draw the diagram: ${reason(stderr)}`);
    renameSync(output, png);
  } finally {
    for (const file of [input, config, output]) rmSync(file, { force: true });
  }
}

function reason(stderr: string): string {
  const lines = stderr.split("\n").map((line) => line.trim().replace(/^error:\s*/i, "")).filter(Boolean);
  const parse = lines.findIndex((line) => /parse error|lexical error/i.test(line));
  if (parse >= 0) return lines.slice(parse, parse + 4).join(" ");
  return lines.find((line) => !line.startsWith("at ")) ?? "mermaid exited without saying why";
}
