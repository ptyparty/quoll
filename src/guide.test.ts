import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guidePage, guidePages } from "./guide.ts";

function anchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replace(/ /g, "-");
}

function prose(page: string): string {
  return page.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
}

function anchors(page: string): string[] {
  return [...page.matchAll(/^#+ (.*)$/gm)].map((match) => anchor(match[1]!));
}

describe("the guide", () => {
  test("starts at an index", () => {
    expect(guidePages()).toContain("index");
  });

  test("every link names a page and heading that exist", () => {
    for (const name of guidePages()) {
      const page = guidePage(name)!;
      for (const [, target] of prose(page).matchAll(/\]\(([^)\s]+)\)/g)) {
        const [file, heading] = target!.split("#", 2);
        const linked = file ? guidePage(file) : page;
        expect(linked, `${name}.md links to ${target}`).toBeDefined();
        if (heading) expect(anchors(linked!), `${name}.md links to ${target}`).toContain(heading);
      }
    }
  });

  test("a page is found by name, file name, or link", () => {
    const dir = mkdtempSync(join(tmpdir(), "quoll-guide-"));
    writeFileSync(join(dir, "tags.md"), "# Tags\n");
    expect(guidePage("tags", dir)).toBe("# Tags\n");
    expect(guidePage("tags.md#tags", dir)).toBe("# Tags\n");
    expect(guidePage("../tags.md", dir)).toBe("# Tags\n");
    expect(guidePage("nope", dir)).toBeUndefined();
  });
});
