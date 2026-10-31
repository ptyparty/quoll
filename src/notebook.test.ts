import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { findNotebook, isDirectory, listPages, openNotebook, pageFromPath, resolveAsset, resolveTarget } from "./notebook.ts";

let story: string;
let root: string;

beforeEach(() => {
  story = mkdtempSync(join(tmpdir(), "quoll-"));
  root = join(story, "notebook");
  mkdirSync(join(root, "design", "shots"), { recursive: true });
  mkdirSync(join(story, "repo", "src"), { recursive: true });
  writeFileSync(join(root, "index.md"), "# Index");
  writeFileSync(join(root, "design", "plan.md"), "# Plan");
  writeFileSync(join(root, "design", "shots", "login.png"), "");
});

afterEach(() => rmSync(story, { recursive: true, force: true }));

describe("findNotebook", () => {
  test("without a notebook root, uses the start directory as it is", () => {
    expect(findNotebook(story)).toBe(story);
    expect(findNotebook(join(story, "repo", "src"), undefined, "sc-1")).toBe(join(story, "repo", "src"));
  });

  test("with a notebook root and no focus, uses the whole root", () => {
    const notes = join(story, "notes");
    expect(findNotebook(join(story, "work", "stories", "sc-1"), notes)).toBe(notes);
  });

  test("focuses on a named notebook, or the start directory's name", () => {
    const notes = join(story, "notes");
    expect(findNotebook(story, notes, "sc-1")).toBe(join(notes, "sc-1"));
    expect(findNotebook(join(story, "work", "stories", "sc-52521"), notes, true)).toBe(join(notes, "sc-52521"));
    expect(findNotebook(join(story, "work", "exfresso", "merlin"), notes, true)).toBe(join(notes, "merlin"));
  });

  test("refuses names that would leave the notebook root", () => {
    const notes = join(story, "notes");
    for (const name of ["", ".", "..", "a/b"]) expect(() => findNotebook(story, notes, name)).toThrow();
    expect(() => findNotebook("/", notes, true)).toThrow();
  });

  test("recognises the root through a symlink", () => {
    const notes = join(story, "notes");
    mkdirSync(notes);
    symlinkSync(notes, join(story, "linked"));
    expect(findNotebook(story, join(story, "linked"), "sc-1")).toBe(join(notes, "sc-1"));
  });

  test("expands ~ in the root", () => {
    expect(findNotebook(story, "~/notes-quoll-test", "sc-1")).toBe(join(homedir(), "notes-quoll-test", "sc-1"));
  });
});

describe("openNotebook", () => {
  test("creates a missing notebook inside the notebook root", () => {
    const notes = join(story, "notes");
    expect(openNotebook(join(notes, "sc-1"), notes)).toBe(join(notes, "sc-1"));
    expect(isDirectory(join(notes, "sc-1"))).toBe(true);
  });

  test("creates nothing outside the notebook root", () => {
    expect(openNotebook(story)).toBe(story);
    expect(() => openNotebook(join(story, "missing"))).toThrow();
    expect(() => openNotebook(join(story, "missing"), join(story, "notes"))).toThrow();
    expect(isDirectory(join(story, "missing"))).toBe(false);
  });
});

describe("resolveTarget", () => {
  test("resolves relative paths, paths from the root, and bare page names", () => {
    expect(resolveTarget(root, "index.md", "design/plan")).toEqual({ page: "design/plan.md" });
    expect(resolveTarget(root, "design/plan.md", "../index.md")).toEqual({ page: "index.md" });
    expect(resolveTarget(root, "index.md", "Plan#Rollout")).toEqual({ page: "design/plan.md", anchor: "Rollout" });
    expect(resolveTarget(root, "design/plan.md", "#Steps")).toEqual({ page: "design/plan.md", anchor: "Steps" });
  });

  test("refuses missing pages, external links, and paths outside the notebook", () => {
    expect(resolveTarget(root, "index.md", "nope")).toBeUndefined();
    expect(resolveTarget(root, "index.md", "https://example.test")).toBeUndefined();
    expect(resolveTarget(root, "index.md", "../repo/src")).toBeUndefined();
    expect(resolveTarget(root, "index.md", "design/shots/login.png")).toBeUndefined();
  });
});

test("resolveAsset finds images relative to the page or by name", () => {
  expect(resolveAsset(root, "design/plan.md", "shots/login.png")).toBe(join(root, "design", "shots", "login.png"));
  expect(resolveAsset(root, "index.md", "login.png")).toBe(join(root, "design", "shots", "login.png"));
  expect(resolveAsset(root, "index.md", "missing.png")).toBeUndefined();
});

test("listPages lists markdown pages and pageFromPath maps files into the notebook", () => {
  expect(listPages(root).map((page) => page.path).sort()).toEqual(["design/plan.md", "index.md"]);
  expect(pageFromPath(root, story, "notebook/design/plan.md")).toBe("design/plan.md");
  expect(pageFromPath(root, story, "repo/x.md")).toBeUndefined();
});
