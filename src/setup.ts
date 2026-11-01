import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyLink, backupPath, linkState, removeLink, type Link, type LinkState } from "./links.ts";

const repoRoot = join(import.meta.dir, "..");
const marks: Record<LinkState, string> = { installed: "✓", missing: "✗", outdated: "↻", different: "!" };

const usage = `Usage: quoll setup [--yes|--remove]
  Lists quoll's Claude Code skill and whether it is linked into Claude's config.
  --yes links it, and --remove takes the link out again.`;

export function setupLinks(configDir = claudeConfigDir(), root = repoRoot): (Link & { label: string })[] {
  return readdirSync(join(root, "skills"))
    .sort()
    .map((name) => ({ label: `skill ${name}`, source: join(root, "skills", name), target: join(configDir, "skills", name), tail: join("skills", name), owner: "quoll" }));
}

export function setupCommand(args: string[], configDir = claudeConfigDir(), root = repoRoot): number {
  const [flag, ...extra] = args;
  if (extra.length > 0 || (flag !== undefined && flag !== "--yes" && flag !== "--remove")) {
    console.error(usage);
    return 2;
  }
  const links = setupLinks(configDir, root);
  const width = Math.max(...links.map((link) => link.label.length));
  if (flag === "--remove") {
    for (const link of links) {
      const outcome = removeLink(link);
      if (outcome !== "skipped") console.log(`  ${link.label.padEnd(width)}  ${outcome === "restored" ? "removed, and put back what it replaced" : "removed"}`);
    }
    return 0;
  }
  const needed = links.filter((link) => linkState(link) !== "installed");
  if (flag === "--yes") {
    if (needed.length === 0) console.log("Nothing to set up.");
    let failed = false;
    for (const link of needed) {
      try {
        const backup = applyLink(link);
        console.log(`  ${marks.installed} ${link.label.padEnd(width)}  ${backup ? `linked, keeping the old one as ${backup}` : "linked"}`);
      } catch (error) {
        failed = true;
        console.log(`  ${marks.missing} ${link.label.padEnd(width)}  ${(error as Error).message}`);
      }
    }
    return failed ? 1 : 0;
  }
  console.log(`Claude Code setup for quoll, in ${configDir}:\n`);
  for (const link of links) {
    const state = linkState(link);
    console.log(`  ${marks[state]} ${link.label.padEnd(width)}  ${describe(state, link)}`);
  }
  if (needed.length > 0) console.log("\nRun `quoll setup --yes` to set it up.");
  return 0;
}

function describe(state: LinkState, link: Link): string {
  if (state === "installed") return "linked";
  if (state === "missing") return "missing";
  if (state === "outdated") return "links to another quoll checkout";
  return `something else is there; it would be kept as ${backupPath(link)}`;
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}
