import { createTestRenderer } from "@opentui/core/testing";
import { Viewer } from "../src/viewer/viewer.ts";

const [root, ...keys] = process.argv.slice(2);
if (!root) {
  console.error("usage: bun scripts/atlas-drive.ts <notebook> [key ...]   keys: a letter or /, H, enter, esc, bs, tab, up, down");
  process.exit(2);
}

const width = Number(process.env.COLS ?? 80);
const height = Number(process.env.ROWS ?? 40);
const setup = await createTestRenderer({ width, height });
const viewer = new Viewer(setup.renderer, { root, follow: false, images: () => ({ enabled: false, write: () => {} }), edit: async () => {} });
viewer.start();

function capture(): string {
  for (let attempt = 0; ; attempt++) {
    try {
      return setup.captureCharFrame();
    } catch (error) {
      if (attempt >= 20 || !String(error).includes("OutputBusy")) throw error;
      Bun.sleepSync(5);
    }
  }
}

async function settle(): Promise<string> {
  let previous = "";
  let steady = 0;
  for (let frame = 0; frame < 120 && steady < 4; frame++) {
    await setup.renderOnce();
    await Bun.sleep(2);
    const current = capture();
    steady = current === previous ? steady + 1 : 0;
    previous = current;
  }
  return previous;
}

await settle();
for (const key of keys) {
  if (key === "enter") setup.mockInput.pressEnter();
  else if (key === "esc") setup.mockInput.pressEscape();
  else if (key === "bs") setup.mockInput.pressBackspace();
  else if (key === "tab") setup.mockInput.pressTab();
  else if (key === "up") setup.mockInput.pressArrow("up");
  else if (key === "down") setup.mockInput.pressArrow("down");
  else if (key.length === 1 && key >= "A" && key <= "Z") setup.mockInput.pressKey(key, { shift: true });
  else if (key.length === 1) setup.mockInput.pressKey(key);
  else throw new Error(`Unknown key ${key}`);
  await settle();
}
console.log((await settle()).split("\n").map((line) => line.trimEnd()).join("\n"));
const selected = (viewer as unknown as { mindMap?: { choice: { node: { label: string; kind: string } } } }).mindMap?.choice.node;
console.log(selected ? `[highlighted in the atlas: ${selected.label} (${selected.kind})]` : "[atlas closed]");
await setup.renderer.destroy();
process.exit(0);
