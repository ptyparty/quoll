import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { parseDocument } from "../document.ts";
import { NotebookMapState, buildNotebookTree, notebookMapKey } from "./notebook-map.ts";

const notebook = [
  { page: "index.md", source: "# Home\n\n## Tools\n\n[[a]] and [[b]]\n\n## Notes\n\n[[c#Part]]\n\n## Docs\n\n[[d]]", tags: ["hub"] },
  { page: "a.md", source: "# A\n\n## Part one\n\nSee [[b]].", tags: ["tool"] },
  { page: "b.md", source: "# B\n\n## Bits", tags: ["tool"] },
  { page: "c.md", source: "# C\n\n## Part\n\nBack to [[a]].", tags: [] },
  { page: "d.md", source: "# D\n\nSome text about d.", tags: [] },
  { page: "orphan.md", source: "# Orphan", tags: ["tool"] },
];

function tree() {
  const pages = notebook.map(({ page, source, tags }) => ({ page, document: parseDocument(source), tags }));
  return buildNotebookTree(pages, (_from, target) => {
    const [path, anchor] = target.split("#");
    return { page: `${path}.md`, ...(anchor ? { anchor } : {}) };
  }, "index.md");
}

function key(name: string): KeyEvent {
  return { name, ctrl: false, shift: false, meta: false, sequence: name.length === 1 ? name : "" } as KeyEvent;
}

function labels(state: NotebookMapState): string[] {
  return state.trail.map((node) => node.label);
}

describe("notebook map", () => {
  test("hangs every page in one tree, at the first place a walk from the index reaches it", () => {
    const { root, pages } = tree();
    expect(root.label).toBe("Home");
    expect(root.children.map((child) => child.label)).toEqual(["Tools", "Notes", "D", "C", "unlinked pages (1)"]);
    expect(root.children[0]!.children.map((child) => `${child.kind} ${child.label}`)).toEqual(["page A", "page B"]);
    expect(root.children[1]!.children.map((child) => `${child.kind} ${child.label} (${child.detail})`)).toEqual(["portal C › Part (c#Part)"]);
    expect(pages.get("a.md")!.children[0]!.children.map((child) => `${child.kind} ${child.label} (${child.detail})`)).toEqual(["portal B (b)"]);
    expect(pages.get("c.md")!.children.map((child) => child.label)).toEqual(["Part"]);
  });

  test("hangs a page under the list that catalogues it rather than under a passing mention", () => {
    const pages = [
      { page: "index.md", source: "# Home\n\n## Status\n\nThe [drawer](drawer.md) slides up.\n\n## Tools\n\n- [Hub](hub.md): the hub", tags: [] },
      { page: "hub.md", source: "# Hub\n\n- [Drawer](drawer.md): the drawer", tags: [] },
      { page: "drawer.md", source: "# Drawer", tags: [] },
    ].map(({ page, source, tags }) => ({ page, document: parseDocument(source), tags }));
    const { pages: placed, parents } = buildNotebookTree(pages, (_from, target) => ({ page: target.endsWith(".md") ? target : `${target}.md` }), "index.md");
    expect(parents.get(placed.get("drawer.md")!)?.label).toBe("Hub");
    expect(placed.get("index.md")!.children[0]!.children.map((node) => node.kind)).toEqual(["portal"]);
  });

  test("puts a page in the same place whichever page the map is opened on", () => {
    const fromIndex = new NotebookMapState(tree());
    fromIndex.selectPage("b.md", 0);
    const fromC = new NotebookMapState(tree());
    fromC.selectPage("c.md", 2);
    notebookMapKey(fromC, key("k"));
    fromC.selectPage("b.md", 0);
    expect(labels(fromIndex)).toEqual(["Home", "Tools", "B"]);
    expect(labels(fromC)).toEqual(labels(fromIndex));
    expect(fromC.columns(10).map((column) => column.items.map((node) => node.label))).toEqual(fromIndex.columns(10).map((column) => column.items.map((node) => node.label)));
  });

  test("warps through a portal to the page's place in the tree, and Backspace warps back", () => {
    const state = new NotebookMapState(tree());
    state.selectPage("a.md", 2);
    notebookMapKey(state, key("l"));
    expect(state.node.kind).toBe("portal");
    expect(state.door).toEqual({ to: "B" });
    expect(notebookMapKey(state, key("return"))).toBe("move");
    expect(labels(state)).toEqual(["Home", "Tools", "B"]);
    expect(state.depth).toBe(1);
    expect(notebookMapKey(state, key("backspace"))).toBe("move");
    expect(labels(state)).toEqual(["Home", "Tools", "A", "Part one", "B"]);
  });

  test("warps to the heading a portal names", () => {
    const state = new NotebookMapState(tree());
    state.selectPage("index.md", 6);
    notebookMapKey(state, key("l"));
    notebookMapKey(state, key("return"));
    expect(labels(state)).toEqual(["Home", "C", "Part"]);
  });

  test("lists the other pages that share a tag under it, each a portal to that page", () => {
    const state = new NotebookMapState(tree());
    state.selectPage("a.md", 0);
    for (const name of ["l", "j", "j"]) notebookMapKey(state, key(name));
    expect(state.node.label).toBe("#tool (2)");
    expect(state.columns(10)[2]!.items.map((node) => node.label)).toEqual(["B", "Orphan"]);
    notebookMapKey(state, key("l"));
    expect(state.door).toEqual({ to: "B" });
    notebookMapKey(state, key("return"));
    expect(labels(state)).toEqual(["Home", "Tools", "B"]);
    notebookMapKey(state, key("backspace"));
    expect(labels(state)).toEqual(["Home", "Tools", "A", "#tool (2)", "B"]);
  });

  test("opens on the root's sections, never on the root itself", () => {
    const state = new NotebookMapState(tree());
    expect(labels(state)).toEqual(["Home", "Tools"]);
    notebookMapKey(state, key("h"));
    expect(labels(state)).toEqual(["Home", "Tools"]);
    expect(state.columns(10)[0]!.items).toEqual([]);
    expect(state.columns(10)[1]!.title).toBe("Home  1/5");
  });

  test("shows the parent's list, the list you are in, and what lies under the selection", () => {
    const state = new NotebookMapState(tree());
    state.selectPage("a.md", 0);
    const [up, here, below] = state.columns(10);
    expect(up!.focus?.label).toBe("Tools");
    expect(here!.title).toBe("Tools  1/2");
    expect(here!.items.map((node) => node.label)).toEqual(["A", "B"]);
    expect(here!.focus?.label).toBe("A");
    expect(below!.items.map((node) => node.label)).toEqual(["Part one", "linked from (1)", "#tool (2)"]);
    expect(state.tree.pages.get("a.md")!.children[1]!.children.map((node) => `${node.label} (${node.detail})`)).toEqual(["C › Part (c)"]);
  });

  test("folds a heading that only introduces a page into that page, and previews a leaf's text", () => {
    const state = new NotebookMapState(tree());
    state.selectPage("d.md", 0);
    expect(labels(state)).toEqual(["Home", "D"]);
    const below = state.columns(10)[2]!;
    expect(below.items.map((node) => `${node.kind} ${node.label}`)).toEqual(["text Some text about d."]);
  });

  test("filters the whole tree as you type, goes to a match with Enter, and Backspace returns", () => {
    const state = new NotebookMapState(tree());
    state.selectPage("b.md", 0);
    notebookMapKey(state, key("/"));
    for (const ch of "part") notebookMapKey(state, key(ch));
    expect(state.filter).toBe("part");
    expect(state.columns(10)[1]!.items.map((node) => node.label)).toEqual(["Part one", "Part"]);
    expect(state.node.label).toBe("Part one");
    notebookMapKey(state, key("down"));
    expect(labels(state)).toEqual(["Home", "C", "Part"]);
    notebookMapKey(state, key("return"));
    expect(state.filter).toBeUndefined();
    notebookMapKey(state, key("backspace"));
    expect(labels(state)).toEqual(["Home", "Tools", "B"]);
    notebookMapKey(state, key("/"));
    notebookMapKey(state, key("a"));
    notebookMapKey(state, key("escape"));
    expect(state.filter).toBeUndefined();
    expect(labels(state)).toEqual(["Home", "Tools", "B"]);
  });

  test("unfolds the selection's branch over its neighbours in the map view, leaving siblings where they were", () => {
    const state = new NotebookMapState(tree());
    notebookMapKey(state, key("v"));
    const spots = () => {
      const root = state.map.placed[0]!;
      return Object.fromEntries(state.map.placed.filter((item) => item.depth === 1).map((item) => [item.node.label, item.row - root.row]));
    };
    const before = spots();
    notebookMapKey(state, key("l"));
    notebookMapKey(state, key("l"));
    expect(labels(state)).toEqual(["Home", "Tools", "A", "Part one"]);
    expect(spots()).toEqual(before);
    const placed = state.map.placed;
    const column = placed.filter((item) => item.layer === -1 && item.depth === 1 && item.side === "right");
    const unfolded = placed.filter((item) => item.layer !== -1 && item.side === "right");
    expect(Math.min(...unfolded.map((item) => item.col))).toBeGreaterThan(Math.max(...column.map((item) => item.col + item.width)));
  });

  test("gives columns further up from the selection shorter labels in the map view", () => {
    const pages = [
      { page: "index.md", source: "# Home\n\n## A section with a very long name indeed\n\n### A subsection that is also long\n\n#### Leaf", tags: [] },
    ].map(({ page, source, tags }) => ({ page, document: parseDocument(source), tags }));
    const state = new NotebookMapState(buildNotebookTree(pages, (_from, target) => ({ page: target }), "index.md"));
    notebookMapKey(state, key("v"));
    const width = (label: string) => state.map.placed.find((item) => item.node.label === label)!.width;
    const section = "A section with a very long name indeed";
    expect(width(section)).toBe(32 + 2);
    notebookMapKey(state, key("l"));
    notebookMapKey(state, key("l"));
    expect(labels(state)).toEqual(["Home", section, "A subsection that is also long", "Leaf"]);
    expect(width(section)).toBe(7 + 2);
    expect(width("A subsection that is also long")).toBe(13 + 2);
  });

  test("draws a leaf's opening text beside it in the map view, without letting you step into it", () => {
    const state = new NotebookMapState(tree());
    notebookMapKey(state, key("v"));
    state.selectPage("d.md", 0);
    expect(state.map.placed.filter((item) => item.node.kind === "text").map((item) => item.node.label)).toEqual(["Some text about d."]);
    notebookMapKey(state, key("l"));
    expect(labels(state)).toEqual(["Home", "D"]);
  });

  test("centres a branch on its parent, unless it is taller than the map, when its first child starts at the top of the map", () => {
    const source = ["# P", ...Array.from({ length: 6 }, (_, at) => `## H${at}`)].join("\n\n");
    const state = new NotebookMapState(buildNotebookTree([{ page: "index.md", document: parseDocument(`# Home\n\n- [P](p.md)`), tags: [] }, { page: "p.md", document: parseDocument(source), tags: [] }], (_from, target) => ({ page: target }), "index.md"));
    notebookMapKey(state, key("v"));
    const rows = () => state.map.placed.filter((item) => item.parent === state.selected).map((item) => item.row - state.choice.row);
    expect(rows()).toEqual([-2, -1, 0, 1, 2, 3]);
    state.viewRows = 2;
    state.selectPage("p.md", 0);
    expect(rows()).toEqual([-1, 0, 1, 2, 3, 4]);
  });

  test("prunes the map view to the matches and the paths to them while filtering", () => {
    const state = new NotebookMapState(tree());
    notebookMapKey(state, key("v"));
    notebookMapKey(state, key("/"));
    for (const ch of "part") notebookMapKey(state, key(ch));
    expect(state.map.placed.map((item) => item.node.label).sort()).toEqual(["A", "C", "Home", "Part", "Part one", "Tools"]);
    notebookMapKey(state, key("return"));
    expect(state.map.placed.some((item) => item.node.label === "B")).toBe(true);
  });

  test("lands with Enter on anything but a portal or tag, switches views with v, and exits with Esc", () => {
    const state = new NotebookMapState(tree());
    expect(notebookMapKey(state, key("return"))).toBe("land");
    expect(notebookMapKey(state, key("v"))).toBe("move");
    expect(state.view).toBe("map");
    expect(notebookMapKey(state, key("escape"))).toBe("exit");
  });
});
