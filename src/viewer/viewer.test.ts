import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Viewer } from "./viewer.ts";

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

async function open(follow = true): Promise<{ setup: TestRendererSetup; viewer: Viewer }> {
  setup = await createTestRenderer({ width: 80, height: 16 });
  const viewer = new Viewer(setup.renderer, {
    root,
    follow,
    images: () => ({ enabled: false, write: () => {} }),
    edit: async (file, line) => {
      edits.push({ file, line });
    },
  });
  viewer.start();
  await settle(setup);
  return { setup, viewer };
}

async function settle(setup: TestRendererSetup): Promise<string> {
  let previous = "";
  let steady = 0;
  for (let frame = 0; frame < 100 && steady < 4; frame++) {
    await setup.renderOnce();
    await Bun.sleep(10);
    const current = setup.captureCharFrame();
    steady = current === previous && current.trim().split("\n").length > 1 ? steady + 1 : 0;
    previous = current;
  }
  return previous;
}

describe("viewer", () => {
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
});
