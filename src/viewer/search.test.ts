import { describe, expect, test } from "bun:test";
import { RGBA, type TextChunk } from "@opentui/core";
import { theme } from "../render/theme.ts";
import { findMatches, markMatches } from "./search.ts";

const chunk = (text: string): TextChunk => ({ __isChunk: true, text });

describe("page search", () => {
  test("ignores case unless the query has a capital", () => {
    expect(findMatches("Coupon coupon", "coupon")).toEqual([
      { start: 0, end: 6 },
      { start: 7, end: 13 },
    ]);
    expect(findMatches("Coupon coupon", "Coupon")).toEqual([{ start: 0, end: 6 }]);
    expect(findMatches("İstanbul coupon (a.b)", "coupon")).toEqual([{ start: 9, end: 15 }]);
    expect(findMatches("İstanbul coupon (a.b)", "(a.b)")).toEqual([{ start: 16, end: 21 }]);
  });

  test("lights a match that spans styled chunks, the current one brighter", () => {
    const marked = markMatches([chunk("a cou"), chunk("pon and coupon")], "coupon", 1);
    expect(marked.map((part) => part.text)).toEqual(["a ", "cou", "pon", " and ", "coupon"]);
    expect(marked[1]!.bg).toEqual(RGBA.fromHex(theme.selection));
    expect(marked[2]!.bg).toEqual(RGBA.fromHex(theme.selection));
    expect(marked[4]!.bg).toEqual(RGBA.fromHex(theme.match));
    expect(marked[0]!.bg).toBeUndefined();
  });
});
