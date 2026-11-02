import type { CliRenderer, KeyEvent } from "@opentui/core";
import { homedir } from "node:os";
import { PickerState, PickerView, pickerKey } from "./picker.ts";

export function pickRoot(renderer: CliRenderer, title: string, roots: string[], cancel: AbortSignal): Promise<string | undefined> {
  const home = homedir();
  const state = new PickerState(
    title,
    roots.map((root) => ({ label: root === home || root.startsWith(`${home}/`) ? `~${root.slice(home.length)}` : root, value: root })),
  );
  const view = new PickerView(renderer);
  view.render(state);
  renderer.requestRender();
  return new Promise((resolve) => {
    const finish = (value: string | undefined) => {
      renderer.keyInput.off("keypress", onKey);
      cancel.removeEventListener("abort", onCancel);
      view.destroy();
      renderer.requestRender();
      resolve(value);
    };
    const onKey = (key: KeyEvent) => {
      const outcome = pickerKey(state, key);
      if (outcome.done) return finish(outcome.value);
      view.render(state);
      renderer.requestRender();
    };
    const onCancel = () => finish(undefined);
    renderer.keyInput.on("keypress", onKey);
    cancel.addEventListener("abort", onCancel);
  });
}
