import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemClipboard } from "./clipboard.ts";

const scratch = mkdtempSync(join(tmpdir(), "quoll-clipboard-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function fakeTool(name: string): void {
  writeFileSync(join(scratch, name), `#!/bin/sh\necho "$@" > "${join(scratch, "args")}"\ncat > "${join(scratch, "copied")}"\n`);
  chmodSync(join(scratch, name), 0o755);
}

describe("systemClipboard", () => {
  test("copies an image with xclip on X11, as its image type", async () => {
    fakeTool("xclip");
    writeFileSync(join(scratch, "shot.png"), "png bytes");
    const failed = await systemClipboard({ DISPLAY: ":0", PATH: `${scratch}:/usr/bin:/bin` })({ file: join(scratch, "shot.png") });
    expect(failed).toBeUndefined();
    expect(readFileSync(join(scratch, "args"), "utf8").trim()).toBe("-selection clipboard -t image/png -i");
    expect(readFileSync(join(scratch, "copied"), "utf8")).toBe("png bytes");
  });

  test("prefers wl-copy on Wayland, and copies text as text", async () => {
    fakeTool("wl-copy");
    const failed = await systemClipboard({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0", PATH: `${scratch}:/usr/bin:/bin` })({ text: "- ship it" });
    expect(failed).toBeUndefined();
    expect(readFileSync(join(scratch, "args"), "utf8").trim()).toBe("--type text/plain;charset=utf-8");
    expect(readFileSync(join(scratch, "copied"), "utf8")).toBe("- ship it");
  });

  test("says what is missing", async () => {
    expect(await systemClipboard({ PATH: scratch })({ text: "x" })).toBe("no clipboard tool: install wl-clipboard on Wayland or xclip on X11");
    expect(await systemClipboard({ DISPLAY: ":0", PATH: scratch })({ file: "diagram.svg" })).toBe("quoll can only copy png, jpeg, gif and webp images");
  });
});
