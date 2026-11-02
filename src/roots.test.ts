import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notebookRoots, RootChoices, rootChoicesFile } from "./roots.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "quoll-roots-"));
  for (const sub of ["work", "logs/a", "logs/b"]) mkdirSync(join(dir, sub), { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("notebookRoots", () => {
  test("splits QUOLL_DIR on colons, skipping empty entries", () => {
    expect(notebookRoots("/a:/b")).toEqual(["/a", "/b"]);
    expect(notebookRoots("/a::/b:")).toEqual(["/a", "/b"]);
    expect(notebookRoots("")).toEqual([]);
    expect(notebookRoots(undefined)).toEqual([]);
  });
});

describe("RootChoices", () => {
  test("keeps its file in quoll's state directory", () => {
    expect(rootChoicesFile({ XDG_STATE_HOME: "/state" })).toBe("/state/quoll/roots.json");
  });

  test("remembers the root picked for a directory", () => {
    const roots = [join(dir, "logs/a"), join(dir, "logs/b")];
    const choices = new RootChoices(join(dir, "state", "roots.json"));
    expect(choices.chosen(join(dir, "work"), roots)).toBeUndefined();
    choices.choose(join(dir, "work"), roots[1]!);
    expect(new RootChoices(join(dir, "state", "roots.json")).chosen(join(dir, "work"), roots)).toBe(roots[1]);
    expect(choices.chosen(dir, roots)).toBeUndefined();
  });

  test("a directory uses the pick made for its nearest picked parent", () => {
    const roots = [join(dir, "logs/a"), join(dir, "logs/b")];
    const choices = new RootChoices(join(dir, "roots.json"));
    choices.choose(dir, roots[0]!);
    choices.choose(join(dir, "work"), roots[1]!);
    expect(choices.chosen(join(dir, "work", "repo", "src"), roots)).toBe(roots[1]);
    expect(choices.chosen(join(dir, "logs"), roots)).toBe(roots[0]);
  });

  test("matches directories and roots through symlinks", () => {
    symlinkSync(join(dir, "work"), join(dir, "linked"));
    const choices = new RootChoices(join(dir, "roots.json"));
    choices.choose(join(dir, "linked"), join(dir, "logs/a"));
    expect(choices.chosen(join(dir, "work"), [join(dir, "logs/b"), `${join(dir, "logs")}/./a`])).toBe(`${join(dir, "logs")}/./a`);
  });

  test("forgets a pick whose root is no longer listed", () => {
    const choices = new RootChoices(join(dir, "roots.json"));
    choices.choose(join(dir, "work"), join(dir, "logs/a"));
    expect(choices.chosen(join(dir, "work"), [join(dir, "logs/b")])).toBeUndefined();
  });
});
