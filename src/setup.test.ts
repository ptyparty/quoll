import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupCommand } from "./setup.ts";

let dir: string;
let config: string;
let root: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "quoll-setup-")));
  config = join(dir, "claude");
  root = join(dir, "quoll");
  mkdirSync(join(root, "skills", "quoll"), { recursive: true });
  writeFileSync(join(root, "skills", "quoll", "SKILL.md"), "skill");
  spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("quoll setup", () => {
  test("links the skill into Claude's config, and takes it out again", () => {
    expect(setupCommand([], config, root)).toBe(0);
    expect(existsSync(join(config, "skills", "quoll"))).toBe(false);
    expect(setupCommand(["--yes"], config, root)).toBe(0);
    expect(readFileSync(join(config, "skills", "quoll", "SKILL.md"), "utf8")).toBe("skill");
    expect(setupCommand(["--remove"], config, root)).toBe(0);
    expect(existsSync(join(config, "skills", "quoll"))).toBe(false);
  });

  test("refuses an unknown flag", () => {
    spyOn(console, "error").mockImplementation(() => {});
    expect(setupCommand(["--pick"], config, root)).toBe(2);
  });
});
