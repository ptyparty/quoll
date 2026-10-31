import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listen, send, tabViewerRoot } from "./socket.ts";

let dir: string;
const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  rmSync(dir, { recursive: true, force: true });
});

function viewer(name: string, env: Record<string, string>): string[] {
  const shown: string[] = [];
  stops.push(
    listen(
      "/notebook",
      (request) => {
        shown.push(`${name}: ${request.show}`);
        return { ok: true };
      },
      env,
    ),
  );
  return shown;
}

test("inside qmux, show reaches only the viewers in the same tab", async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "quoll-socket-")));
  const runtime = { XDG_RUNTIME_DIR: join(dir, "runtime") };
  const tabA = { ...runtime, QMUX_TAB_DIR: join(dir, "tab-a") };
  const tabB = { ...runtime, QMUX_TAB_DIR: join(dir, "tab-b") };
  const inA = viewer("a", tabA);
  const inB = viewer("b", tabB);
  const outside = viewer("outside", runtime);

  expect(await send({ show: "plan", root: "/notebook" }, tabA)).toEqual([{ ok: true }]);
  expect(await send({ show: "index", root: "/notebook" }, runtime)).toEqual([{ ok: true }]);
  expect(await send({ show: "decisions", root: "/notebook" }, { ...runtime, QMUX_TAB_DIR: join(dir, "tab-c") })).toEqual([]);
  expect([...inA, ...inB, ...outside]).toEqual(["a: plan", "outside: index"]);
});

test("tabViewerRoot names the notebook a running viewer in this tab shows", async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "quoll-socket-")));
  const runtime = { XDG_RUNTIME_DIR: join(dir, "runtime") };
  const tab = { ...runtime, QMUX_TAB_DIR: join(dir, "tab") };
  expect(tabViewerRoot(tab)).toBeUndefined();
  viewer("outside", runtime);
  expect(tabViewerRoot(runtime)).toBeUndefined();
  viewer("in tab", tab);
  expect(tabViewerRoot(tab)).toBe("/notebook");

  const stale = join(dir, "tab", "quoll", "999999999");
  writeFileSync(`${stale}.sock`, "");
  writeFileSync(`${stale}.root`, "/stale");
  utimesSync(`${stale}.root`, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  expect(tabViewerRoot(tab)).toBe("/notebook");
  expect(existsSync(`${stale}.sock`) || existsSync(`${stale}.root`)).toBe(false);
});
