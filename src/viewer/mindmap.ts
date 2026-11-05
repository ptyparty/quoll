import { BoxRenderable, TextRenderable, bg, bold, fg, type CliRenderer } from "@opentui/core";
import { basename } from "node:path";
import type { Document } from "../document.ts";
import type { Target } from "../notebook.ts";
import { styled, type Part } from "../render/styled.ts";
import { theme } from "../render/theme.ts";

export type Where = { page: string; line?: number; anchor?: string };

export type MapNode = {
  label: string;
  kind: "root" | "page" | "heading" | "link" | "anchor" | "portal" | "tag" | "group" | "text";
  where: Where | undefined;
  children: MapNode[];
  left?: boolean;
  owner?: string;
  back?: boolean;
  detail?: string;
  lead?: boolean;
};


type Side = "left" | "center" | "right";

export type Placed = { node: MapNode; side: Side; depth: number; layer: number; layerDepth: number; row: number; col: number; width: number; parent: number | undefined; children: number[] };

type Cell = { ch: string; node?: number; line?: boolean; lit?: boolean; layer?: number; depth?: number };

export type MindMap = { placed: Placed[]; cells: Cell[][]; width: number; height: number };

const maxLabel = 28;
const fadeStep = 0.22;
export const previewRows = 5;
const mapShare = 0.38;
const maxFade = 0.7;
const connector = 3;

export function pageTitle(page: string | undefined, document: Document): string {
  const headings = document.headings;
  const titled = headings[0]?.level === 1 && headings.filter((heading) => heading.level === 1).length === 1;
  return titled ? headings[0]!.text : page ? basename(page, ".md") : "Notebook";
}

export function buildMindMap(page: string | undefined, document: Document, resolve: (target: string) => Target | undefined): MapNode {
  const headings = document.headings;
  const titled = headings[0]?.level === 1 && headings.filter((heading) => heading.level === 1).length === 1;
  const at = (line: number): Where | undefined => (page ? { page, line } : undefined);
  const root: MapNode = { label: pageTitle(page, document), kind: "root", where: at(0), children: [] };
  const stack: { level: number; node: MapNode }[] = [{ level: 0, node: root }];
  const owners: { line: number; node: MapNode }[] = [{ line: -1, node: root }];
  const children = new Map<MapNode, { line: number; node: MapNode }[]>();
  const attach = (owner: MapNode, line: number, node: MapNode) => children.set(owner, [...(children.get(owner) ?? []), { line, node }]);
  for (const heading of titled ? headings.slice(1) : headings) {
    while (stack.length > 1 && stack.at(-1)!.level >= heading.level) stack.pop();
    const node: MapNode = { label: heading.text, kind: "heading", where: at(heading.line), children: [] };
    attach(stack.at(-1)!.node, heading.line, node);
    stack.push({ level: heading.level, node });
    owners.push({ line: heading.line, node });
  }
  const seen = new Map<MapNode, Set<string>>();
  for (const link of document.links) {
    const target = resolve(link.target);
    if (!target || (target.page === page && target.anchor === undefined)) continue;
    const owner = owners.findLast((candidate) => candidate.line <= link.line)!.node;
    const key = `${target.page}#${target.anchor ?? ""}`;
    const keys = seen.get(owner) ?? new Set();
    seen.set(owner, keys);
    if (keys.has(key)) continue;
    keys.add(key);
    const local = target.page === page;
    attach(owner, link.line, { label: link.label, kind: local ? "anchor" : "link", where: { page: target.page, ...(target.anchor ? { anchor: target.anchor } : {}) }, children: [], ...(link.lead ? { lead: true } : {}) });
  }
  for (const [owner, list] of children) owner.children = list.sort((a, b) => a.line - b.line).map((entry) => entry.node);
  return root;
}

export function layoutMindMap(root: MapNode, childrenOf: (node: MapNode) => MapNode[] = (node) => node.children, lit: Set<MapNode> = new Set(), raised: Set<MapNode> = new Set(), limit: (depth: number) => number = () => maxLabel, tall = Infinity): MindMap {
  const placed: Placed[] = [{ node: root, side: "center", depth: 0, layer: -1, layerDepth: 0, row: 0, col: 0, width: displayWidth(nodeText(root, limit(0))), parent: undefined, children: [] }];
  const add = (node: MapNode, side: Side, parent: number): number => {
    const index = placed.length;
    const up = placed[parent]!;
    const opens = raised.has(up.node);
    placed.push({ node, side, depth: up.depth + 1, layer: opens ? parent : up.layer, layerDepth: opens ? 1 : up.layerDepth + 1, row: 0, col: 0, width: displayWidth(nodeText(node, limit(up.depth + 1))), parent, children: [] });
    up.children.push(index);
    for (const child of childrenOf(node)) add(child, side, index);
    return index;
  };
  const rightTops = childrenOf(root).filter((child) => !onLeft(child)).map((child) => add(child, "right", 0));
  const leftTops = childrenOf(root).filter(onLeft).map((child) => add(child, "left", 0));
  const place = (index: number, top: number): number => {
    const item = placed[index]!;
    if (item.children.length === 0 || raised.has(item.node)) {
      item.row = top;
      return 1;
    }
    let height = 0;
    for (const child of item.children) height += place(child, top + height);
    item.row = Math.floor((placed[item.children[0]!]!.row + placed[item.children.at(-1)!]!.row) / 2);
    return height;
  };
  const placeSide = (tops: number[]): number => {
    let height = 0;
    tops.forEach((index, at) => {
      const roomy = (placed[index]!.children.length > 0 && !raised.has(placed[index]!.node)) || (at > 0 && placed[tops[at - 1]!]!.children.length > 0 && !raised.has(placed[tops[at - 1]!]!.node));
      if (at > 0 && roomy) height++;
      height += place(index, height);
    });
    return height;
  };
  const rightHeight = placeSide(rightTops);
  const leftHeight = placeSide(leftTops);
  const baseHeight = Math.max(rightHeight, leftHeight, 1);
  const shift = (side: Side, by: number) => placed.forEach((item) => item.side === side && (item.row += by));
  shift("right", Math.floor((baseHeight - rightHeight) / 2));
  shift("left", Math.floor((baseHeight - leftHeight) / 2));
  const rootItem = placed[0]!;
  const anchors = (rightTops.length > 0 ? rightTops : leftTops).map((index) => placed[index]!.row);
  rootItem.row = anchors.length > 0 ? Math.floor((anchors[0]! + anchors.at(-1)!) / 2) : 0;
  const descendants = (index: number): number[] => placed[index]!.children.flatMap((child) => [child, ...descendants(child)]);
  const owners = placed.flatMap((item, index) => (raised.has(item.node) && item.children.length > 0 ? [index] : []));
  for (const owner of owners) {
    const item = placed[owner]!;
    placeSide(item.children);
    const first = placed[item.children[0]!]!.row;
    const last = placed[item.children.at(-1)!]!.row;
    const by = last - first + 1 > tall ? item.row - Math.floor(tall / 2) - first : item.row - Math.floor((first + last) / 2);
    for (const index of descendants(owner)) placed[index]!.row += by;
  }
  const widths = new Map<string, number>();
  const widthKey = (layer: number, side: Side, depth: number) => `${layer}:${side}:${depth}`;
  for (const item of placed) {
    const key = widthKey(item.layer, item.side, item.layerDepth);
    widths.set(key, Math.max(widths.get(key) ?? 0, item.width));
  }
  const before = (layer: number, side: Side, depth: number) => {
    let sum = 0;
    for (let at = 1; at < depth; at++) sum += (widths.get(widthKey(layer, side, at)) ?? 0) + connector;
    return sum;
  };
  const deepest = Math.max(0, ...placed.filter((item) => item.layer === -1 && item.side === "left").map((item) => item.layerDepth));
  rootItem.col = before(-1, "left", deepest + 1);
  const reach = (owner: Placed) => (owner === rootItem ? owner.width : (widths.get(widthKey(owner.layer, owner.side, owner.layerDepth)) ?? owner.width));
  for (const item of placed.slice(1)) {
    const owner = item.layer === -1 ? rootItem : placed[item.layer]!;
    const offset = connector + before(item.layer, item.side, item.layerDepth);
    item.col = item.side === "right" ? owner.col + reach(owner) + offset : owner.col + owner.width - reach(owner) - offset - item.width;
  }
  const top = Math.min(...placed.map((item) => item.row));
  const left = Math.min(...placed.map((item) => item.col));
  for (const item of placed) {
    item.row -= top;
    item.col -= left;
  }
  const height = Math.max(...placed.map((item) => item.row)) + 1;
  const width = Math.max(...placed.map((item) => item.col + item.width));
  const cells: Cell[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ch: " " })));
  for (const layer of [-1, ...owners]) {
    const raise = layer !== -1;
    const members = placed.flatMap((item, index) => (item.layer === layer ? [index] : []));
    let depth = 0;
    const put = (row: number, col: number, ch: string, lit: boolean) => {
      if (cells[row]?.[col]) cells[row]![col] = { ch, line: true, depth, ...(lit ? { lit } : {}), ...(raise ? { layer } : {}) };
    };
    if (raise) {
      const owner = placed[layer]!;
      const rows = members.map((index) => placed[index]!.row);
      const right = owner.side !== "left";
      const from = right ? owner.col + reach(owner) + 1 : Math.min(...members.map((index) => placed[index]!.col)) - 1;
      const to = right ? Math.max(...members.map((index) => placed[index]!.col + placed[index]!.width)) : owner.col + owner.width - reach(owner) - 2;
      for (let row = Math.min(...rows); row <= Math.max(...rows); row++) {
        for (let col = from; col <= to; col++) if (cells[row]?.[col]) cells[row]![col] = { ch: " ", layer };
      }
    }
    const parents = raise ? [layer, ...members] : members;
    for (const parent of parents) {
      const item = placed[parent]!;
      depth = item.depth;
      const children = item.children.map((child) => placed[child]!).filter((child) => child.layer === layer);
      for (const side of ["right", "left"] as const) {
        const kids = children.filter((child) => child.side === side && child.node.kind !== "text");
        const text = children.find((child) => child.side === side && child.node.kind === "text");
        if (kids.length === 0 && text) for (let col = item.col + item.width; col < text.col; col++) put(item.row, col, "╌", false);
        if (kids.length === 0) continue;
        const spine = side === "right" ? kids[0]!.col - 2 : Math.max(...kids.map((kid) => kid.col + kid.width)) + 1;
        const [from, to] = side === "right" ? [item.col + item.width, spine - 1] : [spine + 1, item.col - 1];
        const litRow = lit.has(item.node) ? kids.find((kid) => lit.has(kid.node))?.row : undefined;
        const onRoad = (row: number) => litRow !== undefined && row >= Math.min(item.row, litRow) && row <= Math.max(item.row, litRow);
        for (let col = from; col <= to; col++) put(item.row, col, "─", litRow !== undefined);
        const kidRows = new Set(kids.map((kid) => kid.row));
        const first = Math.min(item.row, ...kidRows);
        const last = Math.max(item.row, ...kidRows);
        for (let row = first; row <= last; row++) {
          const toParent = row === item.row;
          const toChild = kidRows.has(row);
          put(row, spine, junction(row > first, row < last, side === "right" ? toParent : toChild, side === "right" ? toChild : toParent), onRoad(row));
          if (toChild) put(row, side === "right" ? spine + 1 : spine - 1, "─", row === litRow);
        }
      }
    }
    for (const index of members) writeText(cells[placed[index]!.row]!, placed[index]!.col, nodeText(placed[index]!.node, limit(placed[index]!.depth)), index, raise ? layer : undefined);
  }
  return { placed, cells, width, height };
}

function onLeft(node: MapNode): boolean {
  return node.left === true;
}

function junction(up: boolean, down: boolean, left: boolean, right: boolean): string {
  const key = `${up ? "u" : ""}${down ? "d" : ""}${left ? "l" : ""}${right ? "r" : ""}`;
  const chars: Record<string, string> = { udlr: "┼", udr: "├", udl: "┤", ulr: "┴", dlr: "┬", ur: "└", dr: "┌", ul: "┘", dl: "┐", lr: "─", ud: "│", u: "│", d: "│", l: "─", r: "─" };
  return chars[key] ?? " ";
}

function nodeText(node: MapNode, limit = maxLabel): string {
  if (node.kind === "text") return ` ${node.label} `;
  const prefix = node.kind === "portal" ? (node.back ? "↩ " : "⤳ ") : node.kind === "link" ? "↗ " : node.kind === "anchor" ? "→ " : "";
  return ` ${prefix}${truncate(plain(node.label), limit)} `;
}

function plain(label: string): string {
  return label
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_whole, target: string, alias: string | undefined) => alias?.trim() || target.trim())
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "");
}

function truncate(text: string, limit: number): string {
  const chars = [...text];
  return chars.length > limit ? `${chars.slice(0, Math.max(limit - 1, 1)).join("")}…` : text;
}

function displayWidth(text: string): number {
  return Bun.stringWidth(text);
}

function writeText(row: Cell[], col: number, text: string, node: number, layer: number | undefined): void {
  let at = col;
  const lift = layer === undefined ? {} : { layer };
  for (const ch of text) {
    const width = Math.max(displayWidth(ch), 1);
    if (row[at]) row[at] = { ch, node, ...lift };
    for (let extra = 1; extra < width; extra++) if (row[at + extra]) row[at + extra] = { ch: "", node, ...lift };
    at += width;
  }
}

export type MapState = {
  camX: number | undefined;
  camY: number | undefined;
  map: MindMap;
  selected: number;
  choice: Placed;
  trail: MapNode[];
  roomPage: string | undefined;
  view: "columns" | "map";
  depth: number;
  filterStatus: { query: string; at: number; count: number } | undefined;
  columns(rows: number): { title: string; items: MapNode[]; focus: MapNode | undefined }[];
};

export class MindMapView {
  private readonly box: BoxRenderable;
  private readonly text: TextRenderable;
  private readonly caption: TextRenderable;
  private focused = true;
  private lastColumns: { columns: Part[][][]; depth: number } | undefined;
  private slide: { strip: Part[][][]; offset: number; target: number; size: number } | undefined;
  private state: MapState | undefined;
  private shown = 0;
  private target = 0;

  constructor(
    private readonly renderer: CliRenderer,
    parent: BoxRenderable,
  ) {
    this.box = new BoxRenderable(renderer, { width: "100%", height: 0, flexShrink: 0, overflow: "hidden", visible: false, border: ["bottom"], borderColor: theme.border, backgroundColor: theme.background });
    this.text = new TextRenderable(renderer, { wrapMode: "none", flexShrink: 0 });
    this.caption = new TextRenderable(renderer, { wrapMode: "none", flexShrink: 0, height: 1 });
    this.box.add(this.text);
    this.box.add(this.caption);
    parent.add(this.box);
  }

  focus(map: boolean): void {
    this.focused = map;
    this.box.borderColor = map ? theme.accent : theme.border;
    if (this.state) this.drawCaption(this.state);
  }

  render(state: MapState | undefined): void {
    this.state = state;
    this.box.visible = state !== undefined;
    if (!state) {
      this.lastColumns = undefined;
      this.slide = undefined;
      this.shown = 0;
      this.target = 0;
      this.box.height = 0;
      return;
    }
    this.target = this.rows() + 2;
    this.box.height = this.shown;
    this.text.height = this.rows();
    this.drawCaption(state);
    if (state.view === "columns") return this.drawColumns(state);
    this.lastColumns = undefined;
    this.slide = undefined;
    const goal = this.goal(state);
    state.camX ??= goal.x;
    state.camY ??= goal.y;
    this.draw(state);
  }

  step(): boolean {
    const state = this.state;
    if (!state) return false;
    let moving = false;
    if (this.shown < this.target) {
      this.shown = Math.min(this.target, this.shown + Math.max(Math.ceil(this.target / 4), 1));
      this.box.height = this.shown;
      moving = true;
    }
    if (state.view === "columns") {
      const slide = this.slide;
      if (!slide) return moving;
      const remaining = slide.target - slide.offset;
      slide.offset += Math.sign(remaining) * Math.min(Math.abs(remaining), Math.max(2, Math.ceil(Math.abs(remaining) / 3)));
      this.paintColumns(slide.strip, slide.offset, slide.size);
      if (slide.offset === slide.target) this.slide = undefined;
      return true;
    }
    const goal = this.goal(state);
    const glide = (from: number, to: number) => (Math.abs(to - from) < 1 ? to : from + (to - from) / 2);
    if (state.camX !== goal.x || state.camY !== goal.y) {
      state.camX = glide(state.camX ?? goal.x, goal.x);
      state.camY = glide(state.camY ?? goal.y, goal.y);
      this.draw(state);
      moving = true;
    }
    return moving;
  }

  rows(): number {
    return Math.max(Math.floor((this.renderer.height - 1) * mapShare) - 2, 3);
  }

  private goal(state: MapState): { x: number; y: number } {
    const choice = state.choice;
    const placed = state.map.placed;
    const siblings = choice.parent === undefined ? [choice] : placed[choice.parent]!.children.map((index) => placed[index]!).filter((item) => item.layer === choice.layer);
    const left = Math.min(...siblings.map((item) => item.col));
    const right = Math.max(...siblings.map((item) => item.col + item.width));
    const rows = this.rows();
    const y = choice.row - Math.floor(rows / 2);
    const below = choice.children.map((index) => placed[index]!);
    const centred = Math.floor((left + right) / 2) - Math.floor(this.renderer.width / 2);
    const x = below.length > 0 ? Math.max(centred, Math.max(...below.map((item) => item.col + item.width)) - this.renderer.width + 1) : centred;
    return { x: Math.min(x, left), y };
  }

  private draw(state: MapState): void {
    const { map } = state;
    const width = this.renderer.width;
    const height = this.rows();
    const left = Math.round(state.camX ?? 0);
    const top = Math.round(state.camY ?? 0);
    const selected = state.selected;
    const trail = new Set(state.trail);
    const look = { map, selected, trail, room: state.roomPage, focus: map.placed[selected]?.depth ?? 0 };
    const lines: Part[] = [];
    for (let y = 0; y < height; y++) {
      if (y > 0) lines.push("\n");
      let run = "";
      let runStyle: ((text: string) => Part) | undefined;
      let runKey = "";
      const flush = () => {
        if (run) lines.push(runStyle ? runStyle(run) : run);
        run = "";
      };
      for (let x = 0; x < width; x++) {
        const cell = map.cells[y + top]?.[x + left] ?? { ch: " " };
        const key = `${cell.node !== undefined ? `n${cell.node}` : cell.line ? (cell.lit ? "lit" : "line") : "blank"}@${cell.layer ?? -1}`;
        if (key !== runKey) {
          flush();
          runKey = key;
          runStyle = cellStyle(cell, look);
        }
        run += cell.ch;
      }
      flush();
    }
    this.text.content = styled(lines);
  }

  private drawCaption(state: MapState): void {
    const width = this.renderer.width;
    const filter = state.filterStatus;
    const query: Part[] = filter ? [bold(fg(theme.accent)(` /${filter.query}`)), fg(filter.count === 0 ? theme.warning : theme.muted)(filter.count === 0 ? "  no matches" : `  ${filter.at}/${filter.count}`), fg(theme.border)("  │")] : [];
    const used = query.reduce((sum, part) => sum + Bun.stringWidth(typeof part === "string" ? part : part.text), 0);
    const detail = state.trail.at(-1)?.detail;
    const suffix = `${detail ? ` (${detail})` : ""}${state.depth > 0 ? ` ⌫${state.depth}` : ""}`;
    const path = breadcrumb(state.trail.map((node) => plain(node.label)), width - used - Bun.stringWidth(suffix) - 2);
    const label = this.focused ? (text: string) => bold(fg(theme.selected)(text)) : (text: string) => fg(theme.muted)(text);
    this.caption.content = styled([...query, label(` ${path}`), fg(theme.muted)(suffix)]);
  }

  private drawColumns(state: MapState): void {
    const width = this.renderer.width;
    const rows = this.rows();
    const size = Math.max(Math.floor((width - 2) / 3), 8);
    const selected = state.trail.at(-1);
    const columns = state.columns(Math.max(rows - 2, 1)).map((column, at) => {
      const cells: Part[][] = [[bold(fg(theme.muted)(fit(column.title ? ` ${plain(column.title)}` : "", size)))], [fg(theme.border)("─".repeat(size))]];
      for (const item of column.items) {
        if (item.kind === "text") {
          for (const line of wrap(item.label, size - 2)) {
            if (cells.length - 2 === previewRows) {
              cells[cells.length - 1] = [fg(theme.muted)(fit(`${plainText(cells.at(-1)!)} …`, size))];
              break;
            }
            cells.push([fg(theme.muted)(fit(` ${line}`, size))]);
          }
          continue;
        }
        const label = ` ${columnLabel(item)}`;
        const room = size - Bun.stringWidth(label) - 1;
        const detail = item.detail && Bun.stringWidth(` ${item.detail}`) <= room ? fit(` ${item.detail}`, room) : "";
        if (item === selected && at === 1) cells.push([bold(bg(theme.selected)(fg(theme.background)(fit(label, size))))]);
        else if (item === column.focus) cells.push([bold(bg(theme.surface)(fg(kindColor(item))(fit(label, size))))]);
        else cells.push([fg(kindColor(item))(fit(label, size - Bun.stringWidth(detail))), fg(theme.muted)(detail)]);
      }
      return cells;
    });
    const depth = state.trail.length;
    const last = this.lastColumns;
    const pitch = size + 1;
    if (last && depth === last.depth + 1) this.slide = { strip: [last.columns[0]!, ...columns], offset: 0, target: pitch, size };
    else if (last && depth === last.depth - 1) this.slide = { strip: [...columns, last.columns[2]!], offset: pitch, target: 0, size };
    else this.slide = undefined;
    this.lastColumns = { columns, depth };
    this.paintColumns(this.slide?.strip ?? columns, this.slide?.offset ?? 0, size);
  }

  private paintColumns(strip: Part[][][], offset: number, size: number): void {
    const width = this.renderer.width;
    const lines: Part[] = [];
    for (let y = 0; y < this.rows(); y++) {
      if (y > 0) lines.push("\n");
      const row = strip.flatMap((cells, at) => [...(at > 0 ? [fg(theme.border)("│")] : []), ...(cells[y] ?? [" ".repeat(size)])]);
      lines.push(...sliceParts(row, offset, width));
    }
    this.text.content = styled(lines);
  }
}

function sliceParts(parts: Part[], start: number, width: number): Part[] {
  const out: Part[] = [];
  let x = 0;
  for (const part of parts) {
    const text = typeof part === "string" ? part : part.text;
    let kept = "";
    for (const ch of text) {
      const size = Math.max(Bun.stringWidth(ch), 1);
      if (x >= start && x + size <= start + width) kept += ch;
      x += size;
    }
    if (kept) out.push(typeof part === "string" ? kept : { ...part, text: kept });
  }
  return out;
}

function plainText(parts: Part[]): string {
  return parts.map((part) => (typeof part === "string" ? part : part.text)).join("").trimEnd();
}

function breadcrumb(labels: string[], room: number): string {
  const full = labels.join(" › ");
  if (Bun.stringWidth(full) <= room || labels.length < 2) return Bun.stringWidth(full) <= room ? full : fit(full, room).trimEnd();
  const tail: string[] = [];
  for (let at = labels.length - 1; at > 0; at--) {
    const next = [labels[0]!, "…", labels[at]!, ...tail].join(" › ");
    if (Bun.stringWidth(next) > room && tail.length > 0) break;
    tail.unshift(labels[at]!);
  }
  const short = [labels[0]!, ...(tail.length < labels.length - 1 ? ["…"] : []), ...tail].join(" › ");
  return Bun.stringWidth(short) <= room ? short : fit(short, room).trimEnd();
}

function fit(text: string, size: number): string {
  const width = Bun.stringWidth(text);
  if (width <= size) return text + " ".repeat(size - width);
  const chars = [...text];
  const keep = Math.max(size - 1, 1);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  let start = "";
  for (const ch of chars) {
    if (Bun.stringWidth(start + ch) > head) break;
    start += ch;
  }
  let end = "";
  for (const ch of chars.reverse()) {
    if (Bun.stringWidth(ch + end) > tail) break;
    end = ch + end;
  }
  const out = `${start}…${end}`;
  return out + " ".repeat(Math.max(size - Bun.stringWidth(out), 0));
}

export function wrap(text: string, size: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && Bun.stringWidth(`${line} ${word}`) > size) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function columnLabel(node: MapNode): string {
  const prefix = node.kind === "portal" ? (node.back ? "↩ " : "⤳ ") : node.kind === "anchor" ? "→ " : node.kind === "page" ? "▤ " : "";
  return `${prefix}${plain(node.label)}${node.children.length > 0 ? " ›" : ""}`;
}

type Look = { map: MindMap; selected: number; trail: Set<MapNode>; room: string | undefined; focus: number };

function cellStyle(cell: Cell, look: Look): ((text: string) => Part) | undefined {
  const depth = cell.node !== undefined ? look.map.placed[cell.node]!.depth : (cell.depth ?? look.focus);
  const up = Math.max(look.focus - depth, 0);
  if (cell.line) return (text) => fg(fade(cell.lit ? theme.selected : theme.border, up))(text);
  if (cell.node === undefined) return undefined;
  const node = look.map.placed[cell.node]!.node;
  if (cell.node === look.selected) return (text) => bold(bg(theme.selected)(fg(theme.background)(text)));
  const inRoom = look.room !== undefined && (node.owner ?? node.where?.page) === look.room;
  const style = nodeStyle(node, look.trail.has(node), inRoom, up);
  return inRoom ? (text) => bg(theme.surface)(style(text)) : style;
}

function nodeStyle(node: MapNode, onTrail: boolean, inRoom: boolean, up: number): (text: string) => Part {
  const color = fade(!inRoom && node.kind !== "root" ? theme.muted : kindColor(node), up);
  return onTrail || node.kind === "root" || node.kind === "page" ? (text) => bold(fg(color)(text)) : (text) => fg(color)(text);
}

function fade(color: string, steps: number): string {
  if (steps === 0) return color;
  const amount = Math.min(steps * fadeStep, maxFade);
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
  const mix = [1, 3, 5].map((at) => Math.round(channel(color, at) * (1 - amount) + channel(theme.background, at) * amount));
  return `#${mix.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function kindColor(node: MapNode): string {
  if (node.kind === "root" || node.kind === "page" || node.kind === "link" || node.kind === "anchor") return theme.accent;
  if (node.kind === "portal") return node.back ? theme.follow : theme.accent;
  if (node.kind === "tag") return theme.changed;
  if (node.kind === "group") return theme.muted;
  return theme.text;
}
