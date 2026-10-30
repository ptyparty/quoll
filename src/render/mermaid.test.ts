import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, MermaidRenderer, mermaidCacheDir } from "./mermaid.ts";

let dir: string;

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup() {
  dir = mkdtempSync(join(tmpdir(), "quoll-mermaid-"));
  const draws: string[] = [];
  let fail = false;
  const gate = Promise.withResolvers<void>();
  const renderer = new MermaidRenderer(dir, "/usr/bin/chrome", async (source, png) => {
    draws.push(source);
    await gate.promise;
    if (fail) throw new Error("Parse error on line 1");
    await Bun.write(png, "png");
  });
  return { renderer, draws, failNext: () => (fail = true), finish: () => gate.resolve() };
}

test("draws a diagram once in the background, then serves it from the cache", async () => {
  const { renderer, draws, finish } = setup();
  let drawn = 0;
  expect(renderer.diagram("flowchart LR", () => drawn++)).toEqual({ pending: true });
  expect(renderer.diagram("flowchart LR", () => drawn++)).toEqual({ pending: true });
  finish();
  await Bun.sleep(10);
  expect(drawn).toBe(1);
  const result = renderer.diagram("flowchart LR", () => drawn++);
  expect("png" in result && existsSync(result.png)).toBe(true);
  expect(draws).toEqual(["flowchart LR"]);
});

test("remembers a failed drawing instead of retrying it", async () => {
  const { renderer, draws, failNext, finish } = setup();
  failNext();
  renderer.diagram("flowchart ???", () => {});
  finish();
  await Bun.sleep(10);
  expect(renderer.diagram("flowchart ???", () => {})).toEqual({ error: "Parse error on line 1" });
  expect(draws.length).toBe(1);
});

test("says Chrome is missing rather than trying to draw", () => {
  dir = mkdtempSync(join(tmpdir(), "quoll-mermaid-"));
  const renderer = new MermaidRenderer(dir, undefined, async () => {
    throw new Error("should not draw");
  });
  expect(renderer.diagram("flowchart LR", () => {})).toEqual({ error: "Drawing mermaid diagrams needs Chrome or Chromium installed" });
});

test("keeps diagrams in quoll's state folder and honours QUOLL_CHROME", () => {
  dir = mkdtempSync(join(tmpdir(), "quoll-mermaid-"));
  expect(mermaidCacheDir({ XDG_STATE_HOME: "/state" })).toBe("/state/quoll/mermaid");
  expect(findChrome({ QUOLL_CHROME: "/opt/chrome" })).toBe("/opt/chrome");
});
