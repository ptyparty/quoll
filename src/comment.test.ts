import { describe, expect, test } from "bun:test";
import { commentContext } from "./comment.ts";
import { parseDocument } from "./document.ts";

const source = ["# Logo", "", "## Round 2", "", "### B. Swash", "", "The tail sweeps out", "under the bowl.", "", "![[images/q-swash.png]]", "", "```mermaid", "flowchart LR", "```"].join("\n");
const doc = parseDocument(source);
const target = (index: number) => ({ page: "logo.md", file: "/notes/logo.md", source, block: doc.blocks[index]!, headings: doc.headings });

describe("commentContext", () => {
  test("names the file, lines and heading path, and quotes the source", () => {
    const paragraph = doc.blocks.findIndex((block) => block.kind === "markdown" && block.text.startsWith("The tail"));
    expect(commentContext(target(paragraph))).toEqual({
      text: 'Comment on logo.md, lines 7–8 under "Logo › Round 2 › B. Swash":\nFile: /notes/logo.md\n> The tail sweeps out\n> under the bowl.\n',
      label: 'logo.md:7–8 · "The tail sweeps out"',
    });
  });

  test("says which image or diagram it is", () => {
    const image = doc.blocks.findIndex((block) => block.kind === "image");
    expect(commentContext({ ...target(image), asset: "/notes/images/q-swash.png" })).toEqual({
      text: 'Comment on logo.md, line 10 under "Logo › Round 2 › B. Swash", image /notes/images/q-swash.png:\nFile: /notes/logo.md\n> ![[images/q-swash.png]]\n',
      label: "logo.md:10 · image q-swash.png",
    });
    const diagram = doc.blocks.findIndex((block) => block.kind === "mermaid");
    expect(commentContext(target(diagram)).label).toBe("logo.md:12–14 · diagram");
    expect(commentContext(target(diagram)).text).toStartWith('Comment on logo.md, lines 12–14 under "Logo › Round 2 › B. Swash", a mermaid diagram:');
  });

  test("labels headings by their text and cuts long quotes and labels short", () => {
    expect(commentContext(target(0)).label).toBe('logo.md:1 · "Logo"');
    const long = Array.from({ length: 30 }, (_, index) => `line ${index} of a paragraph that goes on`).join("\n");
    const longDoc = parseDocument(long);
    const comment = commentContext({ page: "p.md", file: "/p.md", source: long, block: longDoc.blocks[0]!, headings: [] });
    expect(comment.text.split("\n").filter((line) => line.startsWith(">"))).toHaveLength(12);
    expect(comment.text).toContain("> …\n");
    expect(comment.label).toBe('p.md:1–30 · "line 0 of a paragraph that…"');
  });

  test("labels task items, code, tables and bare markers plainly", () => {
    const page = "- [ ] Ship the migration\n\n```ts\nconst a = 1;\n```\n\n~~~\nplain\n~~~\n\n| a |\n|---|\n| 1 |\n\n-";
    const parsed = parseDocument(page);
    const labels = parsed.blocks.map((block) => commentContext({ page: "p.md", file: "/p.md", source: page, block, headings: [] }).label.split(" · ")[1]);
    expect(labels).toEqual(['"Ship the migration"', "ts code", "code", "table", "block"]);
  });
});
