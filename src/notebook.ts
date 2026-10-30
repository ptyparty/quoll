import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { isExternal } from "./document.ts";

export const notebookFolder = "notebook";
export const indexPage = "index.md";

export type Page = { path: string; modified: number };

export type Target = { page: string; anchor?: string };

export function findNotebook(start: string, notebookRoot?: string): string {
  const from = realOrResolved(start);
  if (notebookRoot) {
    const root = realOrResolved(expandHome(notebookRoot));
    if (contains(root, from)) return from;
    const story = storyDir(from);
    if (story) return join(root, basename(story));
  }
  let dir = from;
  while (true) {
    if (basename(dir) === notebookFolder) return dir;
    const candidate = join(dir, notebookFolder);
    if (isDirectory(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return join(resolve(start), notebookFolder);
    dir = parent;
  }
}

function storyDir(from: string): string | undefined {
  const ancestors: string[] = [];
  for (let dir = from; dirname(dir) !== dir; dir = dirname(dir)) ancestors.push(dir);
  return ancestors.findLast((dir) => basename(dirname(dir)) === "stories");
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
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

function isDirectory(path: string): boolean {
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
