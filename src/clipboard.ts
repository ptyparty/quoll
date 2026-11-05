import { extname } from "node:path";

export type Clip = { file: string } | { text: string };
export type CopyToClipboard = (clip: Clip) => Promise<string | undefined>;

const imageTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function isCopyableImage(file: string): boolean {
  return extname(file).toLowerCase() in imageTypes;
}

export function systemClipboard(env: Record<string, string | undefined> = process.env): CopyToClipboard {
  return async (clip) => {
    const type = "file" in clip ? imageTypes[extname(clip.file).toLowerCase()] : "text/plain;charset=utf-8";
    if (!type) return "quoll can only copy png, jpeg, gif and webp images";
    const command = clipboardCommand(type, env);
    if (!command) return "no clipboard tool: install wl-clipboard on Wayland or xclip on X11";
    const proc = Bun.spawn(command, {
      env,
      stdin: "file" in clip ? Bun.file(clip.file) : new Blob([clip.text]),
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0 ? undefined : `${command[0]} could not copy it (exit ${proc.exitCode})`;
  };
}

function clipboardCommand(type: string, env: Record<string, string | undefined>): string[] | undefined {
  const path = { PATH: env.PATH ?? "" };
  const wlCopy = env.WAYLAND_DISPLAY ? Bun.which("wl-copy", path) : null;
  if (wlCopy) return [wlCopy, "--type", type];
  const xclip = env.DISPLAY ? Bun.which("xclip", path) : null;
  if (xclip) return [xclip, "-selection", "clipboard", "-t", type, "-i"];
  return undefined;
}
