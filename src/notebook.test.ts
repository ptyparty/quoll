import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
