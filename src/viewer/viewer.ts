import { BorderChars, BoxRenderable, MarkdownRenderable, MouseButton, ScrollBoxRenderable, TextRenderable, bold, fg, type CliRenderer, type KeyEvent, type Renderable, type SyntaxStyle } from "@opentui/core";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { blockAtLine, diffBlocks, firstChangedLine, headingKey, parseDocument, type Block, type Document } from "../document.ts";
import { imageIdColor, placeholderLines, type ImageOutput } from "../render/image.ts";
import { markdownStyle, sendImage } from "../render/markdown.ts";
import type { MermaidRenderer } from "../render/mermaid.ts";
import { styled, type Part } from "../render/styled.ts";
import { theme } from "../render/theme.ts";
import { contains, indexPage, listFiles, listPages, overlaps, resolveAsset, resolveTarget } from "../notebook.ts";
import { commentContext, type Comment } from "../comment.ts";
import type { Reply } from "../socket.ts";
import { History } from "./history.ts";
import { PickerState, PickerView, pickerKey, type PickerItem } from "./picker.ts";

export type ViewerOptions = {
  root: string;
  images: () => ImageOutput;
  edit: (file: string, line: number) => Promise<void>;
  follow: boolean;
  mermaid?: MermaidRenderer;
  comment?: (comment: Comment) => Promise<string>;
};

type Picker = { state: PickerState<() => void> };
type BlockFrame = { frame: BoxRenderable; gutter: TextRenderable };
type PageMarks = { changed: Set<number>; removed: Set<number> };
type Commenting = { selected: number; hints: Map<string, number>; top: number | undefined; settleFrames: number };
type Upload = { key: string; id: number; cols: number; rows: number };

const imageMargin = { cols: 4, rows: 4 };
const imageFile = /\.(png|jpe?g|gif|webp)$/i;
const followContext = 2;
const hintLetters = "asdfghlzxcvbnmertyuiopw";
const barChars = { ...BorderChars.single, vertical: "▎" };
const noBarChars = { ...BorderChars.single, vertical: " " };
const seenDelayFrames = 2;

export class Viewer {
  private readonly scroll: ScrollBoxRenderable;
  private readonly status: TextRenderable;
  private readonly pickerView: PickerView;
  private readonly style: SyntaxStyle;
  private readonly history = new History();
  private readonly known = new Map<string, string>();
  private readonly changed = new Set<string>();
  private readonly marks = new Map<string, PageMarks>();
  private readonly uploaded = new Map<string, Upload>();
  private readonly deferred = new Set<string>();
  private document: Document = { blocks: [], headings: [], links: [] };
  private pageViews: Renderable[] = [];
  private blockViews: BoxRenderable[] = [];
  private gaps: TextRenderable[] = [];
  private gutters: TextRenderable[] = [];
  private commenting: Commenting | undefined;
  private picker: Picker | undefined;
  private following: boolean;
  private pendingScroll: { line: number } | { top: number } | undefined;
  private settleFrames = 0;
  private seenFrames = 0;
  private shown: string | undefined;
  private lastChange: string | undefined;
  private pendingShow: { target: string; notebook: string } | undefined;
  private message: { text: string; until: number } | undefined;
  private editing = false;
  private closed: () => void = () => {};

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: ViewerOptions,
  ) {
    this.following = options.follow;
    this.style = markdownStyle(renderer);
    const frame = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", height: "100%", backgroundColor: theme.background });
    this.scroll = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      paddingRight: 1,
      contentOptions: { flexDirection: "column" },
      onMouseScroll: () => {
        this.stopFollowing();
        this.lookedAt();
      },
    });
    this.status = new TextRenderable(renderer, { height: 1, wrapMode: "none", flexShrink: 0 });
    frame.add(this.scroll);
    frame.add(this.status);
    renderer.root.add(frame);
    this.pickerView = new PickerView(renderer);
    for (const page of listPages(options.root)) this.remember(page.path);
    renderer.keyInput.on("keypress", this.onKey);
    renderer.setFrameCallback(async () => this.onFrame());
  }

  get page(): string | undefined {
    return this.shown;
  }

  get isFollowing(): boolean {
    return this.following;
  }

  run(): Promise<void> {
    return new Promise((resolve) => {
      this.closed = resolve;
    });
  }

  start(): void {
    this.visit(existsSync(join(this.options.root, indexPage)) ? indexPage : undefined);
  }

  show(target: string, notebook = this.options.root): Reply {
    const root = this.options.root;
    const current = this.page ? join(root, this.page) : undefined;
    const from = current && contains(notebook, current) ? relative(notebook, current) : undefined;
    const resolved = resolveTarget(notebook, from, target);
    if (!resolved) return overlaps(root, notebook) ? { error: `No page matches ${target}` } : { ignored: true };
    const file = join(notebook, resolved.page);
    if (!contains(root, file)) return { ignored: true };
    if (this.editing) {
      this.pendingShow = { target, notebook };
      return { ok: true };
    }
    const page = relative(root, file);
    this.stopFollowing();
    const found = this.visit(page, resolved.anchor);
    return found ? { ok: true } : { error: `Showing ${page}, but it has no heading ${resolved.anchor}` };
  }

  fileChanged(path: string): void {
    if (this.editing) {
      this.deferred.add(path);
      return;
    }
    if (!path.endsWith(".md")) {
      if (imageFile.test(path) && this.document.blocks.some((block) => block.kind === "image")) this.reload();
      return;
    }
    const seenBefore = this.known.has(path);
    const before = this.known.get(path) ?? "";
    const after = this.remember(path);
    if (after === undefined) {
      this.marks.delete(path);
      if (path === this.page) this.reload();
      return;
    }
    const line = firstChangedLine(before, after);
    if (line === undefined) return;
    if (seenBefore) this.markChanges(path, before, after);
    this.changed.add(path);
    this.lastChange = path;
    if (this.following) {
      this.saveScroll();
      this.history.visit(path, true);
      this.load(path);
      this.scrollTo({ line });
    } else if (path === this.page) {
      this.reload();
    }
    this.renderStatus();
  }

  close(): void {
    this.renderer.keyInput.off("keypress", this.onKey);
    this.closed();
  }

  private remember(path: string): string | undefined {
    try {
      const text = readFileSync(join(this.options.root, path), "utf8");
      this.known.set(path, text);
      return text;
    } catch {
      this.known.delete(path);
      return undefined;
    }
  }

  private markChanges(path: string, before: string, after: string, barNew = true): void {
    const old = parseDocument(before).blocks;
    const next = parseDocument(after).blocks;
    const changes = diffBlocks(old, next);
    const previous = this.marks.get(path);
    const marks: PageMarks = barNew ? { changed: new Set(changes.changed), removed: new Set(changes.removed) } : { changed: new Set(), removed: new Set() };
    for (const index of previous?.changed ?? []) {
      const moved = changes.matched.get(index);
      if (moved !== undefined) marks.changed.add(moved);
    }
    for (const index of previous?.removed ?? []) {
      const moved = index === old.length ? next.length : changes.matched.get(index);
      if (moved !== undefined) marks.removed.add(moved);
    }
    if (marks.changed.size === 0 && marks.removed.size === 0) this.marks.delete(path);
    else this.marks.set(path, marks);
    if (barNew && path === this.page) this.seenFrames = 0;
  }

  private visit(page: string | undefined, anchor?: string): boolean {
    this.saveScroll();
    if (page === undefined) {
      this.renderOverview();
      return true;
    }
    const sameAnchor = this.page === page && anchor === undefined;
    this.history.visit(page);
    if (!sameAnchor) this.load(page);
    const line = anchor ? this.anchorLine(anchor) : 0;
    this.scrollTo({ line: line ?? 0 });
    return line !== undefined;
  }

  private anchorLine(anchor: string): number | undefined {
    const key = headingKey(anchor);
    const heading = this.document.headings.find((candidate) => headingKey(candidate.text) === key);
    if (!heading) this.flash(`No heading ${anchor} on this page`);
    return heading?.line;
  }

  private saveScroll(): void {
    const current = this.history.current;
    if (current && current.page === this.shown) current.scroll = this.scroll.scrollTop;
  }

  private scrollTo(target: { line: number } | { top: number }): void {
    this.pendingScroll = target;
    this.settleFrames = 3;
    this.renderer.requestRender();
  }

  private reload(): void {
    const top = this.scroll.scrollTop;
    if (this.page) this.load(this.page);
    this.scrollTo({ top });
  }

  private load(page: string): void {
    this.shown = page;
    const text = this.remember(page);
    this.document = parseDocument(text ?? `# ${page}\n\nThis page doesn't exist yet.`);
    this.renderBlocks(page);
    this.renderStatus();
  }

  private renderOverview(): void {
    const pages = listPages(this.options.root);
    const list = pages.map((page) => `- [[${page.path.replace(/\.md$/, "")}]]`).join("\n");
    const body = pages.length > 0 ? `Pages, newest first:\n\n${list}` : "The notebook is empty. Pages appear here as they are written.";
    this.document = parseDocument(`# Notebook\n\nThere is no ${indexPage} yet.\n\n${body}`);
    this.shown = undefined;
    this.renderBlocks(undefined);
    this.scrollTo({ top: 0 });
    this.renderStatus();
  }

  private renderBlocks(page: string | undefined): void {
    for (const view of this.pageViews) {
      this.scroll.remove(view);
      view.destroyRecursively();
    }
    const files = this.lazyFiles();
    this.commenting = undefined;
    const frames = this.document.blocks.map((block, index) => this.blockFrame(this.blockView(block, page, files), index));
    this.blockViews = frames.map(({ frame }) => frame);
    this.gutters = frames.map(({ gutter }) => gutter);
    this.gaps = Array.from({ length: frames.length + 1 }, () => new TextRenderable(this.renderer, { content: "", height: 0, flexShrink: 0, wrapMode: "none" }));
    this.pageViews = this.gaps.flatMap((gap, index) => [gap, ...this.blockViews.slice(index, index + 1)]);
    for (const view of this.pageViews) this.scroll.add(view);
    this.renderMarks();
  }

  private renderMarks(): void {
    const marks = this.page ? this.marks.get(this.page) : undefined;
    const last = this.blockViews.length;
    this.blockViews.forEach((view, index) => {
      view.customBorderChars = marks?.changed.has(index) ? barChars : noBarChars;
    });
    this.gaps.forEach((gap, index) => {
      const removed = marks?.removed.has(index) ?? false;
      gap.height = removed || (index > 0 && index < last) ? 1 : 0;
      gap.content = removed ? styled([fg(theme.removed)("──")]) : "";
    });
  }

  private lookedAt(): void {
    this.seenFrames = seenDelayFrames;
    this.renderer.requestRender();
  }

  private clearSeenMarks(): void {
    const page = this.page;
    const marks = page ? this.marks.get(page) : undefined;
    if (!page || !marks) return;
    const last = this.blockViews.length - 1;
    for (const index of this.visibleBlocks()) {
      marks.changed.delete(index);
      marks.removed.delete(index);
      if (index === last) marks.removed.delete(index + 1);
    }
    if (marks.changed.size === 0 && marks.removed.size === 0) this.marks.delete(page);
    this.renderMarks();
  }

  private blockFrame(view: Renderable, index: number): BlockFrame {
    const frame = new BoxRenderable(this.renderer, {
      flexDirection: "row",
      flexShrink: 0,
      border: ["left"],
      customBorderChars: noBarChars,
      borderColor: theme.changed,
      onMouseDown: (event) => {
        if (event.button === MouseButton.LEFT && this.commenting && !this.picker && !this.editing && this.page) void this.comment(index);
      },
    });
    const gutter = new TextRenderable(this.renderer, { content: "", width: 0, flexShrink: 0, wrapMode: "none" });
    frame.add(gutter);
    frame.add(view);
    return { frame, gutter };
  }

  private lazyFiles(): () => string[] {
    let files: string[] | undefined;
    return () => (files ??= listFiles(this.options.root));
  }

  private blockView(block: Block, page: string | undefined, files: () => string[]): Renderable {
    if (block.kind === "markdown") {
      return new MarkdownRenderable(this.renderer, { content: block.text, syntaxStyle: this.style, flexGrow: 1, flexShrink: 1, tableOptions: { widthMode: "content", cellPaddingX: 1 } });
    }
    const box = new BoxRenderable(this.renderer, { flexDirection: "column", flexGrow: 1, flexShrink: 1 });
    const images = this.options.images();
    if (block.kind === "mermaid") return this.diagramView(box, block.source, page, images);
    const path = page ? resolveAsset(this.options.root, page, block.target, files) : undefined;
    const caption = block.alt || block.target;
    if (path && images.enabled) {
      this.addImage(box, path, images, caption);
      return box;
    }
    const label: Part[] = [fg(theme.muted)("[image] "), caption, ...(path ? [] : [fg(theme.warning)(" (not found)")])];
    box.add(new TextRenderable(this.renderer, { content: styled(label) }));
    return box;
  }

  private diagramView(box: BoxRenderable, source: string, page: string | undefined, images: ImageOutput): BoxRenderable {
    const diagram = images.enabled && this.options.mermaid ? this.options.mermaid.diagram(source, () => this.diagramDrawn(page)) : undefined;
    if (diagram && "png" in diagram) {
      this.addImage(box, diagram.png, images, undefined);
      return box;
    }
    box.add(new MarkdownRenderable(this.renderer, { content: `\`\`\`mermaid\n${source}\n\`\`\``, syntaxStyle: this.style }));
    if (diagram && "pending" in diagram) box.add(new TextRenderable(this.renderer, { content: "Drawing the diagram…", fg: theme.muted }));
    if (diagram && "error" in diagram) box.add(new TextRenderable(this.renderer, { content: diagram.error, fg: theme.warning }));
    return box;
  }

  private diagramDrawn(page: string | undefined): void {
    if (page === undefined || page !== this.shown || this.editing) return;
    this.reload();
  }

  private addImage(box: BoxRenderable, path: string, images: ImageOutput, caption: string | undefined): void {
    const shown = this.upload(path, images);
    if ("error" in shown) {
      box.add(new TextRenderable(this.renderer, { content: shown.error, fg: theme.error }));
      return;
    }
    box.add(new TextRenderable(this.renderer, { content: placeholderLines(shown).join("\n"), fg: imageIdColor(shown.id), wrapMode: "none", height: shown.rows, flexShrink: 0 }));
    if (caption) box.add(new TextRenderable(this.renderer, { content: caption, fg: theme.muted }));
  }

  private upload(path: string, images: ImageOutput): Upload | { error: string } {
    const maxCols = Math.max(this.renderer.width - imageMargin.cols, 1);
    const maxRows = Math.max(this.renderer.height - imageMargin.rows, 1);
    let modified;
    try {
      modified = statSync(path).mtimeMs;
    } catch (error) {
      return { error: `Could not show ${path}: ${(error as Error).message}` };
    }
    const key = `${modified}:${maxCols}x${maxRows}`;
    const cached = this.uploaded.get(path);
    if (cached?.key === key) return cached;
    if (cached) images.write([deleteCommand(cached.id)]);
    const sent = sendImage(path, maxCols, maxRows, images);
    if ("error" in sent) return sent;
    const shown = { key, id: sent.id, ...sent.box };
    this.uploaded.set(path, shown);
    return shown;
  }

  private async onFrame(): Promise<void> {
    if (this.pendingScroll) {
      const target = "top" in this.pendingScroll ? this.pendingScroll.top : this.lineTop(this.pendingScroll.line);
      this.scroll.scrollTo(target);
      this.settleFrames--;
      if (this.settleFrames <= 0) this.pendingScroll = undefined;
      this.renderer.requestRender();
    } else if (this.seenFrames > 0) {
      this.seenFrames--;
      if (this.seenFrames === 0) this.clearSeenMarks();
      this.renderer.requestRender();
    }
    this.settleHints();
    if (this.message && Date.now() > this.message.until) {
      this.message = undefined;
      this.renderStatus();
    }
  }

  private lineTop(line: number): number {
    const index = blockAtLine(this.document.blocks, line);
    const view = this.blockViews[index];
    const block = this.document.blocks[index];
    if (!view || !block) return 0;
    const into = Math.min(Math.max(line - block.startLine, 0), Math.max(view.height - 1, 0));
    const top = view.y - this.scroll.content.y + into;
    return top === 0 ? 0 : Math.max(top - (this.following ? followContext : 0), 0);
  }

  private topLine(): number {
    const top = this.scroll.scrollTop;
    const offsets = this.blockViews.map((view) => view.y - this.scroll.content.y);
    const index = Math.max(offsets.findLastIndex((offset) => offset <= top), 0);
    const block = this.document.blocks[index];
    if (!block) return 0;
    const into = top - (offsets[index] ?? 0);
    const next = this.document.blocks[index + 1];
    if (into > 0 && next && (offsets[index + 1] ?? Infinity) < top + this.scroll.height) return next.startLine;
    return Math.min(block.startLine + into, block.endLine);
  }

  private stopFollowing(): void {
    if (!this.following) return;
    this.following = false;
    this.renderStatus();
  }

  private readonly onKey = (key: KeyEvent): void => {
    if (this.editing) return;
    if (this.picker) {
      const outcome = pickerKey(this.picker.state, key);
      if (outcome.done) {
        this.picker = undefined;
        this.pickerView.render(undefined);
        outcome.value?.();
      } else {
        this.pickerView.render(this.picker.state);
      }
      this.renderer.requestRender();
      return;
    }
    if (this.commenting) {
      this.commentKey(key);
      this.renderer.requestRender();
      return;
    }
    const half = Math.max(Math.floor(this.scroll.height / 2), 1);
    const scrollBy = (delta: number) => {
      this.scroll.scrollBy(delta);
      this.stopFollowing();
      this.lookedAt();
    };
    if (key.name === "q" || (key.ctrl && key.name === "c")) this.close();
    else if (key.name === "j" || key.name === "down") scrollBy(1);
    else if (key.name === "k" || key.name === "up") scrollBy(-1);
    else if (key.name === "d" || (key.ctrl && key.name === "d")) scrollBy(half);
    else if (key.name === "u" || (key.ctrl && key.name === "u")) scrollBy(-half);
    else if (key.name === "space" || key.name === "pagedown") scrollBy(this.scroll.height - 1);
    else if (key.name === "pageup") scrollBy(1 - this.scroll.height);
    else if (key.name === "home" || (key.name === "g" && !key.shift)) scrollBy(-this.scroll.scrollTop);
    else if (key.name === "end" || (key.name === "g" && key.shift)) scrollBy(this.scroll.scrollHeight);
    else if (key.name === "h" && key.shift) this.travel(() => this.history.back());
    else if (key.name === "l" && key.shift) this.travel(() => this.history.forward());
    else if (key.name === "f") this.openPicker("Links", this.linkItems());
    else if (key.name === "p") this.openPicker("Pages", this.pageItems());
    else if (key.name === "o") this.openPicker("Outline", this.outlineItems());
    else if (key.name === "i") this.navigate(existsSync(join(this.options.root, indexPage)) ? indexPage : undefined);
    else if (key.name === "w") this.toggleFollow();
    else if (key.name === "e") void this.edit();
    else if (key.name === "r") this.reload();
    else if (key.name === "c") this.startCommenting();
    else return;
    this.renderer.requestRender();
  };

  private navigate(page: string | undefined, anchor?: string): void {
    this.stopFollowing();
    this.visit(page, anchor);
  }

  private travel(move: () => { page: string; scroll: number } | undefined): void {
    this.saveScroll();
    const entry = move();
    if (!entry) return;
    this.stopFollowing();
    this.load(entry.page);
    this.scrollTo({ top: entry.scroll });
  }

  private toggleFollow(): void {
    this.following = !this.following;
    if (this.following && this.lastChange && this.lastChange !== this.page) {
      this.saveScroll();
      this.history.visit(this.lastChange, true);
      this.load(this.lastChange);
      this.scrollTo({ top: 0 });
    }
    this.renderStatus();
  }

  private openPicker(title: string, items: PickerItem<() => void>[]): void {
    this.picker = { state: new PickerState(title, items) };
    this.pickerView.render(this.picker.state);
  }

  private linkItems(): PickerItem<() => void>[] {
    const files = this.lazyFiles();
    return this.document.links.map((link) => {
      const target = resolveTarget(this.options.root, this.page, link.target, files);
      return {
        label: link.label,
        detail: target ? link.target : `${link.target} (not a page)`,
        value: () => {
          if (target) this.navigate(target.page, target.anchor);
          else this.flash(`${link.target} isn't a notebook page`);
        },
      };
    });
  }

  private pageItems(): PickerItem<() => void>[] {
    return listPages(this.options.root).map((page) => ({
      label: page.path,
      detail: ago(page.modified),
      mark: this.changed.has(page.path),
      value: () => this.navigate(page.path),
    }));
  }

  private outlineItems(): PickerItem<() => void>[] {
    return this.document.headings.map((heading) => ({
      label: heading.text,
      indent: heading.level - 1,
      value: () => {
        this.stopFollowing();
        this.scrollTo({ line: heading.line });
      },
    }));
  }

  private async edit(): Promise<void> {
    const page = this.page;
    if (!page) return;
    const line = this.topLine();
    this.editing = true;
    this.stopFollowing();
    try {
      await this.options.edit(join(this.options.root, page), line + 1);
    } catch (error) {
      this.flash(`Could not edit: ${(error as Error).message}`);
    } finally {
      this.editing = false;
    }
    this.changed.delete(page);
    const before = this.known.get(page);
    const after = this.remember(page);
    if (before !== undefined && after !== undefined) this.markChanges(page, before, after, false);
    this.reload();
    const deferred = [...this.deferred];
    this.deferred.clear();
    for (const path of deferred) this.fileChanged(path);
    const show = this.pendingShow;
    this.pendingShow = undefined;
    if (show) this.show(show.target, show.notebook);
    this.renderer.requestRender();
  }

  private startCommenting(): void {
    if (!this.page || this.blockViews.length === 0) return;
    this.stopFollowing();
    this.commenting = { selected: this.visibleBlocks()[0] ?? 0, hints: new Map(), top: undefined, settleFrames: 3 };
    this.renderHints();
  }

  private settleHints(): void {
    const commenting = this.commenting;
    if (!commenting) return;
    if (commenting.settleFrames > 0) {
      commenting.settleFrames--;
      this.renderer.requestRender();
      if (commenting.settleFrames > 0) return;
    } else if (commenting.top === this.scroll.scrollTop) {
      return;
    }
    this.assignHints();
  }

  private assignHints(): void {
    const commenting = this.commenting!;
    const visible = this.visibleBlocks();
    if (!visible.includes(commenting.selected)) commenting.selected = visible[0] ?? Math.max(commenting.selected, 0);
    commenting.hints = new Map(visible.slice(0, hintLetters.length).map((index, at) => [hintLetters[at]!, index]));
    commenting.top = this.scroll.scrollTop;
    this.renderHints();
    this.renderer.requestRender();
  }

  private commentKey(key: KeyEvent): void {
    const commenting = this.commenting!;
    const last = this.blockViews.length - 1;
    if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) this.stopCommenting();
    else if (key.name === "j" || key.name === "down") this.selectBlock(Math.min(commenting.selected + 1, last));
    else if (key.name === "k" || key.name === "up") this.selectBlock(Math.max(commenting.selected - 1, 0));
    else if (key.name === "return") void this.comment(commenting.selected);
    else if (key.name && !key.ctrl && commenting.hints.has(key.name)) void this.comment(commenting.hints.get(key.name)!);
  }

  private selectBlock(index: number): void {
    this.commenting!.selected = index;
    const top = this.blockTop(index);
    const bottom = top + (this.blockViews[index]?.height ?? 1);
    if (top < this.scroll.scrollTop) this.scroll.scrollTo(top);
    else if (bottom > this.scroll.scrollTop + this.scroll.height) this.scroll.scrollTo(Math.max(bottom - this.scroll.height, top - this.scroll.height + 1, 0));
    this.lookedAt();
    this.assignHints();
  }

  private stopCommenting(): void {
    this.commenting = undefined;
    this.renderHints();
  }

  private renderHints(): void {
    const commenting = this.commenting;
    const letters = new Map([...(commenting?.hints ?? [])].map(([letter, index]) => [index, letter]));
    this.gutters.forEach((gutter, index) => {
      const selected = commenting?.selected === index;
      gutter.width = commenting ? 2 : 0;
      gutter.content = commenting ? styled([selected ? bold(fg(theme.selected)(letters.get(index) ?? "▌")) : fg(theme.accent)(letters.get(index) ?? " ")]) : "";
      this.blockViews[index]!.backgroundColor = selected ? theme.surface : "transparent";
    });
    this.renderStatus();
  }

  private visibleBlocks(): number[] {
    const top = this.scroll.scrollTop;
    const bottom = top + this.scroll.height;
    return this.blockViews.flatMap((view, index) => {
      const start = this.blockTop(index);
      return start < bottom && start + view.height > top ? [index] : [];
    });
  }

  private blockTop(index: number): number {
    return (this.blockViews[index]?.y ?? 0) - this.scroll.content.y;
  }

  private async comment(index: number): Promise<void> {
    const page = this.page;
    const block = this.document.blocks[index];
    this.stopCommenting();
    if (!page || !block) return;
    const send = this.options.comment;
    if (!send) return;
    const asset = block.kind === "image" ? resolveAsset(this.options.root, page, block.target, this.lazyFiles()) : undefined;
    const source = this.known.get(page) ?? "";
    const comment = commentContext({ page, file: join(this.options.root, page), source, block, headings: this.document.headings, ...(asset ? { asset } : {}) });
    this.flash(await send(comment).catch((error: Error) => `Could not comment: ${error.message}`));
    this.renderer.requestRender();
  }

  private flash(text: string): void {
    this.message = { text, until: Date.now() + 4000 };
    this.renderStatus();
  }

  private renderStatus(): void {
    const page = this.page ?? "notebook";
    const follow = this.following ? fg(theme.follow)(" ◉ following") : fg(theme.muted)(" ○ not following");
    const help = this.commenting ? "comment on: a letter, or j/k and Enter · click · Esc cancel" : "c comment · f links · p pages · o outline · e edit · H/L back/fwd · w follow · q quit";
    const right = this.message ? fg(theme.warning)(this.message.text) : fg(this.commenting ? theme.selected : theme.muted)(help);
    this.status.content = styled([bold(fg(theme.accent)(` ${page}`)), follow, "   ", right]);
  }
}

function deleteCommand(id: number): string {
  return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
}

function ago(modified: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - modified) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
