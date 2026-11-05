import { describe, expect, test } from "bun:test";
import { editorCommand } from "./editor.ts";

describe("editorCommand", () => {
  test("opens VISUAL, then EDITOR, then helix, at the line in each one's own way", () => {
    expect(editorCommand("/n/plan.md", 7, {})).toEqual(["hx", "/n/plan.md:7"]);
    expect(editorCommand("/n/plan.md", 7, { EDITOR: "nvim" })).toEqual(["nvim", "+7", "/n/plan.md"]);
    expect(editorCommand("/n/plan.md", 7, { EDITOR: "nano", VISUAL: "/usr/bin/hx" })).toEqual(["/usr/bin/hx", "/n/plan.md:7"]);
    expect(editorCommand("/n/plan.md", 7, { EDITOR: "code --wait" })).toEqual(["code", "--wait", "--goto", "/n/plan.md:7"]);
    expect(editorCommand("/n/plan.md", 7, { EDITOR: "zed" })).toEqual(["zed", "/n/plan.md:7"]);
  });
});
