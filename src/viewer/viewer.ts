import { BoxRenderable, MarkdownRenderable, ScrollBoxRenderable, TextRenderable, bold, fg, type CliRenderer, type KeyEvent, type Renderable, type SyntaxStyle } from "@opentui/core";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { blockAtLine, firstChangedLine, headingKey, parseDocument, type Block, type Document } from "../document.ts";
import { imageIdColor, placeholderLines, type ImageOutput } from "../render/image.ts";
import { markdownStyle, sendImage } from "../render/markdown.ts";
import { styled, type Part } from "../render/styled.ts";
import { theme } from "../render/theme.ts";
import { contains, indexPage, listFiles, listPages, overlaps, resolveAsset, resolveTarget } from "../notebook.ts";
import type { Reply } from "../socket.ts";
import { History } from "./history.ts";
import { PickerState, PickerView, pickerKey, type PickerItem } from "./picker.ts";

export type ViewerOptions = {
  root: string;
  images: () => ImageOutput;
  edit: (file: string, line: number) => Promise<void>;
  follow: boolean;
};

type Picker = { state: PickerState<() => void> };
type Upload = { key: string; id: number; cols: number; rows: number };

const imageMargin = { cols: 4, rows: 4 };
const imageFile = /\.(png|jpe?g|gif|webp)$/i;
const followContext = 2;

export class Viewer {
  private readonly scroll: ScrollBoxRenderable;
  private readonly status: TextRenderable;
  private readonly pickerView: PickerView;
  private readonly style: SyntaxStyle;
  private readonly history = new History();
  private readonly known = new Map<string, string>();
  private readonly changed = new Set<string>();
  private readonly uploaded = new Map<string, Upload>();
  private readonly deferred = new Set<string>();
  private document: Document = { blocks: [], headings: [], links: [] };
  private blockViews: Renderable[] = [];
  private picker: Picker | undefined;
  private following: boolean;
  private pendingScroll: { line: number } | { top: number } | undefined;
  private settleFrames = 0;
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
      paddingLeft: 1,
      paddingRight: 1,
      contentOptions: { flexDirection: "column" },
      onMouseScroll: () => this.stopFollowing(),
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
    const before = this.known.get(path) ?? "";
    const after = this.remember(path);
    if (after === undefined) {
      if (path === this.page) this.reload();
      return;
    }
    const line = firstChangedLine(before, after);
    if (line === undefined) return;
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
    for (const view of this.blockViews) {
      this.scroll.remove(view);
      view.destroyRecursively();
    }
    const files = this.lazyFiles();
    this.blockViews = this.document.blocks.map((block, index) => this.blockView(block, page, index, files));
    for (const view of this.blockViews) this.scroll.add(view);
  }

  private lazyFiles(): () => string[] {
    let files: string[] | undefined;
    return () => (files ??= listFiles(this.options.root));
  }

  private blockView(block: Block, page: string | undefined, index: number, files: () => string[]): Renderable {
    const marginTop = index === 0 ? 0 : 1;
    if (block.kind === "markdown") {
      return new MarkdownRenderable(this.renderer, { content: block.text, syntaxStyle: this.style, marginTop, tableOptions: { widthMode: "content", cellPaddingX: 1 } });
    }
    const box = new BoxRenderable(this.renderer, { flexDirection: "column", marginTop, flexShrink: 0 });
    const path = page ? resolveAsset(this.options.root, page, block.target, files) : undefined;
    const images = this.options.images();
    const caption = block.alt || block.target;
    if (path && images.enabled) {
      const shown = this.upload(path, images);
      if ("error" in shown) {
        box.add(new TextRenderable(this.renderer, { content: shown.error, fg: theme.error }));
      } else {
        box.add(new TextRenderable(this.renderer, { content: placeholderLines(shown).join("\n"), fg: imageIdColor(shown.id), wrapMode: "none", height: shown.rows, flexShrink: 0 }));
        box.add(new TextRenderable(this.renderer, { content: caption, fg: theme.muted }));
      }
      return box;
    }
    const label: Part[] = [fg(theme.muted)("[image] "), caption, ...(path ? [] : [fg(theme.warning)(" (not found)")])];
    box.add(new TextRenderable(this.renderer, { content: styled(label) }));
    return box;
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
    }
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
    const half = Math.max(Math.floor(this.scroll.height / 2), 1);
    const scrollBy = (delta: number) => {
      this.scroll.scrollBy(delta);
      this.stopFollowing();
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
    this.remember(page);
    this.reload();
    const deferred = [...this.deferred];
    this.deferred.clear();
    for (const path of deferred) this.fileChanged(path);
    const show = this.pendingShow;
    this.pendingShow = undefined;
    if (show) this.show(show.target, show.notebook);
    this.renderer.requestRender();
  }

  private flash(text: string): void {
    this.message = { text, until: Date.now() + 4000 };
    this.renderStatus();
  }

  private renderStatus(): void {
    const page = this.page ?? "notebook";
    const follow = this.following ? fg(theme.follow)(" ◉ following") : fg(theme.muted)(" ○ not following");
    const right = this.message ? fg(theme.warning)(this.message.text) : fg(theme.muted)("f links · p pages · o outline · e edit · H/L back/fwd · w follow · q quit");
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
