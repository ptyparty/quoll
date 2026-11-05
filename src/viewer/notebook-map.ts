import type { KeyEvent } from "@opentui/core";
import { headingKey, type Document } from "../document.ts";
import type { Target } from "../notebook.ts";
import { bindingFor, typedText, type Binding } from "./keys.ts";
import { buildMindMap, layoutMindMap, pageTitle, previewRows, wrap, type MapNode, type MindMap } from "./mindmap.ts";

export type NotebookPage = { page: string; document: Document; tags: string[] };

export type NotebookTree = { root: MapNode; pages: Map<string, MapNode>; parents: Map<MapNode, MapNode>; documents: Map<string, Document> };

export type Column = { title: string; items: MapNode[]; focus: MapNode | undefined };

export type MapView = "columns" | "map";

const focusLabel = 32;
const ancestorLabel = 24;
const shrink = 0.55;
const minLabel = 6;
const previewWidth = 34;
const leadCost = 1;
const mentionCost = 3;

export function buildNotebookTree(pages: NotebookPage[], resolve: (from: string, target: string) => Target | undefined, start?: string): NotebookTree {
  const byPage = new Map(pages.map((info) => [info.page, info]));
  const names = [...byPage.keys()].sort();
  const edges = new Map<string, Map<string, number>>();
  for (const name of names) {
    const costs = new Map<string, number>();
    for (const link of byPage.get(name)!.document.links) {
      const target = resolve(name, link.target)?.page;
      if (!target || target === name || !byPage.has(target)) continue;
      costs.set(target, Math.min(costs.get(target) ?? Infinity, link.lead ? leadCost : mentionCost));
    }
    edges.set(name, costs);
  }
  const outgoing = new Map(names.map((name) => [name, [...edges.get(name)!.keys()]]));
  const incoming = new Map<string, string[]>(names.map((name) => [name, []]));
  for (const name of names) for (const target of outgoing.get(name)!) incoming.get(target)!.push(name);

  const parent = new Map<string, string | undefined>();
  const explore = (from: string) => {
    const distance = new Map<string, number>([[from, 0]]);
    const done = new Set<string>();
    const order = new Map<string, number>([[from, 0]]);
    for (;;) {
      let next: string | undefined;
      for (const [name, cost] of distance) {
        if (done.has(name)) continue;
        if (next === undefined || cost < distance.get(next)! || (cost === distance.get(next)! && order.get(name)! < order.get(next)!)) next = name;
      }
      if (next === undefined) return;
      done.add(next);
      for (const [target, cost] of edges.get(next)!) {
        if (parent.has(target) && !distance.has(target)) continue;
        const through = distance.get(next)! + cost;
        if (through < (distance.get(target) ?? Infinity)) {
          distance.set(target, through);
          parent.set(target, next);
          order.set(target, order.size);
        }
      }
    }
  };
  const rootPage = start && byPage.has(start) ? start : undefined;
  if (rootPage) {
    parent.set(rootPage, undefined);
    explore(rootPage);
  }
  const unlinked: string[] = [];
  for (const name of names) {
    if (parent.has(name)) continue;
    parent.set(name, undefined);
    unlinked.push(name);
    explore(name);
  }

  const titleOf = (name: string) => pageTitle(name, byPage.get(name)!.document);
  const stem = (name: string) => name.replace(/\.md$/, "");
  const pageNodes = new Map<string, MapNode>();
  const tagged = new Map<string, string[]>();
  for (const name of names) for (const tag of byPage.get(name)!.tags) tagged.set(tag, [...(tagged.get(tag) ?? []), name]);
  const parents = new Map<MapNode, MapNode>();
  const adopt = (node: MapNode) => {
    for (const child of node.children) {
      parents.set(child, node);
      adopt(child);
    }
  };

  const pageNode = (name: string): MapNode => {
    const info = byPage.get(name)!;
    const node = buildMindMap(name, info.document, (target) => resolve(name, target));
    node.kind = "page";
    const placed = new Set<string>();
    const leads = new Set(info.document.links.filter((link) => link.lead).map((link) => resolve(name, link.target)?.page));
    const own = (tree: MapNode) => {
      tree.owner = name;
      tree.children = tree.children.map((child) => {
        if (child.kind === "link" && child.where) {
          const target = child.where.page;
          if (parent.get(target) === name && !placed.has(target) && child.where.anchor === undefined && (child.lead || !leads.has(target))) {
            placed.add(target);
            const page = pageNode(target);
            if (child.source) page.source = child.source;
            return page;
          }
          return { ...child, kind: "portal", owner: name };
        }
        own(child);
        return child;
      });
      tree.children = tree.children.map((child) => (child.kind === "heading" && child.children.length === 1 && child.children[0]!.kind === "page" ? child.children[0]! : child));
    };
    own(node);
    for (const target of outgoing.get(name)!) {
      if (parent.get(target) === name && !placed.has(target)) {
        placed.add(target);
        const page = pageNode(target);
        const links = info.document.links.filter((candidate) => resolve(name, candidate.target)?.page === target);
        const link = links.find((candidate) => candidate.lead) ?? links[0];
        if (link) page.source = { page: name, line: link.line, column: link.column, length: link.length };
        node.children.push(page);
      }
    }
    const from = incoming.get(name)!.filter((other) => other !== parent.get(name));
    if (from.length > 0) {
      const portals = from.map((other): MapNode => {
        const document = byPage.get(other)!.document;
        const link = document.links.find((candidate) => resolve(other, candidate.target)?.page === name);
        const heading = link ? document.headings.findLast((candidate) => candidate.line <= link.line && candidate.level > 1) : undefined;
        return { label: heading ? `${titleOf(other)} › ${heading.text}` : titleOf(other), kind: "portal", where: link ? { page: other, line: link.line, column: link.column, length: link.length } : { page: other }, children: [], owner: name, back: true, detail: stem(other) };
      });
      node.children.push({ label: `linked from (${from.length})`, kind: "group", where: undefined, children: portals, owner: name });
    }
    for (const tag of info.tags) {
      const others = (tagged.get(tag) ?? []).filter((other) => other !== name);
      if (others.length === 0) continue;
      const portals = others.map((other): MapNode => ({ label: titleOf(other), kind: "portal", where: { page: other }, children: [], owner: name, detail: stem(other) }));
      node.children.push({ label: `#${tag} (${others.length})`, kind: "tag", where: undefined, children: portals, owner: name });
    }
    node.children.unshift({ label: "top of page", kind: "top", where: { page: name, line: 0 }, children: [], owner: name });
    pageNodes.set(name, node);
    return node;
  };

  const root: MapNode = rootPage ? pageNode(rootPage) : { label: "Notebook", kind: "root", where: undefined, children: [] };
  root.kind = "root";
  if (unlinked.length > 0) {
    const group: MapNode = { label: rootPage ? `unlinked pages (${unlinked.length})` : "pages", kind: "group", where: undefined, children: unlinked.map(pageNode) };
    if (rootPage) root.children.push(group);
    else root.children.push(...group.children);
  }
  adopt(root);
  const tree = { root, pages: pageNodes, parents, documents: new Map(pages.map((info) => [info.page, info.document])) };
  const rename = (node: MapNode) => {
    if (node.kind === "portal" && !node.back && node.where) {
      const target = portalTarget(tree, node);
      const page = node.where.page;
      if (target && byPage.has(page)) {
        node.label = target.kind === "heading" ? `${titleOf(page)} › ${target.label}` : titleOf(page);
        node.detail = `${stem(page)}${node.where.anchor ? `#${node.where.anchor}` : ""}`;
      }
    }
    node.children.forEach(rename);
  };
  rename(root);
  return tree;
}

function portalTarget(tree: Pick<NotebookTree, "pages">, node: MapNode): MapNode | undefined {
  if (!node.where) return undefined;
  const page = tree.pages.get(node.where.page);
  if (!page || !node.where.anchor) return page;
  const key = headingKey(node.where.anchor);
  const find = (from: MapNode): MapNode | undefined => {
    for (const child of from.children) {
      if (child.kind !== "heading") continue;
      if (headingKey(child.label) === key) return child;
      const found = find(child);
      if (found) return found;
    }
    return undefined;
  };
  return find(page) ?? page;
}

export function previewLines(tree: NotebookTree, node: MapNode): string[] {
  const where = node.where;
  const document = where ? tree.documents.get(where.page) : undefined;
  if (!where || !document || (node.kind !== "heading" && node.kind !== "page" && node.kind !== "top" && node.kind !== "root")) return [];
  const from = where.line ?? 0;
  const end = document.headings.find((heading) => heading.line > from && (node.kind === "heading" || heading.level > 1))?.line ?? Infinity;
  return document.blocks
    .filter((block) => block.startLine > from && block.startLine < end && block.kind === "markdown")
    .flatMap((block) => (block.kind === "markdown" ? block.text.split("\n") : []))
    .map((text) => text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export class NotebookMapState {
  camX: number | undefined;
  camY: number | undefined;
  view: MapView = "columns";
  viewRows = Infinity;
  map: MindMap;
  private path: MapNode[];
  private readonly lastChild = new Map<MapNode, MapNode>();
  private readonly history: MapNode[][] = [];
  private filtering: { query: string; before: MapNode[]; matches: MapNode[] } | undefined;

  constructor(readonly tree: NotebookTree) {
    this.path = [tree.root];
    this.map = this.layout();
    this.go([tree.root]);
  }

  get node(): MapNode {
    return this.path.at(-1)!;
  }

  get selected(): number {
    const node = this.node;
    return Math.max(this.map.placed.findIndex((item) => item.node === node), 0);
  }

  get choice(): MindMap["placed"][number] {
    return this.map.placed[this.selected]!;
  }

  get trail(): MapNode[] {
    return [...this.path];
  }

  get roomPage(): string | undefined {
    return this.node.owner ?? this.node.where?.page;
  }

  get door(): { to: string } | undefined {
    const target = this.target();
    return target ? { to: target.label } : undefined;
  }

  get filter(): string | undefined {
    return this.filtering?.query;
  }

  get filterStatus(): { query: string; at: number; count: number } | undefined {
    const filtering = this.filtering;
    if (!filtering) return undefined;
    return { query: filtering.query, at: filtering.matches.indexOf(this.node) + 1, count: filtering.matches.length };
  }

  startFilter(): void {
    this.filtering = { query: "", before: this.path, matches: [] };
  }

  typeFilter(text: string): void {
    const filtering = this.filtering!;
    filtering.query += text;
    this.refilter();
  }

  eraseFilter(): void {
    const filtering = this.filtering!;
    if (filtering.query === "") return this.cancelFilter();
    filtering.query = filtering.query.slice(0, -1);
    this.refilter();
  }

  moveFilter(delta: number): void {
    const matches = this.filtering?.matches ?? [];
    const next = matches[matches.indexOf(this.node) + delta];
    if (next) this.go(this.pathTo(next));
  }

  acceptFilter(): void {
    const filtering = this.filtering;
    this.filtering = undefined;
    if (filtering && filtering.matches.length > 0) this.history.push(filtering.before);
    this.go(this.path);
  }

  cancelFilter(): void {
    const before = this.filtering?.before;
    this.filtering = undefined;
    if (before) this.go(before);
  }

  private refilter(): void {
    const filtering = this.filtering!;
    const words = filtering.query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches: MapNode[] = [];
    const visit = (node: MapNode) => {
      const text = `${node.label} ${node.detail ?? ""}`.toLowerCase();
      if (words.length > 0 && ["root", "page", "heading"].includes(node.kind) && words.every((word) => text.includes(word))) matches.push(node);
      node.children.forEach(visit);
    };
    visit(this.tree.root);
    filtering.matches = matches;
    this.go(matches[0] ? this.pathTo(matches[0]) : filtering.before);
  }

  get depth(): number {
    return this.history.length;
  }

  selectPage(page: string | undefined, line: number): void {
    const node = page ? this.tree.pages.get(page) : undefined;
    if (!node) return this.go([this.tree.root]);
    let best = node;
    const visit = (from: MapNode) => {
      for (const child of from.children) {
        if (child.kind !== "heading") continue;
        if ((child.where?.line ?? Infinity) <= line) best = child;
        visit(child);
      }
    };
    visit(node);
    this.go(this.pathTo(best));
  }

  toggleView(): void {
    this.view = this.view === "columns" ? "map" : "columns";
    this.camX = undefined;
    this.camY = undefined;
  }

  out(): void {
    if (this.path.length < 3) return;
    this.lastChild.set(this.path.at(-2)!, this.node);
    this.go(this.path.slice(0, -1));
  }

  in(): void {
    const children = this.node.children;
    const child = this.lastChild.get(this.node) ?? children[0];
    if (child) this.go([...this.path, child]);
  }

  sideways(delta: number): void {
    const parent = this.path.at(-2);
    if (!parent) return;
    const siblings = parent.children;
    const next = siblings[siblings.indexOf(this.node) + delta];
    if (next) this.go([...this.path.slice(0, -1), next]);
  }

  warp(): boolean {
    const target = this.target();
    if (!target) return false;
    this.history.push(this.path);
    this.go(this.pathTo(target));
    return true;
  }

  back(): boolean {
    const path = this.history.pop();
    if (!path) return false;
    this.go(path);
    return true;
  }

  columns(rows: number): Column[] {
    const path = this.path;
    const node = this.node;
    const parent = path.at(-2);
    const grand = path.at(-3);
    const target = this.target();
    const column = (title: string, items: MapNode[], focus: MapNode | undefined): Column => {
      if (items.length <= rows) return { title, items, focus };
      const at = Math.max(focus ? items.indexOf(focus) : 0, 0);
      const start = Math.max(0, Math.min(at - Math.floor(rows / 2), items.length - rows));
      return { title, items: items.slice(start, start + rows), focus };
    };
    const position = (items: MapNode[], focus: MapNode) => (items.length > 1 ? `  ${items.indexOf(focus) + 1}/${items.length}` : "");
    const filtering = this.filtering;
    if (filtering) {
      const found = filtering.matches.includes(node);
      return [
        column(`/${filtering.query}`, [], undefined),
        column(filtering.matches.length === 0 ? "no matches" : `matches${found ? position(filtering.matches, node) : ""}`, filtering.matches, found ? node : undefined),
        column("lives in", found ? path.slice(0, -1) : [], undefined),
      ];
    }
    const text = (line: string): MapNode => ({ label: line, kind: "text", where: undefined, children: [] });
    const below = target
      ? target.children.length === 0
        ? column("⤳ lands in", this.pathTo(target), target)
        : column(`⤳ ${target.label}`, target.children, this.lastChild.get(target))
      : node.children.length === 0
        ? column(node.label, previewLines(this.tree, node).map(text), undefined)
        : column(node.label, node.children, this.lastChild.get(node));
    return [
      grand ? column(grand.label, grand.children, parent) : column("", [], undefined),
      column(`${parent?.label ?? ""}${parent ? position(parent.children, node) : ""}`, parent ? parent.children : [node], node),
      below,
    ];
  }

  private target(): MapNode | undefined {
    const node = this.node;
    if (node.kind !== "portal") return undefined;
    return portalTarget(this.tree, node);
  }

  private pathTo(node: MapNode): MapNode[] {
    const path = [node];
    for (let at = this.tree.parents.get(node); at; at = this.tree.parents.get(at)) path.unshift(at);
    return path;
  }

  private go(route: MapNode[]): void {
    const first = this.tree.root.children[0];
    const path = route.length === 1 && first ? [route[0]!, first] : route;
    const target = path.at(-1);
    const before = this.map.placed.find((item) => item.node === target);
    this.path = path;
    this.map = this.layout();
    const after = this.choice;
    if (before && this.camX !== undefined && this.camY !== undefined) {
      this.camX += after.col - before.col;
      this.camY += after.row - before.row;
    }
  }

  private layout(): MindMap {
    const open = new Set(this.path);
    const focus = this.path.length - 1;
    const limit = (depth: number) => (depth >= focus ? focusLabel : Math.max(Math.round(ancestorLabel * shrink ** (focus - depth)), minLabel));
    const node = this.node;
    const lines = node.children.length === 0 ? previewLines(this.tree, node).flatMap((line) => wrap(line, previewWidth)) : [];
    const preview = lines.length > previewRows ? [...lines.slice(0, previewRows - 1), `${lines[previewRows - 1]} …`] : lines;
    const text = preview.map((line): MapNode => ({ label: line, kind: "text", where: undefined, children: [] }));
    const matches = this.filtering?.matches ?? [];
    if (matches.length > 0) {
      const keep = new Set(matches.flatMap((match) => this.pathTo(match)));
      return layoutMindMap(this.tree.root, (from) => (keep.has(from) ? from.children.filter((child) => keep.has(child)) : []), open, new Set(), limit, this.viewRows);
    }
    const children = (from: MapNode) => (from === node && text.length > 0 ? text : open.has(from) ? from.children : []);
    return layoutMindMap(this.tree.root, children, open, new Set(this.path.slice(1)), limit, this.viewRows);
  }
}

export type NotebookMapOutcome = "move" | "land" | "exit" | "none";

type AtlasRun = (state: NotebookMapState) => NotebookMapOutcome;

const moved = (change: () => void): NotebookMapOutcome => (change(), "move");

export const atlasFilterBindings: Binding<AtlasRun>[] = [
  { group: "Atlas filter", label: "filter", on: [], keys: "type" },
  { group: "Atlas filter", label: "previous match", on: ["up", "^p"], run: (state) => moved(() => state.moveFilter(-1)) },
  { group: "Atlas filter", label: "next match", on: ["down", "^n"], run: (state) => moved(() => state.moveFilter(1)) },
  { group: "Atlas filter", label: "erase", on: ["backspace"], run: (state) => moved(() => state.eraseFilter()) },
  { group: "Atlas filter", label: "go", on: ["return"], run: (state) => moved(() => state.acceptFilter()) },
  { group: "Atlas filter", label: "cancel", on: ["escape"], run: (state) => moved(() => state.cancelFilter()) },
];

export const atlasBindings: Binding<AtlasRun>[] = [
  { group: "Atlas", label: "out", on: ["h", "left"], run: (state) => moved(() => state.out()) },
  { group: "Atlas", label: "next", on: ["j", "down"], run: (state) => moved(() => state.sideways(1)) },
  { group: "Atlas", label: "previous", on: ["k", "up"], run: (state) => moved(() => state.sideways(-1)) },
  { group: "Atlas", label: "in", on: ["l", "right"], run: (state) => moved(() => state.in()) },
  { group: "Atlas", label: "back", on: ["backspace", "H"], run: (state) => (state.back() ? "move" : "none") },
  { group: "Atlas", label: "follow the link", on: ["return"], run: (state) => (state.warp() ? "move" : "land") },
  { group: "Atlas", label: "filter", on: ["/"], menu: "/", run: (state) => moved(() => state.startFilter()) },
  { group: "Atlas", label: "columns or map", on: ["v"], menu: "v", run: (state) => moved(() => state.toggleView()) },
  { group: "Atlas", label: "land on the page", on: ["a"], menu: "a", run: () => "land" },
  { group: "Atlas", label: "leave the atlas", on: ["escape", "q", "^c"], run: () => "exit" },
];

export function notebookMapKey(state: NotebookMapState, key: KeyEvent): NotebookMapOutcome {
  if (state.filter !== undefined) {
    const binding = bindingFor(atlasFilterBindings, key);
    if (binding?.run) return binding.run(state);
    const text = typedText(key);
    if (!text) return "none";
    state.typeFilter(text);
    return "move";
  }
  return bindingFor(atlasBindings, key)?.run?.(state) ?? "none";
}
