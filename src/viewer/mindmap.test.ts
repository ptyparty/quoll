import { describe, expect, test } from "bun:test";
import { parseDocument } from "../document.ts";
import { buildMindMap, layoutMindMap, type MapNode, type MindMap } from "./mindmap.ts";

const design = ["# Checkout", "", "## Goals", "See [[decisions]].", "### Fewer steps", "## Plan", "### Phase 1", "### Phase 2", "## Risks"].join("\n");
const pages: Record<string, string> = {
  "design.md": design,
  "decisions.md": ["# Decisions", "## Saved cards", "Back to [[design]].", "## Coupons", "See [[pricing]]."].join("\n"),
  "pricing.md": ["# Pricing", "## Tiers"].join("\n"),
};

function map(page: string): MapNode {
  return buildMindMap(page, parseDocument(pages[page]!), (target) => ({ page: `${target}.md` }));
}

function draw(drawn: MindMap): string {
  return drawn.cells.map((row) => row.map((cell) => cell.ch).join("").trimEnd()).join("\n");
}

describe("mind map", () => {
  test("branches the page's headings to the right in page order, with each section's links under it", () => {
    expect(draw(layoutMindMap(map("design.md")))).toBe(
      [
        "           ┌─ Goals ─┬─ ↗ decisions",
        "           │         └─ Fewer steps",
        "           │",
        " Checkout ─┼─ Plan ──┬─ Phase 1",
        "           │         └─ Phase 2",
        "           │",
        "           └─ Risks",
      ].join("\n"),
    );
  });

  test("skips links back to the page itself and repeats of a link in one section", () => {
    const root = buildMindMap("solo.md", parseDocument("# Solo\n\n[[solo]] [[other]] [[other|again]]"), (target) => ({ page: `${target}.md` }));
    expect(root.children.map((child) => child.label)).toEqual(["other"]);
  });
});
