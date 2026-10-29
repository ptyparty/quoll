#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { existsSync, mkdirSync, statSync, watch } from "node:fs";
import { findNotebook, pageFromPath } from "./notebook.ts";
import { terminalImageOutput } from "./render/image.ts";
import { listen, send } from "./socket.ts";
import { Viewer } from "./viewer/viewer.ts";

const usage = `Usage:
  quoll [dir] [--no-follow]    View the notebook in dir (or the nearest notebook/ above it)
  quoll show <page>[#heading]  Show a page in every quoll viewing this notebook

The notebook is the nearest folder named notebook, or a notebook/ folder in the
nearest directory that has one. Pages are markdown files; links and embeds may
use Obsidian syntax.`;

async function main(args: string[]): Promise<number> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return 0;
  }
  if (args[0] === "show") return show(args.slice(1));
  const follow = !args.includes("--no-follow");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 1) {
    console.error(usage);
    return 2;
  }
  return view(findNotebook(positional[0] ?? process.cwd()), follow);
}

async function show(args: string[]): Promise<number> {
  const target = args[0];
  if (!target || args.length > 1) {
    console.error(usage);
    return 2;
  }
  const root = findNotebook(process.cwd());
  const [path, anchor] = target.split(/#(.*)/s, 2);
  const asFile = path?.endsWith(".md") && existsSync(path) && statSync(path).isFile() ? pageFromPath(root, process.cwd(), path) : undefined;
  const request = asFile ? `${asFile}${anchor ? `#${anchor}` : ""}` : target;
  const replies = await send(root, { show: request });
  if (replies.length === 0) {
    console.error(`No quoll is open on ${root}`);
    return 1;
  }
  const failed = replies.find((reply) => "error" in reply);
  if (failed && "error" in failed) {
    console.error(failed.error);
    return 1;
  }
  return 0;
}

async function view(root: string, follow: boolean): Promise<number> {
  mkdirSync(root, { recursive: true });
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true });
  const viewer = new Viewer(renderer, {
    root,
    follow,
    images: () => terminalImageOutput(renderer.capabilities?.kitty_graphics ?? false),
    edit: async (file, line) => {
      await renderer.suspend();
      try {
        await Bun.spawn(["hx", `${file}:${line}`], { stdio: ["inherit", "inherit", "inherit"] }).exited;
      } finally {
        await renderer.resume();
      }
    },
  });
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename || filename.split("/").some((part) => part.startsWith("."))) return;
    clearTimeout(timers.get(filename));
    timers.set(
      filename,
      setTimeout(() => {
        timers.delete(filename);
        viewer.fileChanged(filename);
        renderer.requestRender();
      }, 100),
    );
  });
  const stopListening = listen(root, (request) => {
    const error = viewer.show(request.show);
    renderer.requestRender();
    return error ? { error } : { ok: true };
  });
  const signals = ["SIGHUP", "SIGTERM", "SIGINT"] as const;
  const onSignal = () => viewer.close();
  for (const signal of signals) process.on(signal, onSignal);
  try {
    viewer.start();
    await viewer.run();
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    watcher.close();
    stopListening();
    renderer.destroy();
    await renderer.closed;
  }
  return 0;
}

process.exit(await main(process.argv.slice(2)));
