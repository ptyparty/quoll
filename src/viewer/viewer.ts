import { BorderChars, BoxRenderable, MarkdownRenderable, MouseButton, ScrollBoxRenderable, TextRenderable, bold, fg, type CliRenderer, type KeyEvent, type Renderable, type SyntaxStyle } from "@opentui/core";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { blockAtLine, diffBlocks, firstChangedLine, frontmatterTags, hasTag, headingKey, parseDocument, resolveConflict, type Block, type Document, type Resolution } from "../document.ts";
import { imageIdColor, placeholderLines, type ImageOutput } from "../render/image.ts";
import { markdownStyle, sendImage } from "../render/markdown.ts";
import type { MermaidRenderer } from "../render/mermaid.ts";
import { styled, type Part } from "../render/styled.ts";
import { theme } from "../render/theme.ts";
import { contains, indexPage, listFiles, listPages, overlaps, pagesByTag, readPage, resolveAsset, resolveTarget } from "../notebook.ts";
import { commentContext } from "../comment.ts";
import type { ContextRequest } from "../context.ts";
import type { GitStatus, NotebookGit } from "../git.ts";
import type { Reply } from "../socket.ts";
import { History } from "./history.ts";
import { PickerState, PickerView, pickerKey, type PickerItem } from "./picker.ts";
import { MindMapView, type Where } from "./mindmap.ts";
import { NotebookMapState, buildNotebookTree, notebookMapKey } from "./notebook-map.ts";

export type ViewerOptions = {
  root: string;
  images: () => ImageOutput;
  edit: (file: string, line: number) => Promise<void>;
  follow: boolean;
  mermaid?: MermaidRenderer;
  git?: NotebookGit;
};

type Picker = { state: PickerState<() => void> };
type Section = { first: number; last: number };
type ScrollTarget = { line: number } | { top: number } | { centre: Section };
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
const dimmedOpacity = 0.45;
const gitPollMs = 30_000;
const gitSettleMs = 2_000;

export class Viewer {
  private readonly scroll: ScrollBoxRenderable;
  private readonly status: TextRenderable;
  private readonly pickerView: PickerView;
  private readonly mindMapView: MindMapView;
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
  private asking: ContextRequest | undefined;
  private picker: Picker | undefined;
  private mindMap: NotebookMapState | undefined;
  private mapFocused = true;
  private refocusMap = false;
  private mapReturn: { page: string | undefined; top: number } | undefined;
  private section: Section | undefined;
  private endPad: TextRenderable | undefined;
  private following: boolean;
  private pendingScroll: ScrollTarget | undefined;
  private settleFrames = 0;
  private seenFrames = 0;
  private shown: string | undefined;
  private lastChange: string | undefined;
  private pendingShow: { target: string; notebook: string } | undefined;
  private message: { text: string; until: number } | undefined;
  private editing = false;
  private closed: () => void = () => {};
  private gitStatus: GitStatus | undefined;
  private conflictAt: number | undefined;
  private gitTicket = 0;
  private pushing = false;
  private gitTimer: ReturnType<typeof setInterval> | undefined;
  private gitSoon: ReturnType<typeof setTimeout> | undefined;

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
    this.mindMapView = new MindMapView(renderer, frame);
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
    if (this.options.git) {
      void this.refreshGit();
      this.gitTimer = setInterval(() => void this.refreshGit(), gitPollMs);
      this.gitTimer.unref?.();
    }
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
    if (this.mindMap) this.closeMindMap();
    const page = relative(root, file);
    this.stopFollowing();
    const found = this.visit(page, resolved.anchor);
    return found ? { ok: true } : { error: `Showing ${page}, but it has no heading ${resolved.anchor}` };
  }

  async refreshGit(during = false): Promise<void> {
    const git = this.options.git;
    if (!git || (this.pushing && !during)) return;
    const ticket = ++this.gitTicket;
    let status: GitStatus | undefined;
    try {
      status = await git.status();
    } catch {
      return;
    }
    if (ticket !== this.gitTicket || JSON.stringify(status) === JSON.stringify(this.gitStatus)) return;
    const started = status?.merging && !this.gitStatus?.merging && this.gitStatus !== undefined;
    this.gitStatus = status;
    if (started && !this.pushing) this.showConflicts(status!.conflicts);
    this.renderStatus();
    this.renderer.requestRender();
  }

  private async sync(): Promise<void> {
    const git = this.options.git;
    if (!git || this.pushing) return;
    this.pushing = true;
    this.flash(this.gitStatus?.merging ? "Finishing the merge…" : "Syncing the notebook…");
    this.renderer.requestRender();
    try {
      const result = await git.sync();
      await this.refreshGit(true);
      if ("error" in result) this.flash(`Sync failed: ${result.error}`);
      else if ("conflicts" in result) this.showConflicts(result.conflicts);
      else this.flash(result.pushed === 0 ? "Nothing to push" : `Pushed ${commits(result.pushed)}`);
    } catch (error) {
      this.flash(`Sync failed: ${(error as Error).message}`);
    } finally {
      this.pushing = false;
    }
    if (this.page) this.reload();
    this.renderer.requestRender();
  }

  private showConflicts(pages: string[]): void {
    const elsewhere = this.gitStatus?.elsewhere ?? [];
    this.flash(`Merge conflicts in ${count(pages.length + elsewhere.length, "file")} · n next conflict · 1 yours · 2 theirs · b both · e edit · P finish · X abort`);
    const here = pages.map((page): PickerItem<() => void> => ({ label: page, detail: "in this notebook", value: () => this.navigate(page) }));
    const outside = elsewhere.map((file): PickerItem<() => void> => ({ label: file, detail: "outside this notebook · Enter opens it in your editor", mark: true, value: () => void this.editElsewhere(file) }));
    if (here.length + outside.length === 0) return;
    const title = outside.length > 0 ? `Merge conflicts · ${count(outside.length, "file")} outside this notebook must be settled too before P can finish` : "Merge conflicts";
    this.openPicker(title, [...here, ...outside]);
  }

  private async editElsewhere(file: string): Promise<void> {
    let line = 1;
    try {
      line = readFileSync(file, "utf8").split("\n").findIndex((text) => text.startsWith("<<<<<<<")) + 1 || 1;
    } catch {}
    this.editing = true;
    try {
      await this.options.edit(file, line);
    } catch (error) {
      this.flash(`Could not edit: ${(error as Error).message}`);
    } finally {
      this.editing = false;
    }
    this.applyDeferred();
    await this.refreshGit();
    this.renderer.requestRender();
  }

  private async abortMerge(): Promise<void> {
    const git = this.options.git;
    if (!git || !this.gitStatus?.merging) return;
    const error = await git.abort();
    this.flash(error ? `Abort failed: ${error}` : "Merge aborted");
    await this.refreshGit();
    if (this.page) this.reload();
    this.renderer.requestRender();
  }

  private conflicts(): number[] {
    return this.document.blocks.flatMap((block, index) => (block.kind === "conflict" ? [index] : []));
  }

  private nextConflict(delta: number): void {
    const all = this.conflicts();
    if (all.length === 0) return this.flash("No conflicts on this page");
    const at = this.conflictAt === undefined ? -1 : all.indexOf(this.conflictAt);
    const next = all[(at + delta + all.length) % all.length]!;
    this.selectConflict(next);
  }

  private selectConflict(index: number | undefined): void {
    const previous = this.conflictAt === undefined ? undefined : this.blockViews[this.conflictAt];
    if (previous) previous.backgroundColor = "transparent";
    this.conflictAt = index;
    const view = index === undefined ? undefined : this.blockViews[index];
    if (!view || index === undefined) return;
    view.backgroundColor = theme.surface;
    this.stopFollowing();
    this.scrollTo({ line: this.document.blocks[index]!.startLine });
  }

  private settleConflict(resolution: Resolution): void {
    const page = this.page;
    const visible = this.visibleBlocks();
    const index = this.conflictAt ?? this.conflicts().find((candidate) => visible.includes(candidate));
    const block = index === undefined ? undefined : this.document.blocks[index];
    if (!page || index === undefined || !block || block.kind !== "conflict") return this.flash("No conflict selected · n finds one");
    const file = join(this.options.root, page);
    const fresh = readFileSync(file, "utf8");
    const ordinal = this.conflicts().indexOf(index);
    const current = parseDocument(fresh).blocks.filter((candidate) => candidate.kind === "conflict")[ordinal];
    if (!current || current.kind !== "conflict" || current.ours !== block.ours || current.theirs !== block.theirs) {
      this.reload();
      return this.flash("The page changed on disk · check the conflict and press again");
    }
    writeFileSync(file, resolveConflict(fresh, current, resolution));
    this.reload();
    const left = this.conflicts();
    const next = left.find((candidate) => candidate >= index) ?? left[0];
    if (next !== undefined) this.selectConflict(next);
    else {
      this.conflictAt = undefined;
      this.flash("No conflicts left on this page · P finishes the merge once every page is settled");
    }
    void this.refreshGit();
  }

  fileChanged(path: string): void {
    if (this.options.git) {
      clearTimeout(this.gitSoon);
      this.gitSoon = setTimeout(() => void this.refreshGit(), gitSettleMs);
    }
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
    clearInterval(this.gitTimer);
    clearTimeout(this.gitSoon);
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

  private scrollTo(target: ScrollTarget): void {
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
    this.asking?.cancel();
    this.asking = undefined;
    const frames = this.document.blocks.map((block, index) => this.blockFrame(this.blockView(block, page, files), index));
    this.blockViews = frames.map(({ frame }) => frame);
    this.gutters = frames.map(({ gutter }) => gutter);
    this.gaps = Array.from({ length: frames.length + 1 }, () => new TextRenderable(this.renderer, { content: "", height: 0, flexShrink: 0, wrapMode: "none" }));
    this.endPad = new TextRenderable(this.renderer, { content: "", height: 0, flexShrink: 0 });
    this.pageViews = [...this.gaps.flatMap((gap, index) => [gap, ...this.blockViews.slice(index, index + 1)]), this.endPad];
    for (const view of this.pageViews) this.scroll.add(view);
    this.renderMarks();
    this.section = undefined;
    this.conflictAt = undefined;
    if (this.mindMap) this.highlightMapLine();
  }

  private renderMarks(): void {
    const marks = this.page ? this.marks.get(this.page) : undefined;
    const last = this.blockViews.length;
    this.blockViews.forEach((view, index) => {
      view.customBorderChars = marks?.changed.has(index) ? barChars : noBarChars;
    });
    this.gaps.forEach((gap, index) => {
      const removed = marks?.removed.has(index) ?? false;
      const before = this.document.blocks[index - 1];
      const after = this.document.blocks[index];
      const sameList = before?.kind === "markdown" && after?.kind === "markdown" && before.list !== undefined && before.list === after.list;
      gap.height = removed || (index > 0 && index < last && !sameList) ? 1 : 0;
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
        if (event.button === MouseButton.LEFT && this.commenting && !this.picker && !this.editing && this.page) this.comment(index);
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
    if (block.kind === "conflict") return this.conflictView(block);
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

  private conflictView(block: Extract<Block, { kind: "conflict" }>): BoxRenderable {
    const box = new BoxRenderable(this.renderer, { flexDirection: "column", flexGrow: 1, flexShrink: 1, border: true, borderStyle: "rounded", borderColor: theme.warning, title: " merge conflict · 1 yours · 2 theirs · b both ", titleColor: theme.warning });
    const side = (label: string, text: string, color: string) => {
      box.add(new TextRenderable(this.renderer, { content: styled([bold(fg(color)(label))]), wrapMode: "none" }));
      box.add(text.trim() === "" ? new TextRenderable(this.renderer, { content: "(nothing)", fg: theme.muted }) : new MarkdownRenderable(this.renderer, { content: text, syntaxStyle: this.style, flexShrink: 1 }));
    };
    side(`yours · ${block.oursLabel || "HEAD"}`, block.ours, theme.accent);
    box.add(new TextRenderable(this.renderer, { content: "", height: 1 }));
    side(`theirs · ${block.theirsLabel || "incoming"}`, block.theirs, theme.follow);
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
      const pending = this.pendingScroll;
      const target = "top" in pending ? pending.top : "line" in pending ? this.lineTop(pending.line) : this.centreTop(pending.centre);
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
    if (this.mindMapView.step()) this.renderer.requestRender();
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
    if (this.mindMap) {
      if (key.name === "tab") this.focusMap(!this.mapFocused);
      else if (this.mapFocused || key.name === "escape" || key.name === "a" || key.name === "q" || (key.ctrl && key.name === "c")) this.mindMapKey(key);
      else this.scrollKey(key);
      this.renderStatus();
      this.renderer.requestRender();
      return;
    }
    if (key.name === "q" || (key.ctrl && key.name === "c")) this.close();
    else if (this.scrollKey(key)) return this.renderer.requestRender();
    else if (key.name === "h" && key.shift) this.travel(() => this.history.back());
    else if (key.name === "l" && key.shift) this.travel(() => this.history.forward());
    else if (key.name === "f") this.openPicker("Links", this.linkItems());
    else if (key.name === "p" && key.shift) void this.sync();
    else if (key.name === "x" && key.shift) void this.abortMerge();
    else if (key.name === "n") this.nextConflict(key.shift ? -1 : 1);
    else if (key.name === "1" && this.conflicts().length > 0) this.settleConflict("ours");
    else if (key.name === "2" && this.conflicts().length > 0) this.settleConflict("theirs");
    else if (key.name === "b" && this.conflicts().length > 0) this.settleConflict("both");
    else if (key.name === "p") this.openPicker("Pages", this.pageItems());
    else if (key.name === "o") this.openPicker("Outline", this.outlineItems());
    else if (key.name === "t") this.openPicker("Tags", this.tagItems());
    else if (key.name === "i") this.navigate(existsSync(join(this.options.root, indexPage)) ? indexPage : undefined);
    else if (key.name === "a") this.openMindMap();
    else if (key.name === "w") this.toggleFollow();
    else if (key.name === "e") void this.edit();
    else if (key.name === "r") this.reload();
    else return;
    this.renderer.requestRender();
  };

  private scrollKey(key: KeyEvent): boolean {
    const half = Math.max(Math.floor(this.scroll.height / 2), 1);
    const scrollBy = (delta: number) => {
      this.scroll.scrollBy(delta);
      this.stopFollowing();
      this.lookedAt();
    };
    if (key.name === "j" || key.name === "down") scrollBy(1);
    else if (key.name === "k" || key.name === "up") scrollBy(-1);
    else if (key.name === "d" || (key.ctrl && key.name === "d")) scrollBy(half);
    else if (key.name === "u" || (key.ctrl && key.name === "u")) scrollBy(-half);
    else if (key.name === "space" || key.name === "pagedown") scrollBy(this.scroll.height - 1);
    else if (key.name === "pageup") scrollBy(1 - this.scroll.height);
    else if (key.name === "home" || (key.name === "g" && !key.shift)) scrollBy(-this.scroll.scrollTop);
    else if (key.name === "end" || (key.name === "g" && key.shift)) scrollBy(this.scroll.scrollHeight);
    else return false;
    return true;
  }

  private openMindMap(): void {
    this.stopFollowing();
    this.mapReturn = { page: this.page, top: this.scroll.scrollTop };
    this.centreMindMap();
  }

  private centreMindMap(): void {
    const page = this.page;
    const line = this.topLine();
    const files = this.lazyFiles();
    const pages = listPages(this.options.root).map((info) => ({ page: info.path, document: parseDocument(this.sourceOf(info.path) ?? ""), tags: this.tagsOf(info.path) }));
    const tree = buildNotebookTree(pages, (from, target) => resolveTarget(this.options.root, from, target, files), indexPage);
    this.mindMap = new NotebookMapState(tree);
    this.mindMap.viewRows = this.mindMapView.rows();
    this.mapFocused = true;
    this.mindMapView.focus(true);
    this.mindMap.selectPage(page, line);
    this.mindMapView.render(this.mindMap);
    this.highlightMapLine();
    this.renderStatus();
  }

  private closeMindMap(): void {
    this.mindMap = undefined;
    this.mapReturn = undefined;
    this.mindMapView.render(undefined);
    this.showSection(undefined);
    this.renderStatus();
  }

  private mindMapKey(key: KeyEvent): void {
    const outcome = notebookMapKey(this.mindMap!, key);
    if (outcome === "move") {
      this.mindMapView.render(this.mindMap);
      this.followMap();
      this.renderStatus();
    } else if (outcome === "land") {
      this.land();
    } else if (outcome === "exit") {
      const back = this.mapReturn;
      this.closeMindMap();
      if (!back) return;
      if (back.page !== this.page) back.page === undefined ? this.renderOverview() : this.load(back.page);
      this.scrollTo({ top: back.top });
    }
  }

  private land(): void {
    const back = this.mapReturn;
    const current = this.history.current;
    if (back && current && this.page && this.page !== back.page) {
      current.scroll = back.top;
      this.history.visit(this.page);
    }
    this.closeMindMap();
  }

  private followMap(): void {
    const where = this.mindMap?.choice.node.where;
    if (!where) {
      this.showSection(undefined);
      return;
    }
    if (where.page !== this.page) this.load(where.page);
    const section = this.showSection(where);
    this.scrollTo(section ? { centre: section } : { line: this.whereLine(where) ?? 0 });
  }

  private highlightMapLine(): void {
    const where = this.mindMap?.choice.node.where;
    this.showSection(where && where.page === this.page ? where : undefined);
  }

  private whereLine(where: Where): number | undefined {
    if (where.line !== undefined || where.anchor === undefined) return where.line;
    const key = headingKey(where.anchor);
    return this.document.headings.find((heading) => headingKey(heading.text) === key)?.line;
  }

  private sectionAt(where: Where): Section | undefined {
    const line = this.whereLine(where);
    if (line === undefined) return undefined;
    const blocks = this.document.blocks;
    const heading = this.document.headings.find((candidate) => candidate.line === line);
    if (!heading) {
      if (line === 0) return undefined;
      const at = blockAtLine(blocks, line);
      return { first: at, last: at };
    }
    if (heading.level === 1) return undefined;
    const end = this.document.headings.find((candidate) => candidate.line > line && candidate.level <= heading.level)?.line ?? Infinity;
    const inside = blocks.flatMap((block, index) => (block.startLine >= line && block.startLine < end ? [index] : []));
    return inside.length > 0 ? { first: inside[0]!, last: inside.at(-1)! } : undefined;
  }

  private showSection(where: Where | undefined): Section | undefined {
    const section = where ? this.sectionAt(where) : undefined;
    this.section = section;
    this.blockViews.forEach((view, index) => {
      const inside = section !== undefined && index >= section.first && index <= section.last;
      view.backgroundColor = inside ? theme.surface : "transparent";
      view.opacity = section && !inside ? dimmedOpacity : 1;
    });
    this.gaps.forEach((gap, index) => {
      const inside = section !== undefined && index > section.first && index <= section.last;
      gap.bg = inside ? theme.surface : "transparent";
      if (gap.content.chunks.every((chunk) => chunk.text.trim() === "")) gap.content = inside ? " ".repeat(this.blockViews[0]?.width ?? this.renderer.width) : "";
    });
    if (this.endPad) this.endPad.height = this.mindMap ? this.scroll.height : 0;
    return section;
  }

  private centreTop(section: Section): number {
    const top = this.blockTop(section.first);
    const bottom = this.blockTop(section.last) + (this.blockViews[section.last]?.height ?? 0);
    const room = this.scroll.height - (bottom - top);
    return room <= 0 ? top : Math.max(top - Math.floor(room / 2), 0);
  }

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

  private pageItems(tag?: string): PickerItem<() => void>[] {
    return listPages(this.options.root).flatMap((page) => {
      const tags = this.tagsOf(page.path);
      if (tag !== undefined && !hasTag(tags, tag)) return [];
      return [
        {
          label: page.path,
          detail: [ago(page.modified), ...tags.map((name) => `#${name}`)].join("  "),
          mark: this.changed.has(page.path),
          value: () => this.navigate(page.path),
        },
      ];
    });
  }

  private tagItems(): PickerItem<() => void>[] {
    return [...pagesByTag(this.options.root, (page) => this.sourceOf(page))].map(([tag, pages]) => ({
      label: `#${tag}`,
      detail: pages.length === 1 ? "1 page" : `${pages.length} pages`,
      value: () => this.openPicker(`Pages tagged #${tag}`, this.pageItems(tag)),
    }));
  }

  private tagsOf(page: string): string[] {
    return frontmatterTags(this.sourceOf(page) ?? "");
  }

  private sourceOf(page: string): string | undefined {
    return this.known.get(page) ?? readPage(this.options.root, page);
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
    this.applyDeferred();
    this.renderer.requestRender();
  }

  private applyDeferred(): void {
    const deferred = [...this.deferred];
    this.deferred.clear();
    for (const path of deferred) this.fileChanged(path);
    const show = this.pendingShow;
    this.pendingShow = undefined;
    if (show) this.show(show.target, show.notebook);
  }

  askForContext(request: ContextRequest): void {
    this.asking?.cancel();
    if (!this.page || this.blockViews.length === 0) return request.none("No page open in quoll");
    this.asking = request;
    request.onCancel(() => {
      if (this.asking !== request) return;
      this.asking = undefined;
      this.stopCommenting();
      this.renderer.requestRender();
    });
    this.refocusMap = this.mindMap !== undefined && this.mapFocused;
    if (this.mindMap) this.focusMap(false);
    this.startCommenting();
    request.picking("Pick a block in quoll · Esc cancels");
    this.renderer.requestRender();
  }

  private startCommenting(): void {
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
    if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) this.cancelCommenting();
    else if (key.name === "j" || key.name === "down") this.selectBlock(Math.min(commenting.selected + 1, last));
    else if (key.name === "k" || key.name === "up") this.selectBlock(Math.max(commenting.selected - 1, 0));
    else if (key.name === "return") this.comment(commenting.selected);
    else if (key.name && !key.ctrl && commenting.hints.has(key.name)) this.comment(commenting.hints.get(key.name)!);
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

  private cancelCommenting(): void {
    const asking = this.asking;
    this.asking = undefined;
    asking?.cancel();
    this.stopCommenting();
  }

  private stopCommenting(): void {
    this.commenting = undefined;
    if (this.refocusMap && this.mindMap) this.focusMap(true);
    this.refocusMap = false;
    this.renderHints();
    if (this.mindMap) this.highlightMapLine();
  }

  private focusMap(map: boolean): void {
    this.mapFocused = map;
    this.mindMapView.focus(map);
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

  private comment(index: number): void {
    const page = this.page;
    const block = this.document.blocks[index];
    const asking = this.asking;
    this.asking = undefined;
    this.stopCommenting();
    if (!page || !block || !asking) return asking?.cancel();
    const asset = block.kind === "image" ? resolveAsset(this.options.root, page, block.target, this.lazyFiles()) : undefined;
    const source = this.known.get(page) ?? "";
    const comment = commentContext({ page, file: join(this.options.root, page), source, block, headings: this.document.headings, ...(asset ? { asset } : {}) });
    asking.attach([comment]);
    this.flash(`Attached ${comment.label}`);
    this.renderer.requestRender();
  }

  private flash(text: string): void {
    this.message = { text, until: Date.now() + 4000 };
    this.renderStatus();
  }

  private renderStatus(): void {
    const page = this.page ?? "notebook";
    const tags = this.page ? this.tagsOf(this.page).map((tag) => ` #${tag}`).join("") : "";
    const follow = this.following ? fg(theme.follow)(" ◉ following") : fg(theme.muted)(" ○ not following");
    const door = this.mindMap?.door;
    const help = this.commenting ? "attach: a letter, or j/k and Enter · click · Esc cancel" : this.mindMap?.filter !== undefined ? "type to filter · ↑↓ pick · Enter go · Esc cancel" : this.mindMap && !this.mapFocused ? "page: scroll · Tab atlas · a land · Esc exit" : door ? `Enter ⤳ ${door.to} · ⌫ back · Tab page · v view` : this.mindMap ? "hjkl move · ⌫ back · Tab page · v view · a land · Esc exit" : "f links · p pages · t tags · o outline · a atlas · e edit · H/L back/fwd · w follow · q quit";
    const right = this.message ? fg(theme.warning)(this.message.text) : fg(this.commenting || this.mindMap ? theme.selected : theme.muted)(help);
    const git = this.gitStatus;
    const ahead = git?.merging
      ? fg(theme.warning)(` ⚠ merging · ${count(git.conflicts.length, "conflicted page")}${git.elsewhere.length > 0 ? ` · ${git.elsewhere.length} elsewhere` : ""} · P finish · X abort`)
      : git && (git.ahead > 0 || git.behind > 0)
        ? fg(theme.changed)(` ${git.ahead > 0 ? `↑${git.ahead}` : ""}${git.behind > 0 ? `${git.ahead > 0 ? " " : ""}↓${git.behind}` : ""} P sync`)
        : "";
    this.status.content = styled([bold(fg(theme.accent)(` ${page}`)), fg(theme.muted)(tags), ahead, follow, "   ", right]);
  }
}

function deleteCommand(id: number): string {
  return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
}

function commits(total: number): string {
  return count(total, "commit");
}

function count(total: number, noun: string): string {
  return total === 1 ? `1 ${noun}` : `${total} ${noun}s`;
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
