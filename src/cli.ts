#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { mkdirSync, realpathSync } from "node:fs";
import { findNotebook, isFile, pageFromPath } from "./notebook.ts";
import { terminalImageOutput } from "./render/image.ts";
import { findChrome, MermaidRenderer, mermaidCacheDir } from "./render/mermaid.ts";
import { listen, send } from "./socket.ts";
import { Viewer } from "./viewer/viewer.ts";
import { watchNotebook } from "./watch.ts";

const usage = `Usage:
  quoll [dir] [--no-follow]           View the notebook for dir (default: the current directory)
  quoll show <page>[#heading]         Show a page in every quoll viewing this notebook; inside qmux, only in this tab
  quoll path                          Print the notebook folder for the current directory
  quoll watch                         Print "changed: <page>" each time a page in the notebook is saved

Options:
  --dir <folder>   The notebook root for this run, overriding QUOLL_DIR

QUOLL_DIR is the notebook root, which holds a folder per story. Inside it, a
folder is used as is, so quoll $QUOLL_DIR browses every story. Anywhere else the
notebook is $QUOLL_DIR/<story>, where <story> is the directory under the
outermost "stories" directory above the current one.

Without QUOLL_DIR, the notebook is the nearest folder named notebook, or a
notebook/ folder in the nearest directory that has one.

Pages are markdown files; links and embeds may use Obsidian syntax.`;

type Options = { dir?: string; follow: boolean; positional: string[] };

function parseOptions(args: string[]): Options | undefined {
  const options: Options = { follow: true, positional: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--no-follow") options.follow = false;
    else if (arg === "--dir") {
      const dir = args[++index];
      if (!dir) return undefined;
      options.dir = dir;
    } else if (arg.startsWith("--")) return undefined;
    else options.positional.push(arg);
  }
  return options;
}

function notebookFor(options: Options, start: string): string {
  return findNotebook(start, options.dir ?? process.env.QUOLL_DIR);
}

async function main(args: string[]): Promise<number> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return 0;
  }
  const options = parseOptions(args);
  if (!options) {
    console.error(usage);
    return 2;
  }
  const command = ["show", "path", "watch"].includes(options.positional[0] ?? "") ? options.positional.shift() : undefined;
  if (command === "show") return show(options);
  if ((command === "path" || command === "watch") && options.positional.length > 0) {
    console.error(usage);
    return 2;
  }
  if (command === "path") {
    console.log(notebookFor(options, process.cwd()));
    return 0;
  }
  if (command === "watch") return watchPages(notebookFor(options, process.cwd()));
  if (options.positional.length > 1) {
    console.error(usage);
    return 2;
  }
  return view(notebookFor(options, options.positional[0] ?? process.cwd()), options.follow);
}

async function show(options: Options): Promise<number> {
  const target = options.positional[0];
  if (!target || options.positional.length > 1) {
    console.error(usage);
    return 2;
  }
  const root = notebookFor(options, process.cwd());
  const [path, anchor] = target.split(/#(.*)/s, 2);
  const asFile = path?.endsWith(".md") && isFile(path) ? pageFromPath(root, process.cwd(), realpathSync(path)) : undefined;
  const request = asFile ? `${asFile}${anchor ? `#${anchor}` : ""}` : target;
  const replies = (await send({ show: request, root })).filter((reply) => !("ignored" in reply));
  if (replies.length === 0) {
    console.error(`No quoll is open${process.env.QMUX_TAB_DIR ? " in this qmux tab" : ""} on ${root}`);
    return 1;
  }
  const failed = replies.find((reply) => "error" in reply);
  if (failed && "error" in failed) {
    console.error(failed.error);
    return 1;
  }
  return 0;
}

async function watchPages(root: string): Promise<number> {
  mkdirSync(root, { recursive: true });
  const stop = watchNotebook(realpathSync(root), 500, (filename) => {
    if (filename.endsWith(".md")) console.log(`changed: ${filename}`);
  });
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.once(signal, () => resolve());
  });
  stop();
  return 0;
}

async function view(root: string, follow: boolean): Promise<number> {
  mkdirSync(root, { recursive: true });
  root = realpathSync(root);
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true });
  const viewer = new Viewer(renderer, {
    root,
    follow,
    mermaid: new MermaidRenderer(mermaidCacheDir(), findChrome()),
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
  const stopWatching = watchNotebook(root, 100, (filename) => {
    viewer.fileChanged(filename);
    renderer.requestRender();
  });
  const stopListening = listen(root, (request) => {
    const reply = viewer.show(request.show, request.root);
    renderer.requestRender();
    return reply;
  });
  const signals = ["SIGHUP", "SIGTERM", "SIGINT"] as const;
  const onSignal = () => viewer.close();
  for (const signal of signals) process.on(signal, onSignal);
  try {
    viewer.start();
    await viewer.run();
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    stopWatching();
    stopListening();
    renderer.destroy();
    await renderer.closed;
  }
  return 0;
}

process.exit(await main(process.argv.slice(2)));
