import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { frontmatterTags, isExternal } from "./document.ts";

export const indexPage = "index.md";

export type Page = { path: string; modified: number };

export type Target = { page: string; anchor?: string };

export type Focus = string | true;

export function findNotebook(start: string, notebookRoot: string, focus?: Focus): string {
  const root = notebookPath(notebookRoot);
  if (focus === undefined) return root;
  const name = focus === true ? basename(resolve(start)) : focus;
  if (!isNotebookName(name)) throw new Error(`Not a notebook name: "${name}"`);
  return join(root, name);
}

export function notebookPath(path: string): string {
  return realOrResolved(expandHome(path));
}

function isNotebookName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes(sep);
}

export function openNotebook(notebook: string, notebookRoots: string[]): string {
  if (notebookRoots.some((root) => contains(notebookPath(root), realOrResolved(notebook)))) mkdirSync(notebook, { recursive: true });
  else if (!isDirectory(notebook)) throw new Error(`No notebook folder at ${notebook}`);
  return realpathSync(notebook);
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function realOrResolved(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    const parent = dirname(resolved);
    return parent === resolved ? resolved : join(realOrResolved(parent), basename(resolved));
  }
}

export function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function overlaps(a: string, b: string): boolean {
  return contains(a, b) || contains(b, a);
}

export function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(relative(root, full));
    }
  };
  walk(root);
  return files;
}

export function listPages(root: string): Page[] {
  const pages: Page[] = [];
  for (const path of listFiles(root)) {
    if (!path.endsWith(".md")) continue;
    try {
      pages.push({ path, modified: statSync(join(root, path)).mtimeMs });
    } catch {}
  }
  return pages.sort((a, b) => b.modified - a.modified);
}

export function pagesByTag(root: string, read: (page: string) => string | undefined = (page) => readPage(root, page)): Map<string, string[]> {
  const tagged = new Map<string, string[]>();
  for (const path of listFiles(root).filter((file) => file.endsWith(".md")).sort()) {
    for (const tag of frontmatterTags(read(path) ?? "")) tagged.set(tag, [...(tagged.get(tag) ?? []), path]);
  }
  return new Map([...tagged].sort(([a], [b]) => a.localeCompare(b)));
}

export function readPage(root: string, page: string): string | undefined {
  try {
    return readFileSync(join(root, page), "utf8");
  } catch {
    return undefined;
  }
}

export function splitTarget(target: string): { path: string; anchor?: string } {
  const hash = target.indexOf("#");
  if (hash === -1) return { path: target };
  const anchor = target.slice(hash + 1);
  return { path: target.slice(0, hash), ...(anchor ? { anchor } : {}) };
}

export function resolveTarget(root: string, from: string | undefined, target: string, files: () => string[] = () => listFiles(root)): Target | undefined {
  if (isExternal(target)) return undefined;
  const { path, anchor } = splitTarget(target);
  const withAnchor = (page: string): Target => (anchor ? { page, anchor } : { page });
  if (path === "") return from ? withAnchor(from) : undefined;
  const name = path.endsWith(".md") ? path : `${path}.md`;
  for (const base of [from ? dirname(from) : ".", "."]) {
    const page = inside(root, join(base, name));
    if (page && isFile(join(root, page))) return withAnchor(page);
  }
  const wanted = basename(name).toLowerCase();
  const match = files()
    .filter((page) => basename(page).toLowerCase() === wanted)
    .sort((a, b) => a.split(sep).length - b.split(sep).length)[0];
  return match ? withAnchor(match) : undefined;
}

export function resolveAsset(root: string, from: string, target: string, files: () => string[] = () => listFiles(root)): string | undefined {
  for (const candidate of [join(dirname(from), target), target]) {
    const path = inside(root, candidate);
    if (path && isFile(join(root, path))) return join(root, path);
  }
  const wanted = basename(target).toLowerCase();
  const found = files().find((file) => basename(file).toLowerCase() === wanted);
  return found ? join(root, found) : undefined;
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function pageFromPath(root: string, cwd: string, path: string): string | undefined {
  const file = resolve(cwd, path);
  return contains(root, file) ? relative(root, file) : undefined;
}

function inside(root: string, path: string): string | undefined {
  const page = normalize(path);
  if (page.startsWith("..") || resolve(root, page) !== join(root, page)) return undefined;
  return page;
}
