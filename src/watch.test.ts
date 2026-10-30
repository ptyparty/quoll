import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchNotebook } from "./watch.ts";

let root: string;
let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  rmSync(root, { recursive: true, force: true });
});

test("reports each saved file once, including pages in subfolders, and skips hidden ones", async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "quoll-watch-")));
  mkdirSync(join(root, "design"));
  mkdirSync(join(root, ".obsidian"));
  const changed: string[] = [];
  stop = watchNotebook(root, 50, (filename) => changed.push(filename));
  await Bun.sleep(50);
  writeFileSync(join(root, "plan.md"), "one");
  writeFileSync(join(root, "plan.md"), "two");
  writeFileSync(join(root, "design", "drawer.md"), "three");
  writeFileSync(join(root, ".obsidian", "workspace.json"), "{}");
  await Bun.sleep(300);
  expect(changed.sort()).toEqual(["design/drawer.md", "plan.md"]);
});
