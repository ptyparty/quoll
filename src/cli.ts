#!/usr/bin/env bun
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { systemClipboard } from "./clipboard.ts";
import { listenForContext } from "./context.ts";
import { hasTag } from "./document.ts";
import { guideCommand } from "./guide.ts";
import { askRootWithKomux } from "./komux-ask.ts";
import { komuxZoom } from "./komux-control.ts";
import { findNotebook, type Focus, isFile, notebookPath, openNotebook, pageFromPath, pagesByTag } from "./notebook.ts";
import { terminalImageOutput } from "./render/image.ts";
import { findChrome, MermaidRenderer, mermaidCacheDir } from "./render/mermaid.ts";
import { notebookRoots, RootChoices, rootChoicesFile } from "./roots.ts";
import { listen, send, tabViewerRoot } from "./socket.ts";
import { pickRoot } from "./viewer/root-picker.ts";
import { editorCommand } from "./editor.ts";
import { notebookGit } from "./git.ts";
import { Viewer } from "./viewer/viewer.ts";
import { watchNotebook } from "./watch.ts";

const usage = `Usage:
  quoll [dir] [--no-follow]           View the notebook (default: $QUOLL_DIR, or the current directory)
  quoll show <page>[#heading]         Show a page in every quoll viewing this notebook; inside komux, only in this tab
  quoll path                          Print the notebook folder
  quoll watch                         Print "changed: <page>" each time a page in the notebook is saved
  quoll tags [tag]                    List the notebook's frontmatter tags and their pages, or the pages with one tag
  quoll guide [page]                  Print a page of the guide for agents keeping a notebook; index (the default) links to the rest
  quoll setup [--yes|--remove]        List quoll's Claude Code skill, link it into Claude's config, or remove it

Options:
  --focus          Open the notebook $QUOLL_DIR/<name>, where <name> is the
                   current directory's name (or dir's, when given)
  --focus=<name>   Open the notebook $QUOLL_DIR/<name>
  --dir <folder>   The notebook root for this run, overriding QUOLL_DIR
  --pick           Ask again which of QUOLL_DIR's roots to use here

QUOLL_DIR is the notebook root, which holds a folder per notebook. quoll opens
the whole root, so it browses every notebook, and --focus opens one of them,
creating it when it is missing. A dir given on the command line is used as is.

QUOLL_DIR may list several roots separated by colons. The viewer then asks which
one to use the first time it opens from a directory, in a komux form when run
inside komux, and remembers the answer for that directory; show, path, watch,
and tags use the remembered root.

Without QUOLL_DIR, the notebook root is the current directory, and --focus
needs a name.

Inside komux, show, path, watch, and tags use the notebook the quoll in this tab is
showing, unless --focus or --dir is given.

Pages are markdown files; links and embeds may use Obsidian syntax.

Inside komux, Alt shift c on the viewer picks a block, by letter, j/k and Enter,
or a click, and opens the message box for the tab's Claude with the block's file,
lines, and source attached.`;

type Options = { dir?: string; focus?: Focus; follow: boolean; pick: boolean; positional: string[] };

function parseOptions(args: string[]): Options | undefined {
  const options: Options = { follow: true, pick: false, positional: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--no-follow") options.follow = false;
    else if (arg === "--pick") options.pick = true;
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

const rootChoices = new RootChoices(rootChoicesFile());

function configuredRoots(options: Options): string[] {
  if (options.dir !== undefined) return [options.dir];
  const roots = notebookRoots(process.env.QUOLL_DIR);
  return roots.length > 0 ? roots : [process.cwd()];
}

function knownRoot(options: Options, start: string, pick = false): string | undefined {
  const roots = configuredRoots(options);
  if (roots.length === 1) return roots[0];
  return pick ? undefined : rootChoices.chosen(start, roots);
}

function notebookRoot(options: Options, start: string): string {
  const root = knownRoot(options, start);
  if (root !== undefined) return root;
  const command = options.focus === undefined ? "quoll" : options.focus === true ? "quoll --focus" : `quoll --focus=${options.focus}`;
  throw new Error(`QUOLL_DIR lists several notebook roots and none is picked for ${start}; run ${command} there to pick one:\n${configuredRoots(options).join("\n")}`);
}

function viewedNotebook(options: Options): string {
  if (options.dir === undefined && options.focus === undefined) {
    const viewed = tabViewerRoot();
    if (viewed) return viewed;
  }
  return findNotebook(process.cwd(), notebookRoot(options, process.cwd()), options.focus);
}

async function viewNotebook(options: Options): Promise<number> {
  const dir = options.positional[0];
  const roots = configuredRoots(options);
  if (dir !== undefined && options.focus === undefined) {
    const notebook = openNotebook(notebookPath(dir), roots);
    return withRenderer((renderer) => view(renderer, notebook, options.follow));
  }
  const start = dir ?? process.cwd();
  const known = knownRoot(options, start, options.pick);
  if (known !== undefined) {
    const notebook = openNotebook(findNotebook(start, known, options.focus), roots);
    return withRenderer((renderer) => view(renderer, notebook, options.follow));
  }
  const title = `Notebook root for ${basename(resolve(start))}`;
  const preselected = rootChoices.chosen(start, roots) ?? roots[0]!;
  const asked = process.env.KOMUX_SOCKET ? await untilSignal((cancel) => askRootWithKomux(title, roots, preselected, cancel)) : undefined;
  if (asked?.status === "cancelled") return 0;
  return withRenderer(async (renderer) => {
    const picked = asked?.status === "picked" ? asked.root : await untilSignal((cancel) => pickRoot(renderer, title, roots, cancel));
    if (picked === undefined) return 0;
    rootChoices.choose(start, picked);
    return view(renderer, openNotebook(findNotebook(start, picked, options.focus), roots), options.follow);
  });
}

async function untilSignal<T>(use: (cancel: AbortSignal) => Promise<T>): Promise<T> {
  const cancel = new AbortController();
  const signals = ["SIGHUP", "SIGTERM", "SIGINT"] as const;
  const onSignal = () => cancel.abort();
  for (const signal of signals) process.on(signal, onSignal);
  try {
    return await use(cancel.signal);
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
  }
}

async function withRenderer(use: (renderer: CliRenderer) => Promise<number>): Promise<number> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true });
  try {
    return await use(renderer);
  } finally {
    renderer.destroy();
    await renderer.closed;
  }
}

async function main(args: string[]): Promise<number> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return 0;
  }
  if (args[0] === "guide") return guideCommand("quoll", args.slice(1));
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
  if (options.focus === true && options.dir === undefined && notebookRoots(process.env.QUOLL_DIR).length === 0) {
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
  if (command === "watch") return watchPages(openNotebook(viewedNotebook(options), configuredRoots(options)));
  if (options.positional.length > 1) {
    console.error(usage);
    return 2;
  }
  return viewNotebook(options);
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

async function view(renderer: CliRenderer, root: string, follow: boolean): Promise<number> {
  const viewer = new Viewer(renderer, {
    root,
    follow,
    git: notebookGit(root),
    mermaid: new MermaidRenderer(mermaidCacheDir(), findChrome()),
    clipboard: systemClipboard(),
    zoomPane: komuxZoom(),
    images: () => terminalImageOutput(renderer.capabilities?.kitty_graphics ?? false),
    edit: async (file, line) => {
      await renderer.suspend();
      try {
        await Bun.spawn(editorCommand(file, line), { stdio: ["inherit", "inherit", "inherit"] }).exited;
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
  const stopContext = listenForContext({ context: (request) => viewer.askForContext(request), keys: () => viewer.keys() });
  const signals = ["SIGHUP", "SIGTERM", "SIGINT"] as const;
  const onSignal = () => viewer.close();
  for (const signal of signals) process.on(signal, onSignal);
  try {
    viewer.start();
    await viewer.run();
    await Promise.race([viewer.settled(), Bun.sleep(1500)]);
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    stopWatching();
    stopListening();
    stopContext();
  }
  return 0;
}

process.exit(await main(process.argv.slice(2)));
