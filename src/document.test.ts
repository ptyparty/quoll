import { describe, expect, test } from "bun:test";
import { blockAtLine, diffBlocks, firstChangedLine, frontmatterTags, hasTag, headingKey, parseDocument, resolveConflict } from "./document.ts";

describe("parseDocument", () => {
  test("splits markdown into headings, paragraphs, list items and tables, each with its source lines", () => {
    const doc = parseDocument("# Plan\nintro\n\n## Rollout\nsteps\nmore steps\n\n- one\n- two\n\n| a |\n|---|\n| 1 |\n");
    expect(doc.blocks.map((block) => [block.startLine, block.endLine, block.kind === "markdown" ? block.text : ""])).toEqual([
      [0, 0, "# Plan"],
      [1, 1, "intro"],
      [3, 3, "## Rollout"],
      [4, 5, "steps\nmore steps"],
      [7, 7, "- one"],
      [8, 8, "- two"],
      [10, 12, "| a |\n|---|\n| 1 |"],
    ]);
    expect(doc.headings).toEqual([
      { level: 1, text: "Plan", line: 0 },
      { level: 2, text: "Rollout", line: 3 },
    ]);
  });

  test("reads pages with Windows line endings", () => {
    const doc = parseDocument("# A\r\nhello\r\nworld\r\n\r\n- x\r\n- y\r\n");
    expect(doc.blocks.map((block) => [block.startLine, block.endLine, block.kind === "markdown" ? block.text : ""])).toEqual([
      [0, 0, "# A"],
      [1, 2, "hello\nworld"],
      [4, 4, "- x"],
      [5, 5, "- y"],
    ]);
  });

  test("keeps an item's nested list and continuation lines with it, and marks items of one list alike", () => {
    const doc = parseDocument("1. first\n   still first\n   - nested\n2. second\n\npara");
    expect(doc.blocks.map((block) => [block.startLine, block.endLine, block.kind === "markdown" ? block.list : "x"])).toEqual([
      [0, 2, 0],
      [3, 3, 0],
      [5, 5, undefined],
    ]);
  });

  test("reads a merge conflict as one block with both sides, skipping a diff3 base, and settles it", () => {
    const source = "# A\n<<<<<<< HEAD\nmine\n||||||| base\nold\n=======\ntheirs\n>>>>>>> origin/main\nafter";
    const doc = parseDocument(source);
    const conflict = doc.blocks[1]!;
    expect(conflict).toEqual({ kind: "conflict", ours: "mine", theirs: "theirs", oursLabel: "HEAD", theirsLabel: "origin/main", startLine: 1, endLine: 7 });
    if (conflict.kind !== "conflict") throw new Error("not a conflict");
    expect(resolveConflict(source, conflict, "ours")).toBe("# A\nmine\nafter");
    expect(resolveConflict(source, conflict, "theirs")).toBe("# A\ntheirs\nafter");
    expect(resolveConflict(source, conflict, "both")).toBe("# A\nmine\ntheirs\nafter");
  });

  test("reads longer conflict markers, so a setext underline inside a side stays in that side", () => {
    const fence = (char: string) => char.repeat(13);
    const source = [`${fence("<")} HEAD`, "Title", "=======", "mine", fence("="), "theirs", `${fence(">")} origin/main`].join("\n");
    const conflict = parseDocument(source).blocks[0]!;
    expect(conflict.kind === "conflict" && [conflict.ours, conflict.theirs]).toEqual(["Title\n=======\nmine", "theirs"]);
  });

  test("keeps a file's Windows line endings when settling a conflict", () => {
    const source = "a\r\n<<<<<<< HEAD\r\nmine\r\n=======\r\ntheirs\r\n>>>>>>> x\r\nb";
    const conflict = parseDocument(source).blocks.find((block) => block.kind === "conflict")!;
    if (conflict.kind !== "conflict") throw new Error("not a conflict");
    expect(resolveConflict(source, conflict, "both")).toBe("a\r\nmine\r\ntheirs\r\nb");
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
      { label: "the rollout", target: "plan#Rollout", line: 0, column: 4, length: 28, lead: false },
      { label: "other page", target: "other page", line: 0, column: 58, length: 15, lead: false },
      { label: "notes", target: "notes.md", line: 0, column: 37, length: 17, lead: false },
    ]);
    const block = doc.blocks[0]!;
    expect(block.kind === "markdown" && block.text).toBe("See **the rollout** and [notes](notes.md) or ↪ **other page**.");
  });

  test("marks a link that opens a list item, as an index's entries do", () => {
    const doc = parseDocument("- [Plan](plan.md): the work queue, see [notes](notes.md)\n1. [[decisions]]");
    expect(doc.links.map((link) => `${link.label} ${link.lead}`)).toEqual(["Plan true", "notes false", "decisions true"]);
  });

  test("marks a link that fills a table cell on its own, as a table of pages lists them", () => {
    const doc = parseDocument("| Area | Page |\n|---|---|\n| Pairing, see [notes](notes.md) | [ideas/pairing](ideas/pairing.md) |\n| Tours | [[tours]] |");
    expect(doc.links.map((link) => `${link.label} ${link.lead}`)).toEqual(["notes false", "ideas/pairing true", "tours true"]);
  });

  test("strikes through a marked link's label so the viewer can light it", () => {
    const doc = parseDocument("# T\n\nSee [[plan|the plan]] and [notes](notes.md).", { line: 2, column: 4, length: 17 });
    const block = doc.blocks.find((candidate) => candidate.startLine === 2)!;
    expect(block.kind === "markdown" && block.text).toBe("See ~~the plan~~ and [notes](notes.md).");
    expect(doc.links.map((link) => link.column)).toEqual([4, 26]);
  });

  test("turns a mermaid fence into a diagram block and leaves other fences as markdown", () => {
    const doc = parseDocument("intro\n```mermaid\nflowchart LR\n  A --> B\n```\n```ts\nconst a = 1;\n```\n~~~mermaid\nsequenceDiagram");
    expect(doc.blocks).toEqual([
      { kind: "markdown", text: "intro", startLine: 0, endLine: 0 },
      { kind: "mermaid", source: "flowchart LR\n  A --> B", startLine: 1, endLine: 4 },
      { kind: "markdown", text: "```ts\nconst a = 1;\n```", startLine: 5, endLine: 7 },
      { kind: "mermaid", source: "sequenceDiagram", startLine: 8, endLine: 9 },
    ]);
  });

  test("keeps %% inside inline code", () => {
    const doc = parseDocument("inline `%% %%` and ``a %% b`` stay %%gone%%");
    const block = doc.blocks[0]!;
    expect(block.kind === "markdown" && block.text).toBe("inline `%% %%` and ``a %% b`` stay ");
  });

  test("skips frontmatter and Obsidian comments but not code", () => {
    const doc = parseDocument("---\ntags: [a]\n---\nkeep %%hidden%% this\n%%\nall gone\n%%\n```\n%% code %%\n# not a heading\n```");
    const text = doc.blocks.map((block) => (block.kind === "markdown" ? block.text : "")).join("|");
    expect(text).toBe("keep  this|```\n%% code %%\n# not a heading\n```");
    expect(doc.headings).toEqual([]);
    expect(doc.blocks.map((block) => [block.startLine, block.endLine])).toEqual([
      [3, 3],
      [7, 10],
    ]);
  });
});

describe("frontmatterTags", () => {
  test("reads tags written as a list, an inline array, or a string", () => {
    expect(frontmatterTags("---\ntags:\n  - design\n  - '#komux'\n---\n# Page")).toEqual(["design", "komux"]);
    expect(frontmatterTags("---\ntitle: Plan\ntags: [design, logo/komux, 2026]\n---")).toEqual(["design", "logo/komux", "2026"]);
    expect(frontmatterTags("---\ntag: design, logo design\n---")).toEqual(["design", "logo"]);
    expect(frontmatterTags("---\ntags: 2026\n---")).toEqual(["2026"]);
  });

  test("folds case and splits array items on spaces, as Obsidian tags have none", () => {
    expect(frontmatterTags("---\ntags: [Design, 'logo design', design]\n---")).toEqual(["design", "logo"]);
  });

  test("a tag matches its own pages and those of tags nested under it", () => {
    expect(hasTag(["logo/komux"], "logo")).toBe(true);
    expect(hasTag(["logo/komux"], "#Logo/komux")).toBe(true);
    expect(hasTag(["logos"], "logo")).toBe(false);
  });

  test("finds no tags without frontmatter, without a tags field, or in broken YAML", () => {
    expect(frontmatterTags("# Page\n\ntags: [design]")).toEqual([]);
    expect(frontmatterTags("---\ntitle: Plan\n---")).toEqual([]);
    expect(frontmatterTags("---\ntags: [design\n---")).toEqual([]);
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

describe("diffBlocks", () => {
  test("matches unchanged blocks and reports new, edited and removed ones", () => {
    const before = parseDocument("# A\n\none\n\ntwo\n\nthree\n\nfour").blocks;
    const after = parseDocument("# A\n\none edited\n\nthree\n\nfour\n\nfive").blocks;
    expect(diffBlocks(before, after)).toEqual({
      matched: new Map([
        [0, 0],
        [3, 2],
        [4, 3],
      ]),
      changed: [1, 4],
      removed: [],
    });
  });

  test("marks a removal at the block that follows it, or past the end", () => {
    const before = parseDocument("a\n\nb\n\nc").blocks;
    expect(diffBlocks(before, parseDocument("a\n\nc").blocks).removed).toEqual([1]);
    expect(diffBlocks(before, parseDocument("a\n\nb").blocks).removed).toEqual([2]);
    expect(diffBlocks(before, parseDocument("a\n\nB\n\nc").blocks)).toMatchObject({ changed: [1], removed: [] });
  });
});

test("blockAtLine picks the block that starts at or before a line", () => {
  const doc = parseDocument("# A\none\n# B\ntwo\nthree");
  expect(blockAtLine(doc.blocks, 4)).toBe(3);
  expect(blockAtLine(doc.blocks, 1)).toBe(1);
  expect(blockAtLine(doc.blocks, 0)).toBe(0);
});

test("headingKey matches Obsidian and slug anchors", () => {
  expect(headingKey("Rollout plan")).toBe(headingKey("rollout-plan"));
});
