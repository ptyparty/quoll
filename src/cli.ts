#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { realpathSync } from "node:fs";
import { deliverComment } from "./comment.ts";
import { hasTag } from "./document.ts";
import { findNotebook, type Focus, isFile, notebookPath, openNotebook, pageFromPath, pagesByTag } from "./notebook.ts";
import { terminalImageOutput } from "./render/image.ts";
import { findChrome, MermaidRenderer, mermaidCacheDir } from "./render/mermaid.ts";
import { listen, send, tabViewerRoot } from "./socket.ts";
import { Viewer } from "./viewer/viewer.ts";
import { watchNotebook } from "./watch.ts";

const usage = `Usage:
  quoll [dir] [--no-follow]           View the notebook (default: $QUOLL_DIR, or the current directory)
  quoll show <page>[#heading]         Show a page in every quoll viewing this notebook; inside komux, only in this tab
  quoll path                          Print the notebook folder
  quoll watch                         Print "changed: <page>" each time a page in the notebook is saved
  quoll tags [tag]                    List the notebook's frontmatter tags and their pages, or the pages with one tag
  quoll setup [--yes|--remove]        List quoll's Claude Code skill, link it into Claude's config, or remove it

Options:
  --focus          Open the notebook $QUOLL_DIR/<name>, where <name> is the
                   current directory's name (or dir's, when given)
  --focus=<name>   Open the notebook $QUOLL_DIR/<name>
  --dir <folder>   The notebook root for this run, overriding QUOLL_DIR

QUOLL_DIR is the notebook root, which holds a folder per notebook. quoll opens
the whole root, so it browses every notebook, and --focus opens one of them,
creating it when it is missing. A dir given on the command line is used as is.

Without QUOLL_DIR, the notebook root is the current directory, and --focus
needs a name.

Inside komux, show, path, watch, and tags use the notebook the quoll in this tab is
showing, unless --focus or --dir is given.

Pages are markdown files; links and embeds may use Obsidian syntax.

In the viewer, c comments on a block, picked by letter, j/k and Enter, or a click:
quoll runs QUOLL_COMMENT_COMMAND with a label for the block as its last argument
(joined with = when the command ends in an option such as --label) and the
block's file, lines, and source on stdin. Inside komux, set it to
"komux claude compose --from-stdin --label".
Without it, quoll copies that context to the clipboard.`;

type Options = { dir?: string; focus?: Focus; follow: boolean; positional: string[] };

function parseOptions(args: string[]): Options | undefined {
  const options: Options = { follow: true, positional: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--no-follow") options.follow = false;
    else if (arg.startsWith("--focus=")) options.focus = arg.slice("--focus=".length);
    else if (arg === "--focus") options.focus = true;
    else if (arg === "--dir") {
      const dir = args[++index];
      if (!dir) return undefined;
      options.dir = dir;
    } else if (arg.startsWith("--")) return undefined;
    else options.positional.push(arg);
  }
  return options;
}

function notebookRoot(options: Options): string {
  return options.dir ?? process.env.QUOLL_DIR ?? process.cwd();
}

function viewedNotebook(options: Options): string {
  if (options.dir === undefined && options.focus === undefined) {
    const viewed = tabViewerRoot();
    if (viewed) return viewed;
  }
  return findNotebook(process.cwd(), notebookRoot(options), options.focus);
}

function notebookToView(options: Options): string {
  const dir = options.positional[0];
  if (dir !== undefined && options.focus === undefined) return notebookPath(dir);
  return findNotebook(dir ?? process.cwd(), notebookRoot(options), options.focus);
}

async function main(args: string[]): Promise<number> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return 0;
  }
  if (args[0] === "setup") {
    try {
      return (await import("./setup.ts")).setupCommand(args.slice(1));
    } catch (error) {
      console.error(`quoll: ${(error as Error).message}`);
      return 1;
    }
  }
  const options = parseOptions(args);
  if (!options) {
    console.error(usage);
    return 2;
  }
  try {
    return await run(options);
  } catch (error) {
    console.error(`quoll: ${(error as Error).message}`);
    return 1;
  }
}

async function run(options: Options): Promise<number> {
  if (options.focus === true && options.dir === undefined && !process.env.QUOLL_DIR) {
    throw new Error("--focus without a name needs QUOLL_DIR or --dir; use --focus=<name> to open ./<name>");
  }
  const command = ["show", "path", "watch", "tags"].includes(options.positional[0] ?? "") ? options.positional.shift() : undefined;
  if (command === "show") return show(options);
  if (command === "tags") return tags(options);
  if ((command === "path" || command === "watch") && options.positional.length > 0) {
    console.error(usage);
    return 2;
  }
  if (command === "path") {
    console.log(viewedNotebook(options));
    return 0;
  }
  if (command === "watch") return watchPages(openNotebook(viewedNotebook(options), notebookRoot(options)));
  if (options.positional.length > 1) {
    console.error(usage);
    return 2;
  }
  return view(openNotebook(notebookToView(options), notebookRoot(options)), options.follow);
}

async function show(options: Options): Promise<number> {
  const target = options.positional[0];
  if (!target || options.positional.length > 1) {
    console.error(usage);
    return 2;
  }
  const root = viewedNotebook(options);
  const [path, anchor] = target.split(/#(.*)/s, 2);
  const asFile = path?.endsWith(".md") && isFile(path) ? pageFromPath(root, process.cwd(), realpathSync(path)) : undefined;
  const request = asFile ? `${asFile}${anchor ? `#${anchor}` : ""}` : target;
  const replies = (await send({ show: request, root })).filter((reply) => !("ignored" in reply));
  if (replies.length === 0) {
    console.error(`No quoll is open${process.env.KOMUX_TAB_DIR ? " in this komux tab" : ""} on ${root}`);
    return 1;
  }
  const failed = replies.find((reply) => "error" in reply);
  if (failed && "error" in failed) {
    console.error(failed.error);
    return 1;
  }
  return 0;
}

function tags(options: Options): number {
  if (options.positional.length > 1) {
    console.error(usage);
    return 2;
  }
  const tagged = pagesByTag(viewedNotebook(options));
  const wanted = options.positional[0];
  if (wanted !== undefined) {
    const pages = [...new Set([...tagged].flatMap(([tag, pages]) => (hasTag([tag], wanted) ? pages : [])))].sort();
    if (pages.length === 0) {
      console.error(`No pages are tagged ${wanted.startsWith("#") ? wanted : `#${wanted}`}`);
      return 1;
    }
    for (const page of pages) console.log(page);
    return 0;
  }
  for (const [tag, pages] of tagged) console.log([`#${tag}`, ...pages].join("\t"));
  return 0;
}

async function watchPages(root: string): Promise<number> {
  const stop = watchNotebook(root, 500, (filename) => {
    if (filename.endsWith(".md")) console.log(`changed: ${filename}`);
  });
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.once(signal, () => resolve());
  });
  stop();
  return 0;
}

async function view(root: string, follow: boolean): Promise<number> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true });
  const viewer = new Viewer(renderer, {
    root,
    follow,
    mermaid: new MermaidRenderer(mermaidCacheDir(), findChrome()),
    images: () => terminalImageOutput(renderer.capabilities?.kitty_graphics ?? false),
    comment: (comment) => deliverComment(comment, { copy: (text) => renderer.copyToClipboardOSC52(text), env: process.env }),
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
