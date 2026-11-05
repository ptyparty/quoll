import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CodeRenderable, RGBA, type Renderable } from "@opentui/core";
import { MouseButtons, createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MermaidRenderer } from "../render/mermaid.ts";
import { theme } from "../render/theme.ts";
import { tinyPng } from "../render/test-images.ts";
import { Viewer, type ViewerOptions } from "./viewer.ts";
import { ContextRequest } from "../context.ts";

let setup: TestRendererSetup | undefined;
let root: string;
let edits: { file: string; line: number }[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "quoll-viewer-"));
  mkdirSync(join(root, "design"));
  edits = [];
});

afterEach(async () => {
  await setup?.dispose();
  setup = undefined;
  rmSync(root, { recursive: true, force: true });
});

const longPlan = ["# Plan", "intro", "", ...Array.from({ length: 40 }, (_, index) => `filler ${index}`), "", "## Rollout", "ship it carefully"].join("\n");

async function open(follow = true, options: Partial<ViewerOptions> = {}): Promise<{ setup: TestRendererSetup; viewer: Viewer }> {
  setup = await createTestRenderer({ width: 80, height: 16 });
  const viewer = new Viewer(setup.renderer, {
    root,
    follow,
    images: () => ({ enabled: false, write: () => {} }),
    edit: async (file, line) => {
      edits.push({ file, line });
    },
    ...options,
  });
  viewer.start();
  await settle(setup);
  return { setup, viewer };
}

function highlighting(renderable: Renderable): boolean {
  if (renderable instanceof CodeRenderable && renderable.isHighlighting) return true;
  return renderable.getChildren().some((child) => highlighting(child as Renderable));
}

async function settle(setup: TestRendererSetup): Promise<string> {
  let previous = "";
  let steady = 0;
  for (let frame = 0; frame < 100 && steady < 4; frame++) {
    await setup.renderOnce();
    await Bun.sleep(10);
    const current = setup.captureCharFrame();
    steady = current === previous && current.trim().split("\n").length > 1 && !highlighting(setup.renderer.root) ? steady + 1 : 0;
    previous = current;
  }
  return previous;
}

describe("viewer", () => {
  test("shows a mermaid diagram's source while it draws, then the drawing, or the source with the reason it failed", async () => {
    writeFileSync(join(root, "index.md"), "# Index\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```mermaid\nbroken\n```");
    const gate = Promise.withResolvers<void>();
    const mermaid = new MermaidRenderer(join(root, ".cache"), "/usr/bin/chrome", async (source, png) => {
      await gate.promise;
      if (source === "broken") throw new Error("Parse error on line 1");
      await Bun.write(png, tinyPng(40, 20));
    });
    const written: string[] = [];
    const { setup } = await open(true, { mermaid, images: () => ({ enabled: true, write: (commands) => written.push(...commands) }) });
    let frame = setup.captureCharFrame();
    expect(frame).toContain("A --> B");
    expect(frame).toContain("Drawing the diagram…");
    gate.resolve();
    await Bun.sleep(20);
    frame = await settle(setup);
    expect(frame).not.toContain("A --> B");
    expect(written.some((command) => command.startsWith("\x1b_G"))).toBe(true);
    expect(frame).toContain("broken");
    expect(frame).toContain("Parse error on line 1");
  });

  test("shows mermaid source when the terminal can't show images", async () => {
    writeFileSync(join(root, "index.md"), "# Index\n\n```mermaid\nflowchart LR\n  A --> B\n```");
    const mermaid = new MermaidRenderer(join(root, ".cache"), "/usr/bin/chrome", async () => {
      throw new Error("should not draw");
    });
    const { setup } = await open(true, { mermaid });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("A --> B");
    expect(frame).not.toContain("Drawing");
  });

  test("opens index.md and follows a link picked from the link list", async () => {
    writeFileSync(join(root, "index.md"), "# Index\n\nSee [[plan|the plan]].");
    writeFileSync(join(root, "design", "plan.md"), "# Plan\n\nThe body.");
    const { setup, viewer } = await open();
    let frame = setup.captureCharFrame();
    expect(frame).toContain("See the plan.");
    expect(frame).toContain("index.md");
    setup.mockInput.pressKey("f");
    frame = await settle(setup);
    expect(frame).toContain("Links");
    expect(frame).toContain("the plan");
    setup.mockInput.pressEnter();
    frame = await settle(setup);
    expect(viewer.page).toBe("design/plan.md");
    expect(frame).toContain("The body.");
    expect(viewer.isFollowing).toBe(false);
    setup.mockInput.pressKey("H", { shift: true });
    frame = await settle(setup);
    expect(viewer.page).toBe("index.md");
  });

  test("walks the notebook's tree in the map, scrolls the page with Tab, and lands or exits", async () => {
    writeFileSync(join(root, "index.md"), "# Index\n\n## Design\n\n- [[plan|the plan]]");
    writeFileSync(join(root, "design", "plan.md"), longPlan);
    const { setup, viewer } = await open();
    setup.mockInput.pressKey("a");
    let frame = await settle(setup);
    expect(frame).toMatch(/^ Index › top of page\s*$/m);
    setup.mockInput.pressKey("j");
    frame = await settle(setup);
    expect(frame).toContain("▤ Plan ›");
    expect(frame).toContain("↑ top of page");
    expect(frame).toMatch(/^ Index › Plan\s*$/m);
    setup.mockInput.pressKey("l");
    frame = await settle(setup);
    expect(viewer.page).toBe("design/plan.md");
    expect(frame).toMatch(/^ Index › Plan › top of page\s*$/m);
    setup.mockInput.pressKey("j");
    frame = await settle(setup);
    expect(viewer.page).toBe("design/plan.md");
    expect(frame).toContain("ship it carefully");
    expect(frame).not.toContain("intro");
    setup.mockInput.pressTab();
    for (let line = 0; line < 3; line++) setup.mockInput.pressKey("k");
    frame = await settle(setup);
    expect(frame).toContain("j/k scroll page");
    expect(frame).toContain("filler 37");
    expect(frame).toContain("│ Rollout");
    setup.mockInput.pressTab();
    setup.mockInput.pressTab();
    setup.mockInput.pressKey("q");
    await settle(setup);
    expect((viewer as unknown as { mindMap?: unknown }).mindMap).toBeUndefined();
    setup.mockInput.pressKey("a");
    await settle(setup);
    for (const ch of "/roll") setup.mockInput.pressKey(ch);
    frame = await settle(setup);
    expect(frame).toMatch(/^ \/roll  1\/1  │ Index › Plan › Rollout/m);
    setup.mockInput.pressEscape();
    await settle(setup);
    setup.mockInput.pressEscape();
    frame = await settle(setup);
    expect(viewer.page).toBe("index.md");
    expect(frame).not.toContain("Rollout");
    for (const name of ["a", "j", "a"]) setup.mockInput.pressKey(name);
    frame = await settle(setup);
    expect(viewer.page).toBe("design/plan.md");
    expect(frame).not.toContain("Plan ›");
    expect(frame).toContain("intro");
    for (const name of ["a", "v"]) setup.mockInput.pressKey(name);
    await settle(setup);
    expect(viewer.page).toBe("design/plan.md");
    setup.mockInput.pressEscape();
    await settle(setup);
    setup.mockInput.pressKey("H", { shift: true });
    await settle(setup);
    expect(viewer.page).toBe("index.md");
  });

  test("shows where a link was written while it is highlighted in the map, and its destination beside it", async () => {
    writeFileSync(join(root, "index.md"), "# Index\n\n- [[plan]]\n- [[notes]]");
    writeFileSync(join(root, "notes.md"), "# Notes\n\n## Ideas\n\nCompare with [[plan]].");
    writeFileSync(join(root, "design", "plan.md"), longPlan);
    const { setup, viewer } = await open();
    for (const name of ["a", "j", "j", "l", "j", "l"]) setup.mockInput.pressKey(name);
    const frame = await settle(setup);
    expect(frame).toMatch(/^ Index › Notes › Ideas › Plan \(design\/plan\)\s*$/m);
    expect(frame).toContain("⤳ Plan");
    expect(viewer.page).toBe("notes.md");
    expect(frame).toContain("Compare with plan.");
  });

  test("names a placed page by its title, lights the link that places it, and opens the page one step in", async () => {
    writeFileSync(join(root, "index.md"), "# Index\n\n## Design\n\nRead [[plan|the plan]] first.");
    writeFileSync(join(root, "design", "plan.md"), longPlan);
    const { setup, viewer } = await open();
    for (const name of ["a", "j"]) setup.mockInput.pressKey(name);
    let frame = await settle(setup);
    expect(frame).toMatch(/^ Index › Plan\s*$/m);
    expect(viewer.page).toBe("index.md");
    expect(frame).toContain("Read the plan first.");
    const paragraph = setup.captureSpans().lines.find((line) => line.spans.map((span) => span.text).join("").includes("Read the plan"))!;
    const lit = paragraph.spans.filter((span) => span.bg.equals(RGBA.fromHex(theme.selection)));
    expect(lit.map((span) => span.text).join("")).toBe("the plan");
    setup.mockInput.pressKey("l");
    frame = await settle(setup);
    expect(frame).toMatch(/^ Index › Plan › top of page\s*$/m);
    expect(viewer.page).toBe("design/plan.md");
  });

  test("lists the notebook's tags and opens a page picked from one", async () => {
    writeFileSync(join(root, "index.md"), "---\ntags: [overview]\n---\n# Index");
    writeFileSync(join(root, "design", "plan.md"), "---\ntags:\n  - design\n  - rollout\n---\n# Plan\n\nThe body.");
    writeFileSync(join(root, "design", "logo.md"), "---\ntags: [design]\n---\n# Logo");
    const { setup, viewer } = await open();
    expect(setup.captureCharFrame()).toContain("index.md #overview");
    setup.mockInput.pressKey("t");
    let frame = await settle(setup);
    expect(frame).toContain("Tags");
    expect(frame).toMatch(/#design\s+2 pages/);
    expect(frame).toMatch(/#rollout\s+1 page/);
    setup.mockInput.pressEnter();
    frame = await settle(setup);
    expect(frame).toContain("Pages tagged #design");
    expect(frame).toContain("design/plan.md");
    expect(frame).toContain("design/logo.md");
    expect(frame).not.toMatch(/│.*index\.md/);
    for (const char of "plan") setup.mockInput.pressKey(char);
    await settle(setup);
    setup.mockInput.pressEnter();
    frame = await settle(setup);
    expect(viewer.page).toBe("design/plan.md");
    expect(frame).toContain("The body.");
  });

  test("the page list shows each page's tags and matches on them", async () => {
    writeFileSync(join(root, "index.md"), "# Index");
    writeFileSync(join(root, "design", "plan.md"), "---\ntags: [rollout]\n---\n# Plan");
    const { setup } = await open();
    setup.mockInput.pressKey("p");
    let frame = await settle(setup);
    expect(frame).toMatch(/design\/plan\.md\s+\d+s ago\s+#rollout/);
    for (const char of "#roll") setup.mockInput.pressKey(char);
    frame = await settle(setup);
    expect(frame).toContain("design/plan.md");
    expect(frame).not.toMatch(/│.*index\.md/);
  });

  test("listing tags before a new page's change arrives still follows it there", async () => {
    writeFileSync(join(root, "index.md"), "# Index");
    const { setup, viewer } = await open();
    writeFileSync(join(root, "design", "plan.md"), "---\ntags: [design]\n---\n# Plan");
    setup.mockInput.pressKey("t");
    expect(await settle(setup)).toContain("#design");
    setup.mockInput.pressEscape();
    await settle(setup);
    viewer.fileChanged("design/plan.md");
    await settle(setup);
    expect(viewer.page).toBe("design/plan.md");
  });

  test("shows an overview when there is no index page", async () => {
    writeFileSync(join(root, "design", "plan.md"), "# Plan");
    const { setup } = await open();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("There is no index.md yet.");
    expect(frame).toContain("design/plan");
  });

  test("follow mode jumps to the part of a page that changed", async () => {
    writeFileSync(join(root, "index.md"), "# Index");
    writeFileSync(join(root, "design", "plan.md"), longPlan);
    const { setup, viewer } = await open();
    writeFileSync(join(root, "design", "plan.md"), longPlan.replace("ship it carefully", "ship it on Tuesday"));
    viewer.fileChanged("design/plan.md");
    const frame = await settle(setup);
    expect(viewer.page).toBe("design/plan.md");
    expect(frame).toContain("ship it on Tuesday");
    expect(frame).not.toContain("intro");
  });

  describe("change bars", () => {
    const paragraphs = ["# Plan", ...Array.from({ length: 20 }, (_, index) => `para ${index}`)].join("\n\n");

    test("bar changed blocks and mark removals until they are scrolled onto the screen", async () => {
      writeFileSync(join(root, "design", "plan.md"), paragraphs);
      const { setup, viewer } = await open();
      writeFileSync(join(root, "design", "plan.md"), paragraphs.replace("para 1\n", "para 1 edited\n").replace("para 3\n\n", "").replace("para 18", "para 18 edited"));
      viewer.fileChanged("design/plan.md");
      let frame = await settle(setup);
      expect(frame).toMatch(/^▎para 1 edited/m);
      expect(frame).toMatch(/^──\s*\n para 4/m);
      setup.mockInput.pressKey("j");
      frame = await settle(setup);
      expect(frame).toMatch(/^ para 1 edited/m);
      expect(frame).not.toContain("──");
      setup.mockInput.pressKey("G");
      frame = await settle(setup);
      expect(frame).toMatch(/^ para 18 edited/m);
    });

    test("opening a changed page keeps its bars until you scroll", async () => {
      writeFileSync(join(root, "index.md"), "# Index");
      writeFileSync(join(root, "design", "plan.md"), paragraphs);
      const { setup, viewer } = await open(false);
      writeFileSync(join(root, "design", "plan.md"), paragraphs.replace("para 1\n", "para 1 edited\n"));
      viewer.fileChanged("design/plan.md");
      setup.mockInput.pressKey("p");
      await settle(setup);
      setup.mockInput.pressEnter();
      let frame = await settle(setup);
      expect(viewer.page).toBe("design/plan.md");
      expect(frame).toMatch(/^▎para 1 edited/m);
      setup.mockInput.pressKey("j");
      frame = await settle(setup);
      expect(frame).toMatch(/^ para 1 edited/m);
    });

    test("a page that was just created has no bars", async () => {
      writeFileSync(join(root, "index.md"), "# Index");
      const { setup, viewer } = await open();
      writeFileSync(join(root, "design", "plan.md"), paragraphs);
      viewer.fileChanged("design/plan.md");
      const frame = await settle(setup);
      expect(viewer.page).toBe("design/plan.md");
      expect(frame).toContain("para 1");
      expect(frame).not.toContain("▎");
    });
  });

  test("follow mode lands inside a long section near the changed line", async () => {
    writeFileSync(join(root, "design", "plan.md"), longPlan);
    const { setup, viewer } = await open();
    writeFileSync(join(root, "design", "plan.md"), longPlan.replace("filler 25", "filler 25 rewritten"));
    viewer.fileChanged("design/plan.md");
    const frame = await settle(setup);
    expect(frame).toContain("filler 25 rewritten");
    expect(frame).not.toContain("filler 5\n");
  });

  test("without follow, changes elsewhere leave the view alone", async () => {
    writeFileSync(join(root, "index.md"), "# Index");
    writeFileSync(join(root, "design", "plan.md"), "# Plan");
    const { setup, viewer } = await open(false);
    writeFileSync(join(root, "design", "plan.md"), "# Plan\nmore");
    viewer.fileChanged("design/plan.md");
    await settle(setup);
    expect(viewer.page).toBe("index.md");
    setup.mockInput.pressKey("w");
    await settle(setup);
    expect(viewer.isFollowing).toBe(true);
    expect(viewer.page).toBe("design/plan.md");
  });

  test("show scrolls to a heading and scrolling stops following", async () => {
    writeFileSync(join(root, "design", "plan.md"), longPlan);
    const { setup, viewer } = await open();
    expect(viewer.show("plan#rollout")).toEqual({ ok: true });
    let frame = await settle(setup);
    expect(frame).toContain("ship it carefully");
    expect(frame).not.toContain("intro");
    expect(viewer.isFollowing).toBe(false);
    expect(viewer.show("nowhere")).toEqual({ error: "No page matches nowhere" });
    expect(viewer.show("plan#Nope")).toEqual({ error: "Showing design/plan.md, but it has no heading Nope" });
    setup.mockInput.pressKey("g");
    frame = await settle(setup);
    expect(frame).toContain("intro");
    expect(viewer.isFollowing).toBe(false);
  });

  test("edit opens the page at the first line in view", async () => {
    writeFileSync(join(root, "design", "plan.md"), longPlan);
    const { setup, viewer } = await open();
    viewer.show("plan#rollout");
    await settle(setup);
    setup.mockInput.pressKey("e");
    await settle(setup);
    expect(edits).toEqual([{ file: join(root, "design", "plan.md"), line: 45 }]);
  });

  test("changes and show requests made while editing land after the editor closes", async () => {
    writeFileSync(join(root, "index.md"), "# Index");
    writeFileSync(join(root, "design", "plan.md"), longPlan);
    let finish = () => {};
    setup = await createTestRenderer({ width: 80, height: 16 });
    const viewer = new Viewer(setup.renderer, {
      root,
      follow: true,
      images: () => ({ enabled: false, write: () => {} }),
      edit: () => new Promise((resolve) => (finish = resolve)),
    });
    viewer.start();
    await settle(setup);
    setup.mockInput.pressKey("e");
    writeFileSync(join(root, "design", "plan.md"), `${longPlan}\nlate line`);
    viewer.fileChanged("design/plan.md");
    expect(viewer.show("plan#rollout")).toEqual({ ok: true });
    expect(viewer.page).toBe("index.md");
    finish();
    const frame = await settle(setup);
    expect(viewer.page).toBe("design/plan.md");
    expect(frame).toContain("Rollout");
    setup.mockInput.pressKey("p");
    expect(await settle(setup)).toContain("● design/plan.md");
  });

  test("an editor that fails to start is reported, not fatal", async () => {
    writeFileSync(join(root, "index.md"), "# Index");
    setup = await createTestRenderer({ width: 80, height: 16 });
    const viewer = new Viewer(setup.renderer, {
      root,
      follow: true,
      images: () => ({ enabled: false, write: () => {} }),
      edit: async () => {
        throw new Error("hx not found");
      },
    });
    viewer.start();
    await settle(setup);
    setup.mockInput.pressKey("e");
    expect(await settle(setup)).toContain("Could not edit: hx not found");
  });

  test("a viewer on a parent folder shows pages from a story notebook inside it", async () => {
    mkdirSync(join(root, "sc-1"));
    writeFileSync(join(root, "sc-1", "plan.md"), longPlan);
    const { setup, viewer } = await open();
    expect(viewer.show("plan#rollout", join(root, "sc-1"))).toEqual({ ok: true });
    const frame = await settle(setup);
    expect(viewer.page).toBe("sc-1/plan.md");
    expect(frame).toContain("ship it carefully");
    expect(viewer.show("#Plan", join(root, "sc-1"))).toEqual({ ok: true });
    expect(viewer.show("#Nope", join(root, "sc-1"))).toEqual({ error: "Showing sc-1/plan.md, but it has no heading Nope" });
    expect(viewer.show("plan", join(root, "..", "elsewhere"))).toEqual({ ignored: true });
  });

  test("a viewer on a folder inside the notebook takes shows for pages in that folder", async () => {
    writeFileSync(join(root, "design", "plan.md"), longPlan);
    writeFileSync(join(root, "index.md"), "# Index");
    setup = await createTestRenderer({ width: 80, height: 16 });
    const viewer = new Viewer(setup.renderer, { root: join(root, "design"), follow: true, images: () => ({ enabled: false, write: () => {} }), edit: async () => {} });
    viewer.start();
    await settle(setup);
    expect(viewer.show("design/plan", root)).toEqual({ ok: true });
    expect(viewer.page).toBe("plan.md");
    expect(viewer.show("index", root)).toEqual({ ignored: true });
  });

  test("shows commits to push and pull, and syncs them on P", async () => {
    writeFileSync(join(root, "index.md"), "# Index");
    let status = { ahead: 2, behind: 1, merging: false, conflicts: [] as string[], elsewhere: [] as string[] };
    const syncs: number[] = [];
    const git = {
      status: async () => status,
      fetch: async () => {},
      sync: async () => (syncs.push(status.ahead), (status = { ...status, ahead: 0, behind: 0 }), { pushed: syncs.at(-1)! }),
      abort: async () => undefined,
    };
    const { setup } = await open(false, { git });
    let frame = await settle(setup);
    expect(frame).toContain("↑2 ↓1 P sync");
    setup.mockInput.pressKey("P", { shift: true });
    await Bun.sleep(20);
    frame = await settle(setup);
    expect(syncs).toEqual([2]);
    expect(frame).toContain("Pushed 2 commits");
    expect(frame).not.toContain("↑2");
  });

  test("won't settle a conflict that changed on disk since the page was drawn", async () => {
    writeFileSync(join(root, "index.md"), "# Index\n\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> x\n");
    const { setup, viewer } = await open(false);
    await settle(setup);
    setup.mockInput.pressKey("n");
    await settle(setup);
    const changed = "# Index\n\n<<<<<<< HEAD\nmine, edited\n=======\ntheirs\n>>>>>>> x\n";
    writeFileSync(join(root, "index.md"), changed);
    setup.mockInput.pressKey("1");
    const frame = await settle(setup);
    expect(readFileSync(join(root, "index.md"), "utf8")).toBe(changed);
    expect(frame).toContain("The page changed on disk");
    expect(viewer.page).toBe("index.md");
  });

  test("pops up the merge's conflicts outside this notebook, which block finishing it", async () => {
    writeFileSync(join(root, "index.md"), "# Index");
    const status = { ahead: 1, behind: 0, merging: true, conflicts: [] as string[], elsewhere: ["/work/notes/other/plan.md"] };
    const git = { status: async () => status, fetch: async () => {}, sync: async () => ({ conflicts: [] as string[] }), abort: async () => undefined };
    const { setup } = await open(false, { git });
    let frame = await settle(setup);
    expect(frame).toContain("1 elsewhere");
    setup.mockInput.pressKey("P", { shift: true });
    await Bun.sleep(20);
    frame = await settle(setup);
    expect(frame).toContain("outside this notebook");
    expect(frame).toContain("/work/notes/other/plan.md");
    setup.mockInput.pressEnter();
    await Bun.sleep(20);
    await settle(setup);
    expect(edits).toEqual([{ file: "/work/notes/other/plan.md", line: 1 }]);
  });

  test("draws a merge conflict as both sides, and settles it with a key", async () => {
    writeFileSync(join(root, "index.md"), "# Index\n\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> origin/main\n\nafter");
    const status = { ahead: 1, behind: 0, merging: true, conflicts: ["index.md"], elsewhere: [] as string[] };
    const git = { status: async () => status, fetch: async () => {}, sync: async () => ({ conflicts: status.conflicts }), abort: async () => undefined };
    const { setup } = await open(false, { git });
    let frame = await settle(setup);
    expect(frame).toContain("merge conflict");
    expect(frame).toContain("yours · HEAD");
    expect(frame).toContain("theirs · origin/main");
    expect(frame).toContain("⚠ merging · 1 conflicted page · P finish · X abort");
    setup.mockInput.pressKey("n");
    await settle(setup);
    setup.mockInput.pressKey("b");
    frame = await settle(setup);
    expect(readFileSync(join(root, "index.md"), "utf8")).toBe("# Index\n\nmine\ntheirs\n\nafter");
    expect(frame).not.toContain("merge conflict");
  });

  describe("context for komux", () => {
    const page = ["# Plan", "", "intro line", "", "## Rollout", "", "- ship it", "- watch it", "", "last words"].join("\n");

    function request(): { request: ContextRequest; replies: unknown[] } {
      const replies: unknown[] = [];
      return { request: new ContextRequest((reply) => replies.push(reply)), replies };
    }

    async function asked(text = page): Promise<{ setup: TestRendererSetup; viewer: Viewer; replies: unknown[]; request: ContextRequest }> {
      writeFileSync(join(root, "index.md"), text);
      const opened = await open(false);
      await settle(opened.setup);
      const { request: asking, replies } = request();
      opened.viewer.askForContext(asking);
      return { ...opened, replies, request: asking };
    }

    const labels = (replies: unknown[]) => replies.flatMap((reply) => ((reply as { attach?: { label: string }[] }).attach ?? []).map((attachment) => attachment.label));

    test("puts a hint letter by each block and list item, and pressing one attaches it", async () => {
      const { setup, replies } = await asked();
      const frame = await settle(setup);
      expect(frame).toMatch(/^\s*a\s+.*Plan/m);
      expect(frame).toMatch(/^\s*s\s+intro line/m);
      expect(frame).toContain("a–z attach");
      setup.mockInput.pressKey("f");
      await settle(setup);
      expect(replies).toEqual([
        { picking: "Pick a block in quoll · Esc cancels" },
        { attach: [{ label: 'index.md:7 · "ship it"', text: `Comment on index.md, line 7 under "Plan › Rollout":\nFile: ${join(root, "index.md")}\n> - ship it\n` }] },
      ]);
      expect(await settle(setup)).toContain('Attached index.md:7 · "ship it"');
    });

    test("picks a block on the page below while the mind map is open, then hands the map its keys back", async () => {
      writeFileSync(join(root, "index.md"), page);
      const { setup, viewer } = await open(false);
      setup.mockInput.pressKey("a");
      await settle(setup);
      const { request: asking, replies } = request();
      viewer.askForContext(asking);
      let frame = await settle(setup);
      expect(frame).toContain("a–z attach");
      setup.mockInput.pressKey("s");
      frame = await settle(setup);
      expect(labels(replies)).toEqual(['index.md:3 · "intro line"']);
      expect(frame).toMatch(/^ Plan › top of page\s*$/m);
      expect((viewer as unknown as { mapFocused: boolean }).mapFocused).toBe(true);
    });

    test("j and k move the selection, Enter attaches it, and Esc cancels", async () => {
      const { setup, viewer, replies } = await asked();
      setup.mockInput.pressEscape();
      await settle(setup);
      expect(replies).toEqual([{ picking: "Pick a block in quoll · Esc cancels" }, { cancelled: true }]);
      expect(await settle(setup)).toContain("f links");
      const again = request();
      viewer.askForContext(again.request);
      setup.mockInput.pressKey("j");
      setup.mockInput.pressKey("j");
      setup.mockInput.pressKey("k");
      setup.mockInput.pressEnter();
      await settle(setup);
      expect(labels(again.replies)).toEqual(['index.md:3 · "intro line"']);
    });

    test("komux cancelling leaves pick mode", async () => {
      const { setup, request: asking } = await asked();
      expect(await settle(setup)).toContain("a–z attach");
      asking.end();
      expect(await settle(setup)).toContain("f links");
    });

    test("c no longer starts picking on its own", async () => {
      writeFileSync(join(root, "index.md"), page);
      const { setup } = await open(false);
      setup.mockInput.pressKey("c");
      expect(await settle(setup)).not.toContain("a–z attach");
    });

    test("clicking a block with the left button attaches it, only while picking one", async () => {
      writeFileSync(join(root, "index.md"), page);
      const { setup, viewer } = await open(false);
      const row = () => setup.captureCharFrame().split("\n").findIndex((line) => line.includes("last words"));
      await settle(setup);
      await setup.mockMouse.click(3, row());
      await settle(setup);
      const { request: asking, replies } = request();
      viewer.askForContext(asking);
      await settle(setup);
      await setup.mockMouse.click(3, row(), MouseButtons.RIGHT);
      await settle(setup);
      expect(labels(replies)).toEqual([]);
      await setup.mockMouse.click(3, row());
      await settle(setup);
      expect(labels(replies)).toEqual(['index.md:10 · "last words"']);
    });

    test("scrolling while picking moves the hint letters to the blocks on screen", async () => {
      const { setup, replies } = await asked(Array.from({ length: 40 }, (_, index) => `para ${index}`).join("\n\n"));
      await settle(setup);
      for (let step = 0; step < 10; step++) await setup.mockMouse.scroll(3, 3, "down");
      const frame = await settle(setup);
      const top = /^\s*a\s+para (\d+)/m.exec(frame);
      expect(top).not.toBeNull();
      expect(Number(top![1])).toBeGreaterThan(0);
      setup.mockInput.pressKey("a");
      await settle(setup);
      expect(labels(replies)).toEqual([`index.md:${Number(top![1]) * 2 + 1} · "para ${top![1]}"`]);
    });

    test("says there is nothing to attach with no page open", async () => {
      const { setup, viewer } = await open(false);
      await settle(setup);
      const { request: asking, replies } = request();
      viewer.askForContext(asking);
      expect(replies).toEqual([{ none: "No page open in quoll" }]);
    });
  });

  test("runs a menu entry by its letter after space, and pages down with d instead", async () => {
    writeFileSync(join(root, "index.md"), longPlan);
    const { setup } = await open(false);
    setup.mockInput.pressKey(" ");
    let frame = await settle(setup);
    expect(frame).toContain("f  find page");
    expect(frame).toContain("intro");
    setup.mockInput.pressKey("f");
    frame = await settle(setup);
    expect(frame).not.toContain("find page");
    expect(frame).toContain("Pages");
    setup.mockInput.pressEscape();
    await settle(setup);
    setup.mockInput.pressKey("d");
    frame = await settle(setup);
    expect(frame).not.toContain("intro");
    expect(frame).toContain("filler 12");
  });

  test("lists every key for the page on space ?, from the same table komux is told", async () => {
    writeFileSync(join(root, "index.md"), "# Index\n\nBody.");
    setup = await createTestRenderer({ width: 120, height: 40 });
    const viewer = new Viewer(setup.renderer, { root, follow: false, images: () => ({ enabled: false, write: () => {} }), edit: async () => {} });
    viewer.start();
    await settle(setup);
    setup.mockInput.pressKey(" ");
    setup.mockInput.pressKey("?");
    const frame = await settle(setup);
    expect(frame).toContain("Keys · page");
    expect(frame).toContain("p ␣f");
    expect(frame).toContain("find page");
    expect(frame).toContain("Pickers");
    const groups = viewer.keys().groups;
    expect(groups.map((group) => group.name)).toEqual(["Keys"]);
    expect(groups[0]!.commands.find((command) => command.label === "close")).toEqual({ label: "close", keys: "Esc q ? ^c", send: "\x1b" });
    setup.mockInput.pressEscape();
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("Keys · page");
  });

  test("tells komux the keys that work in the page, a picker, and the atlas", async () => {
    writeFileSync(join(root, "index.md"), "# Index\n\nBody.");
    const { setup, viewer } = await open(false);
    const page = viewer.keys();
    expect(page.app).toBe("quoll");
    const names = page.groups.map((group) => group.name);
    expect(names).toEqual(["Go", "Search", "Page", "Scroll", "Notebook"]);
    const all = page.groups.flatMap((group) => group.commands);
    expect(all.find((command) => command.label === "find page")).toEqual({ label: "find page", keys: "p ␣f", send: "p" });
    expect(all.find((command) => command.label === "keys")).toEqual({ label: "keys", keys: "␣?", send: " ?" });
    expect(all.find((command) => command.label === "down half a page")).toEqual({ label: "down half a page", keys: "^d", send: "\x04" });
    expect(all.some((command) => command.label === "next match" || command.label === "keep yours")).toBe(false);
    setup.mockInput.pressKey("p");
    await settle(setup);
    expect(viewer.keys().groups.map((group) => group.name)).toEqual(["Pickers"]);
    expect(viewer.keys().groups[0]!.commands[0]).toEqual({ label: "filter", keys: "type" });
    setup.mockInput.pressEscape();
    await settle(setup);
    setup.mockInput.pressKey("a");
    await settle(setup);
    const atlas = viewer.keys().groups.flatMap((group) => group.commands.map((command) => command.label));
    expect(atlas).toContain("land on the page");
    expect(atlas).not.toContain("find page");
  });

  test("searches the page with /, lights every match, and steps through them with n and N", async () => {
    writeFileSync(join(root, "index.md"), ["# Index", "", "A coupon here.", "", ...Array.from({ length: 30 }, (_, index) => `filler ${index}`), "", "Another coupon there.", "", "| Col | Note |", "| --- | --- |", "| x | a coupon cell |"].join("\n"));
    const { setup, viewer } = await open(false);
    for (const ch of "/coupon") setup.mockInput.pressKey(ch);
    let frame = await settle(setup);
    expect(frame).toMatch(/\/coupon .*1\/3/);
    const lit = (color: string) =>
      setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .filter((span) => span.bg.equals(RGBA.fromHex(color)))
        .map((span) => span.text);
    expect(lit(theme.match)).toEqual(["coupon"]);
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey("n");
    frame = await settle(setup);
    expect(frame).toContain("2/3");
    expect(frame).toContain("Another coupon there.");
    expect(frame).not.toContain("A coupon here.");
    setup.mockInput.pressKey("n");
    frame = await settle(setup);
    expect(frame).toContain("3/3");
    expect(lit(theme.match)).toEqual(["coupon"]);
    expect(lit(theme.selection)).toContain("coupon");
    setup.mockInput.pressKey("N", { shift: true });
    setup.mockInput.pressKey("N", { shift: true });
    frame = await settle(setup);
    expect(frame).toContain("A coupon here.");
    expect(viewer.keys().groups.find((group) => group.name === "Search")!.commands.map((command) => command.label)).toContain("next match");
    setup.mockInput.pressEscape();
    frame = await settle(setup);
    expect(frame).not.toContain("1/3");
    expect(lit(theme.match)).toEqual([]);
    expect(lit(theme.selection)).toEqual([]);
  });

  test("search finds matches deep in long tables and wrapped paragraphs, keeps them through a redraw, and puts things back on Esc", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => `| row ${index} | ${index === 19 ? "the needle" : "hay"} |`);
    const wrapped = Array.from({ length: 60 }, () => "word").join(" ") + " needle";
    writeFileSync(join(root, "index.md"), ["# Index", "", "See [notes](https://example.com).", "", "| Name | Value |", "| --- | --- |", ...rows, "", ...Array.from({ length: 20 }, (_, index) => `filler ${index}`), "", wrapped].join("\n"));
    const { setup, viewer } = await open(false);
    const codes = () => {
      const found: CodeRenderable[] = [];
      const visit = (view: Renderable) => (view instanceof CodeRenderable ? found.push(view) : view.getChildren().forEach((child) => visit(child as Renderable)));
      visit(setup.renderer.root);
      return found;
    };
    const before = codes().map((code) => code.onChunks);
    const lit = () =>
      setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .filter((span) => span.bg.equals(RGBA.fromHex(theme.match)))
        .map((span) => span.text);
    for (const ch of "/needle") setup.mockInput.pressKey(ch);
    let frame = await settle(setup);
    expect(frame).toContain("1/2");
    expect(frame).toContain("row 19");
    expect(lit()).toEqual(["needle"]);
    const table = (() => {
      const visit = (view: Renderable): Renderable | undefined => (view.constructor.name.startsWith("TextTable") ? view : view.getChildren().map((child) => visit(child as Renderable)).find(Boolean));
      return visit(setup.renderer.root) as unknown as { content: { text: string }[][][] };
    })();
    table.content = table.content.map((row) => row.map((cell) => cell.map((chunk) => ({ ...chunk, bg: undefined }))));
    frame = await settle(setup);
    expect(lit()).toEqual(["needle"]);
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey("n");
    frame = await settle(setup);
    expect(frame).toContain("2/2");
    expect(lit()).toEqual(["needle"]);
    setup.mockInput.pressKey("g");
    await settle(setup);
    for (const ch of "/needle") setup.mockInput.pressKey(ch);
    await settle(setup);
    setup.mockInput.pressEscape();
    frame = await settle(setup);
    expect(frame).toContain("See notes");
    expect(lit()).toEqual([]);
    expect(codes().map((code) => code.onChunks)).toEqual(before);
    expect(viewer.keys().groups.map((group) => group.name)).toContain("Go");
  });
});
