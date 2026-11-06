import { describe, expect, test } from "bun:test";
import { placeholderLines, zoomedBox } from "./image.ts";

describe("zoomedBox", () => {
  test("fills the view at the first level, keeping the picture's shape", () => {
    expect(zoomedBox(1000, 500, { cols: 80, rows: 30 }, 1)).toEqual({ cols: 80, rows: 20 });
    expect(zoomedBox(500, 1000, { cols: 80, rows: 30 }, 1)).toEqual({ cols: 30, rows: 30 });
  });

  test("grows with the zoom level", () => {
    expect(zoomedBox(1000, 500, { cols: 80, rows: 30 }, 2)).toEqual({ cols: 160, rows: 40 });
  });

  test("stops at the largest box kitty placeholders can address", () => {
    expect(zoomedBox(1000, 500, { cols: 200, rows: 100 }, 4)).toEqual({ cols: 297, rows: 74 });
  });

  test("uses the terminal's cell size when it knows it", () => {
    expect(zoomedBox(1000, 500, { cols: 80, rows: 30 }, 1, { width: 8, height: 20 })).toEqual({ cols: 80, rows: 16 });
  });
});

describe("placeholderLines", () => {
  test("draws only the window it's given", () => {
    const lines = placeholderLines({ cols: 10, rows: 6 }, { top: 2, left: 3, rows: 3, cols: 4 });
    expect(lines).toHaveLength(3);
    expect([...lines[0]!].filter((char) => char === "\u{10EEEE}")).toHaveLength(4);
  });

  test("stops at the image's edge", () => {
    expect(placeholderLines({ cols: 10, rows: 6 }, { top: 4, left: 0, rows: 5, cols: 10 })).toHaveLength(2);
  });
});
