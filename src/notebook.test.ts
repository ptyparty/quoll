import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { findNotebook, listPages, pageFromPath, resolveAsset, resolveTarget } from "./notebook.ts";

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
  test("finds the notebook folder from the story dir, inside it, or below a repo", () => {
    expect(findNotebook(story)).toBe(root);
    expect(findNotebook(join(root, "design"))).toBe(root);
    expect(findNotebook(join(story, "repo", "src"))).toBe(root);
  });
});

describe("findNotebook with a notebook root", () => {
  test("maps a story dir, or anything below it, to the story's folder in the notebook root", () => {
    const notes = join(story, "notes");
    const work = join(story, "work", "stories", "sc-1", "repo", "storybook", "stories", "Button");
    mkdirSync(work, { recursive: true });
    expect(findNotebook(work, notes)).toBe(join(notes, "sc-1"));
    expect(findNotebook(join(story, "work", "stories", "sc-1"), notes)).toBe(join(notes, "sc-1"));
  });

  test("uses folders inside the notebook root as they are, including the root itself", () => {
    const notes = join(story, "notes");
    expect(findNotebook(notes, notes)).toBe(notes);
    expect(findNotebook(join(notes, "sc-1"), notes)).toBe(join(notes, "sc-1"));
  });

  test("recognises the root through a symlink", () => {
    const notes = join(story, "notes");
    mkdirSync(notes);
    symlinkSync(notes, join(story, "linked"));
    expect(findNotebook(notes, join(story, "linked"))).toBe(notes);
  });

  test("outside any stories directory, falls back to the notebook folder lookup", () => {
    mkdirSync(join(story, "notes", "repo"), { recursive: true });
    expect(findNotebook(join(story, "repo", "src"), join(story, "notes"))).toBe(root);
  });

  test("expands ~ in the root", () => {
    expect(findNotebook(join(homedir(), "notes-quoll-test", "sc-1"), "~/notes-quoll-test")).toBe(join(homedir(), "notes-quoll-test", "sc-1"));
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
