import { watch } from "node:fs";

export function watchNotebook(root: string, delayMs: number, onChange: (filename: string) => void): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename || filename.split("/").some((part) => part.startsWith("."))) return;
    clearTimeout(timers.get(filename));
    timers.set(
      filename,
      setTimeout(() => {
        timers.delete(filename);
        onChange(filename);
      }, delayMs),
    );
  });
  return () => {
    watcher.close();
    for (const timer of timers.values()) clearTimeout(timer);
  };
}
