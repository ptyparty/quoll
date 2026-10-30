import { describe, expect, test } from "bun:test";
import { blockAtLine, firstChangedLine, headingKey, parseDocument } from "./document.ts";

describe("parseDocument", () => {
  test("splits sections at headings and keeps their source lines", () => {
    const doc = parseDocument("# Plan\nintro\n\n## Rollout\nsteps\n");
    expect(doc.blocks.map((block) => [block.startLine, block.kind])).toEqual([
      [0, "markdown"],
      [3, "markdown"],
    ]);
    expect(doc.headings).toEqual([
      { level: 1, text: "Plan", line: 0 },
      { level: 2, text: "Rollout", line: 3 },
    ]);
  });

  test("turns image embeds on their own line into image blocks", () => {
    const doc = parseDocument("text\n![[mock.png|Login screen]]\n![alt](shots/a%20b.png)\n![web](https://x.test/a.png)");
    expect(doc.blocks.filter((block) => block.kind === "image")).toEqual([
      { kind: "image", target: "mock.png", alt: "Login screen", startLine: 1, endLine: 1 },
      { kind: "image", target: "shots/a b.png", alt: "alt", startLine: 2, endLine: 2 },
    ]);
  });

  test("collects wiki and markdown links and shows wiki links by label", () => {
    const doc = parseDocument("See [[plan#Rollout|the rollout]] and [notes](notes.md) or ![[other page]].");
    expect(doc.links).toEqual([
      { label: "the rollout", target: "plan#Rollout", line: 0 },
      { label: "other page", target: "other page", line: 0 },
      { label: "notes", target: "notes.md", line: 0 },
    ]);
    const block = doc.blocks[0]!;
    expect(block.kind === "markdown" && block.text).toBe("See **the rollout** and [notes](notes.md) or ↪ **other page**.");
  });

  test("keeps %% inside inline code", () => {
    const doc = parseDocument("inline `%% %%` and ``a %% b`` stay %%gone%%");
    const block = doc.blocks[0]!;
    expect(block.kind === "markdown" && block.text).toBe("inline `%% %%` and ``a %% b`` stay ");
  });

  test("skips frontmatter and Obsidian comments but not code", () => {
    const doc = parseDocument("---\ntags: [a]\n---\nkeep %%hidden%% this\n%%\nall gone\n%%\n```\n%% code %%\n# not a heading\n```");
    const text = doc.blocks.map((block) => (block.kind === "markdown" ? block.text : "")).join("|");
    expect(text).toBe("keep  this\n```\n%% code %%\n# not a heading\n```");
    expect(doc.headings).toEqual([]);
    expect(doc.blocks[0]!.startLine).toBe(3);
  });
});

describe("firstChangedLine", () => {
  test("finds the first differing line, appended lines, and no change", () => {
    expect(firstChangedLine("a\nb\nc", "a\nx\nc")).toBe(1);
    expect(firstChangedLine("a\nb", "a\nb\nc")).toBe(2);
    expect(firstChangedLine("a\nb\nc", "a\nb")).toBe(1);
    expect(firstChangedLine("a", "a")).toBeUndefined();
    expect(firstChangedLine("", "new")).toBe(0);
  });
});

test("blockAtLine picks the block that starts at or before a line", () => {
  const doc = parseDocument("# A\none\n# B\ntwo\nthree");
  expect(blockAtLine(doc.blocks, 4)).toBe(1);
  expect(blockAtLine(doc.blocks, 1)).toBe(0);
});

test("headingKey matches Obsidian and slug anchors", () => {
  expect(headingKey("Rollout plan")).toBe(headingKey("rollout-plan"));
});
