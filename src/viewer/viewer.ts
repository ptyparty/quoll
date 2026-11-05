import { BorderChars, BoxRenderable, CodeRenderable, MarkdownRenderable, MouseButton, ScrollBoxRenderable, TextRenderable, TextTableRenderable, bg, bold, fg, type TextChunk, type TextTableContent, type CliRenderer, type KeyEvent, type Renderable, type SyntaxStyle } from "@opentui/core";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { blockAtLine, diffBlocks, firstChangedLine, frontmatterTags, hasTag, headingKey, parseDocument, resolveConflict, type Block, type Document, type Resolution } from "../document.ts";
import { imageIdColor, placeholderLines, type ImageOutput } from "../render/image.ts";
import { markdownNode, markdownStyle, sendImage, tableOptions } from "../render/markdown.ts";
import type { MermaidRenderer } from "../render/mermaid.ts";
import { fitHints, hintParts, partsWidth, pill, styled, type Hint, type Part } from "../render/styled.ts";
import { theme } from "../render/theme.ts";
import { contains, indexPage, listFiles, listPages, overlaps, pagesByTag, readPage, resolveAsset, resolveTarget } from "../notebook.ts";
import { isCopyableImage, type Clip, type CopyToClipboard } from "../clipboard.ts";
import { commentContext } from "../comment.ts";
import type { ContextRequest } from "../context.ts";
import type { GitStatus, NotebookGit } from "../git.ts";
import type { Reply } from "../socket.ts";
import { History } from "./history.ts";
import { PickerState, PickerView, pickerBindings, pickerKey, type PickerItem, type PickerOutcome } from "./picker.ts";
import { MindMapView, type MapNode, type Where } from "./mindmap.ts";
import { NotebookMapState, atlasBindings, atlasFilterBindings, buildNotebookTree, notebookMapKey, type NotebookMapOutcome } from "./notebook-map.ts";
import { HelpView, MenuView } from "./key-cards.ts";
import { active, bindingFor, keyGroups, typedText, type AppKeys, type Binding } from "./keys.ts";
import { findMatches, markMatches } from "./search.ts";

export type ViewerOptions = {
  root: string;
  images: () => ImageOutput;
  edit: (file: string, line: number) => Promise<void>;
  follow: boolean;
  mermaid?: MermaidRenderer;
  git?: NotebookGit;
  clipboard?: CopyToClipboard;
};

type Picker = { state: PickerState<() => void> };
type SearchMatch = { target: Searchable; ordinal: number; at: number };
type Searchable = CodeRenderable | TextTableRenderable;
type Search = { query: string; typing: boolean; current: number; matches: SearchMatch[]; seen: Seen[]; from: number };
type Seen = { target: Searchable; source: unknown; live: unknown; highlighting: boolean };
type ChunkHook = CodeRenderable["onChunks"];
type Section = { first: number; last: number };
type ScrollTarget = { line: number } | { top: number } | { centre: Section };
type BlockFrame = { frame: BoxRenderable; gutter: TextRenderable };
type PageMarks = { changed: Set<number>; removed: Set<number> };
type BlockPick = { verb: string; mode: string; choose: (index: number) => void; selected: number; hints: Map<string, number>; top: number | undefined; settleFrames: number };
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
  private readonly menuView: MenuView;
  private readonly helpView: HelpView;
  private readonly mindMapView: MindMapView;
  private readonly style: SyntaxStyle;
  private readonly markingStyle: SyntaxStyle;
  private readonly renderNode: ReturnType<typeof markdownNode>;
  private readonly history = new History();
  private readonly known = new Map<string, string>();
  private readonly changed = new Set<string>();
  private readonly marks = new Map<string, PageMarks>();
  private readonly uploaded = new Map<string, Upload>();
  private readonly deferred = new Set<string>();
  private document: Document = { blocks: [], headings: [], links: [] };
  private pageViews: Renderable[] = [];
  private blockViews: BoxRenderable[] = [];
  private markdownViews: (MarkdownRenderable | undefined)[] = [];
  private marked: { view: MarkdownRenderable; text: string; at: string } | undefined;
  private gaps: TextRenderable[] = [];
  private gutters: TextRenderable[] = [];
  private blockPick: BlockPick | undefined;
  private asking: ContextRequest | undefined;
  private picker: Picker | undefined;
  private mindMap: NotebookMapState | undefined;
  private mapFocused = true;
  private mapNode: MapNode | undefined;
  private menu: Binding<() => void>[] | undefined;
  private search: Search | undefined;
  private readonly codeMarks = new WeakMap<CodeRenderable, { key: string; applied: ChunkHook; original: ChunkHook }>();
  private readonly tableMarks = new WeakMap<TextTableRenderable, { key: string; applied: TextTableContent; original: TextTableContent }>();
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
  private title: string | undefined;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: ViewerOptions,
  ) {
    this.following = options.follow;
    this.style = markdownStyle(renderer);
    this.markingStyle = markdownStyle(renderer, true);
    this.renderNode = markdownNode(renderer);
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
    this.status = new TextRenderable(renderer, { height: 1, wrapMode: "none", flexShrink: 0, bg: theme.surface });
    this.mindMapView = new MindMapView(renderer, frame);
    frame.add(this.scroll);
    frame.add(this.status);
    renderer.root.add(frame);
    this.pickerView = new PickerView(renderer);
    this.menuView = new MenuView(renderer);
    this.helpView = new HelpView(renderer);
    for (const page of listPages(options.root)) this.remember(page.path);
    renderer.keyInput.on("keypress", this.onKey);
    renderer.on("resize", this.onResize);
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
    this.renderer.off("resize", this.onResize);
    this.setTitle("");
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
    if (page !== this.shown) this.search = undefined;
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
    this.search = undefined;
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
    this.blockPick = undefined;
    this.asking?.cancel();
    this.asking = undefined;
    const views = this.document.blocks.map((block) => this.blockView(block, page, files));
    this.markdownViews = views.map((view) => (view instanceof MarkdownRenderable ? view : undefined));
    this.marked = undefined;
    const frames = views.map((view, index) => this.blockFrame(view, index));
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
      borderColor: theme.quoll,
      onMouseDown: (event) => {
        if (event.button === MouseButton.LEFT && this.blockPick && !this.picker && !this.editing && this.page) this.blockPick.choose(index);
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
      return new MarkdownRenderable(this.renderer, { content: block.text, syntaxStyle: this.style, flexGrow: 1, flexShrink: 1, tableOptions, renderNode: this.renderNode });
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
    const box = new BoxRenderable(this.renderer, { flexDirection: "column", flexGrow: 1, flexShrink: 1, backgroundColor: theme.surface, border: ["left"], customBorderChars: barChars, borderColor: theme.warning, paddingLeft: 1, paddingRight: 1 });
    box.add(new TextRenderable(this.renderer, { content: styled([bold(fg(theme.warning)("merge conflict")), "   ", ...hintParts([["1", "yours"], ["2", "theirs"], ["b", "both"]], "  ")]), wrapMode: "none", marginBottom: 1 }));
    const side = (label: string, text: string, color: string) => {
      box.add(new TextRenderable(this.renderer, { content: styled([bold(fg(color)(label))]), wrapMode: "none" }));
      box.add(text.trim() === "" ? new TextRenderable(this.renderer, { content: "(nothing)", fg: theme.muted }) : new MarkdownRenderable(this.renderer, { content: text, syntaxStyle: this.style, flexShrink: 1 }));
    };
    side(`yours · ${block.oursLabel || "HEAD"}`, block.ours, theme.quoll);
    box.add(new TextRenderable(this.renderer, { content: "", height: 1 }));
    side(`theirs · ${block.theirsLabel || "incoming"}`, block.theirs, theme.secondary);
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
    this.keepSearchFresh();
    this.renderTitle();
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
    const binding = bindingFor(this.bindings(), key);
    if (binding?.run) binding.run();
    else this.unbound(key);
    this.renderStatus();
    this.renderer.requestRender();
  };

  keys(): AppKeys {
    return { app: "quoll", groups: this.editing ? [] : keyGroups(this.bindings()) };
  }

  private bindings(): Binding<() => void>[] {
    if (this.editing) return [];
    const picker = this.picker;
    if (picker) return pickerBindings.map((binding) => ({ ...binding, run: binding.run && (() => this.pickerDone(binding.run!(picker.state))) }));
    if (this.blockPick) return this.blockPickBindings();
    if (this.helpView.open) return this.helpBindings();
    if (this.menu) return this.menuBindings(this.menu);
    if (this.search?.typing) return this.searchPromptBindings();
    const map = this.mindMap;
    if (map) {
      const wrap = (bindings: Binding<(state: NotebookMapState) => NotebookMapOutcome>[]): Binding<() => void>[] =>
        bindings.map((binding) => ({ ...binding, run: binding.run && (() => this.mapOutcome(binding.run!(map))) }));
      if (map.filter !== undefined) return wrap(atlasFilterBindings);
      if (!this.mapFocused) return [...this.atlasPageBindings(), ...wrap(atlasBindings.filter((binding) => binding.on.includes("a") || binding.on.includes("escape"))), ...this.scrollBindings()];
      return [...this.atlasViewBindings(), ...wrap(atlasBindings)];
    }
    return this.pageBindings();
  }

  private unbound(key: KeyEvent): void {
    const text = typedText(key);
    if (this.picker) {
      this.pickerDone(pickerKey(this.picker.state, key));
    } else if (this.blockPick) {
      if (key.name && !key.ctrl && this.blockPick.hints.has(key.name)) this.blockPick.choose(this.blockPick.hints.get(key.name)!);
    } else if (this.helpView.open) {
      return;
    } else if (this.menu) {
      this.closeMenu();
    } else if (this.search?.typing) {
      if (text) this.typeSearch(this.search.query + text);
    } else if (this.mindMap?.filter !== undefined) {
      this.mapOutcome(notebookMapKey(this.mindMap, key));
    }
  }

  private pageBindings(): Binding<() => void>[] {
    const conflicted = () => this.conflicts().length > 0;
    const merging = () => this.gitStatus?.merging === true;
    const searching = () => this.search !== undefined;
    return [
      { group: "Go", label: "find page", on: ["p"], menu: "f", run: () => this.openPicker("Pages", this.pageItems()) },
      { group: "Go", label: "links", on: ["f"], menu: "l", run: () => this.openPicker("Links", this.linkItems()) },
      { group: "Go", label: "outline", on: ["o"], menu: "o", run: () => this.openPicker("Outline", this.outlineItems()) },
      { group: "Go", label: "tags", on: ["t"], menu: "t", run: () => this.openPicker("Tags", this.tagItems()) },
      { group: "Go", label: "atlas", on: ["a"], menu: "a", run: () => this.openMindMap() },
      { group: "Go", label: "index page", on: ["i"], menu: "i", run: () => this.navigate(existsSync(join(this.options.root, indexPage)) ? indexPage : undefined) },
      { group: "Go", label: "back", on: ["H"], menu: "h", run: () => this.travel(() => this.history.back()) },
      { group: "Go", label: "forward", on: ["L"], run: () => this.travel(() => this.history.forward()) },
      { group: "Search", label: "search the page", on: ["/"], menu: "/", run: () => this.startSearch() },
      { group: "Search", label: "next match", on: ["n"], when: searching, run: () => this.nextMatch(1) },
      { group: "Search", label: "previous match", on: ["N"], when: searching, run: () => this.nextMatch(-1) },
      { group: "Search", label: "clear the search", on: ["escape"], when: searching, run: () => this.clearSearch() },
      { group: "Page", label: "edit", on: ["e"], menu: "e", run: () => void this.edit() },
      { group: "Page", label: "copy a block or image", on: ["y"], menu: "y", when: () => this.options.clipboard !== undefined, run: () => this.startCopying() },
      { group: "Page", label: "reload", on: ["r"], menu: "r", run: () => this.reload() },
      { group: "Page", label: this.following ? "stop following edits" : "follow edits", on: ["w"], menu: "w", run: () => this.toggleFollow() },
      ...this.scrollBindings(),
      { group: "Conflicts", label: "next conflict", on: ["n"], when: () => !searching() && (merging() || conflicted()), run: () => this.nextConflict(1) },
      { group: "Conflicts", label: "previous conflict", on: ["N"], when: () => !searching() && (merging() || conflicted()), run: () => this.nextConflict(-1) },
      { group: "Conflicts", label: "keep yours", on: ["1"], when: conflicted, run: () => this.settleConflict("ours") },
      { group: "Conflicts", label: "keep theirs", on: ["2"], when: conflicted, run: () => this.settleConflict("theirs") },
      { group: "Conflicts", label: "keep both", on: ["b"], when: conflicted, run: () => this.settleConflict("both") },
      { group: "Conflicts", label: "abort the merge", on: ["X"], when: merging, run: () => void this.abortMerge() },
      { group: "Notebook", label: merging() ? "finish the merge" : "sync", on: ["P"], menu: "P", when: () => this.options.git !== undefined, run: () => void this.sync() },
      { group: "Notebook", label: "menu", on: [" "], run: () => this.openMenu() },
      { group: "Notebook", label: "keys", on: [], menu: "?", run: () => this.openHelp() },
      { group: "Notebook", label: "quit", on: ["q", "^c"], menu: "q", run: () => this.close() },
    ];
  }

  private scrollBindings(): Binding<() => void>[] {
    const half = () => Math.max(Math.floor(this.scroll.height / 2), 1);
    const page = () => Math.max(this.scroll.height - 1, 1);
    return [
      { group: "Scroll", label: "down a line", on: ["j", "down"], run: () => this.scrollBy(1) },
      { group: "Scroll", label: "up a line", on: ["k", "up"], run: () => this.scrollBy(-1) },
      { group: "Scroll", label: "down a page", on: ["d", "pagedown"], run: () => this.scrollBy(page()) },
      { group: "Scroll", label: "up a page", on: ["u", "pageup"], run: () => this.scrollBy(-page()) },
      { group: "Scroll", label: "down half a page", on: ["^d"], run: () => this.scrollBy(half()) },
      { group: "Scroll", label: "up half a page", on: ["^u"], run: () => this.scrollBy(-half()) },
      { group: "Scroll", label: "top", on: ["g", "home"], run: () => this.scrollBy(-this.scroll.scrollTop) },
      { group: "Scroll", label: "bottom", on: ["G", "end"], run: () => this.scrollBy(this.scroll.scrollHeight) },
    ];
  }

  private scrollBy(delta: number): void {
    this.scroll.scrollBy(delta);
    this.stopFollowing();
    this.lookedAt();
  }

  private atlasViewBindings(): Binding<() => void>[] {
    return [
      { group: "Atlas", label: "page or atlas", on: ["tab"], run: () => this.focusMap(!this.mapFocused) },
      { group: "Atlas", label: "menu", on: [" "], run: () => this.openMenu() },
      { group: "Atlas", label: "keys", on: [], menu: "?", run: () => this.openHelp() },
    ];
  }

  private atlasPageBindings(): Binding<() => void>[] {
    return [{ group: "Atlas", label: "page or atlas", on: ["tab"], run: () => this.focusMap(!this.mapFocused) }];
  }

  private blockPickBindings(): Binding<() => void>[] {
    const pick = this.blockPick!;
    const last = this.blockViews.length - 1;
    const group = pick.verb[0]!.toUpperCase() + pick.verb.slice(1);
    return [
      { group, label: `${pick.verb} a block`, on: [], keys: "a–z" },
      { group, label: "next block", on: ["j", "down"], run: () => this.selectBlock(Math.min(pick.selected + 1, last)) },
      { group, label: "previous block", on: ["k", "up"], run: () => this.selectBlock(Math.max(pick.selected - 1, 0)) },
      { group, label: `${pick.verb} the selected block`, on: ["return"], run: () => pick.choose(pick.selected) },
      { group, label: "cancel", on: ["escape", "q", "^c"], run: () => this.cancelBlockPick() },
    ];
  }

  private helpBindings(): Binding<() => void>[] {
    return [
      { group: "Keys", label: "scroll down", on: ["j", "down"], run: () => this.helpView.scroll(1) },
      { group: "Keys", label: "scroll up", on: ["k", "up"], run: () => this.helpView.scroll(-1) },
      { group: "Keys", label: "close", on: ["escape", "q", "?", "^c"], run: () => this.helpView.render("", undefined) },
    ];
  }

  private menuBindings(entries: Binding<() => void>[]): Binding<() => void>[] {
    return [
      ...entries.map((entry) => ({ group: entry.group, label: entry.label, on: [entry.menu!], run: () => (this.closeMenu(), entry.run!()) })),
      { group: "Menu", label: "close", on: ["escape", " ", "^c"], run: () => this.closeMenu() },
    ];
  }

  private searchPromptBindings(): Binding<() => void>[] {
    return [
      { group: "Search", label: "search for", on: [], keys: "type" },
      { group: "Search", label: "erase", on: ["backspace"], run: () => (this.search!.query === "" ? this.cancelSearch() : this.typeSearch(this.search!.query.slice(0, -1))) },
      { group: "Search", label: "keep the matches", on: ["return"], run: () => this.acceptSearch() },
      { group: "Search", label: "cancel", on: ["escape", "^c"], run: () => this.cancelSearch() },
    ];
  }

  private pickerDone(outcome: PickerOutcome<() => void>): void {
    if (!outcome.done) {
      this.pickerView.render(this.picker?.state);
      return;
    }
    this.picker = undefined;
    this.pickerView.render(undefined);
    outcome.value?.();
  }

  private openMenu(): void {
    this.menu = active(this.bindings()).filter((binding) => binding.menu !== undefined && binding.run !== undefined);
    this.menuView.render(this.mindMap ? "quoll · atlas" : "quoll", keyGroups(this.menuBindings(this.menu).filter((binding) => binding.group !== "Menu")));
  }

  private closeMenu(): void {
    this.menu = undefined;
    this.menuView.render("", undefined);
  }

  private startSearch(): void {
    this.clearSearch();
    this.search = { query: "", typing: true, current: 0, matches: [], seen: [], from: this.scroll.scrollTop };
  }

  private typeSearch(query: string): void {
    const search = this.search!;
    search.query = query;
    this.refreshSearch();
    const first = search.matches.findIndex((match) => this.matchTop(match) >= search.from);
    search.current = first === -1 ? 0 : first;
    this.paintSearch();
    if (search.matches.length > 0) this.showMatch();
    else this.scrollTo({ top: search.from });
  }

  private acceptSearch(): void {
    const search = this.search!;
    if (search.query === "") return this.clearSearch();
    search.typing = false;
  }

  private cancelSearch(): void {
    const from = this.search!.from;
    this.clearSearch();
    this.scrollTo({ top: from });
  }

  private nextMatch(delta: number): void {
    const search = this.search!;
    const count = search.matches.length;
    if (count === 0) return this.flash(`No matches for ${search.query}`);
    search.current = (search.current + delta + count) % count;
    this.paintSearch();
    this.showMatch();
  }

  private clearSearch(): void {
    if (!this.search) return;
    this.search = undefined;
    this.paintSearch();
  }

  private refreshSearch(): void {
    const search = this.search!;
    search.matches = searchTargets(this.blockViews).flatMap((target) => matchesIn(target, search.query));
    search.current = Math.min(search.current, Math.max(search.matches.length - 1, 0));
  }

  private keepSearchFresh(): void {
    const search = this.search;
    if (!search || search.query === "") return;
    const seen = this.searchSeen();
    if (seen.length === search.seen.length && seen.every((now, index) => sameSeen(now, search.seen[index]!))) return;
    this.refreshSearch();
    this.paintSearch();
    this.renderStatus();
  }

  private searchSeen(): Seen[] {
    return searchTargets(this.blockViews).map((target) =>
      target instanceof CodeRenderable
        ? { target, source: target.content, live: target.onChunks, highlighting: target.isHighlighting }
        : { target, source: this.tableMarks.get(target)?.original ?? target.content, live: target.content, highlighting: false },
    );
  }

  private paintSearch(): void {
    const search = this.search;
    const query = search?.query ?? "";
    const current = search?.matches[search.current];
    for (const target of searchTargets(this.blockViews)) {
      const ordinal = current?.target === target ? current.ordinal : undefined;
      const key = query === "" ? "" : `${query}\0${ordinal ?? ""}`;
      if (target instanceof CodeRenderable) this.paintCode(target, key, query, ordinal);
      else this.paintTable(target, key, query, ordinal);
    }
    if (search) search.seen = this.searchSeen();
  }

  private paintCode(target: CodeRenderable, key: string, query: string, ordinal: number | undefined): void {
    const marks = this.codeMarks.get(target);
    const fresh = marks?.applied === target.onChunks ? marks : undefined;
    if ((fresh?.key ?? "") === key) return;
    const original = fresh ? fresh.original : target.onChunks;
    if (key === "") {
      target.onChunks = original;
      this.codeMarks.delete(target);
      return;
    }
    const applied: NonNullable<CodeRenderable["onChunks"]> = async (chunks, context) => markMatches((await original?.(chunks, context)) ?? chunks, query, ordinal);
    target.onChunks = applied;
    this.codeMarks.set(target, { key, applied, original });
  }

  private paintTable(target: TextTableRenderable, key: string, query: string, ordinal: number | undefined): void {
    const marks = this.tableMarks.get(target);
    const fresh = marks?.applied === target.content ? marks : undefined;
    if ((fresh?.key ?? "") === key) return;
    const original = fresh ? fresh.original : target.content;
    if (key === "") {
      target.content = original;
      this.tableMarks.delete(target);
      return;
    }
    let seen = 0;
    const mark = (cell: TextChunk[]) => {
      const at = seen;
      seen += findMatches(chunkText(cell), query).length;
      return markMatches(cell, query, ordinal === undefined ? undefined : ordinal - at);
    };
    const applied = original.map((row) => row.map((cell) => cell && mark(cell)));
    target.content = applied;
    this.tableMarks.set(target, { key, applied, original });
  }

  private matchTop(match: SearchMatch): number {
    const target = match.target;
    const row = target instanceof CodeRenderable ? codeRow(target, match.at) : tableRowTop(target, match.at);
    return target.y - this.scroll.content.y + row;
  }

  private showMatch(): void {
    const search = this.search!;
    const match = search.matches[search.current];
    if (!match) return;
    this.stopFollowing();
    const top = this.matchTop(match);
    if (top >= this.scroll.scrollTop && top < this.scroll.scrollTop + this.scroll.height) return;
    this.scrollTo({ top: Math.max(top - Math.floor(this.scroll.height / 3), 0) });
  }

  private openHelp(): void {
    const here = keyGroups(this.bindings());
    const also = this.mindMap ? keyGroups([...atlasFilterBindings, ...this.scrollBindings()]) : keyGroups([...this.searchPromptBindings(), ...pickerBindings]);
    const renamed: Record<string, string> = { Search: "Search prompt", Scroll: "Page, after Tab" };
    const extra = also.map((group) => ({ ...group, name: renamed[group.name] ?? group.name })).filter((group) => !here.some((shown) => shown.name === group.name));
    const where = this.mindMap ? "atlas" : this.gitStatus?.merging ? "merge" : "page";
    this.helpView.render(`Keys · ${where}`, [...here, ...extra]);
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
    this.mapNode = this.mindMap.choice.node;
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

  private mapOutcome(outcome: NotebookMapOutcome): void {
    if (outcome === "move") {
      this.mindMapView.render(this.mindMap);
      if (this.mindMap!.choice.node !== this.mapNode) this.followMap();
      this.mapNode = this.mindMap?.choice.node;
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
    const node = this.mindMap?.choice.node;
    if (node?.kind === "page" && node.where && node.where.page !== this.page) {
      this.load(node.where.page);
      this.scrollTo({ top: 0 });
    }
    const back = this.mapReturn;
    const current = this.history.current;
    if (back && current && this.page && this.page !== back.page) {
      current.scroll = back.top;
      this.history.visit(this.page);
    }
    this.closeMindMap();
  }

  private followMap(): void {
    const where = this.mapSpot();
    if (!where) {
      this.showSection(undefined);
      return;
    }
    if (where.page !== this.page) this.load(where.page);
    const section = this.showSection(where);
    this.scrollTo(section ? { centre: section } : { line: this.whereLine(where) ?? 0 });
  }

  private mapSpot(): Where | undefined {
    const node = this.mindMap?.choice.node;
    return node?.source ?? node?.where;
  }

  private highlightMapLine(): void {
    const where = this.mapSpot();
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

  private markLink(where: Where | undefined): void {
    const at = where && where.page === this.page && where.column !== undefined ? `${where.line}:${where.column}` : undefined;
    if (this.marked && this.marked.at === at) return;
    if (this.marked) {
      this.marked.view.content = this.marked.text;
      this.marked.view.syntaxStyle = this.style;
      this.marked = undefined;
    }
    if (!where || where.page !== this.page || where.line === undefined || where.column === undefined || where.length === undefined) return;
    const source = this.known.get(where.page);
    if (source === undefined) return;
    const index = blockAtLine(this.document.blocks, where.line);
    const view = this.markdownViews[index];
    const block = this.document.blocks[index];
    const marked = parseDocument(source, { line: where.line, column: where.column, length: where.length }).blocks.find((candidate) => candidate.startLine === block?.startLine);
    if (!view || marked?.kind !== "markdown") return;
    this.marked = { view, text: view.content, at: `${where.line}:${where.column}` };
    view.content = marked.text;
    view.syntaxStyle = this.markingStyle;
  }

  private showSection(where: Where | undefined): Section | undefined {
    const section = where ? this.sectionAt(where) : undefined;
    this.markLink(where);
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
      this.stopBlockPick();
      this.renderer.requestRender();
    });
    this.refocusMap = this.mindMap !== undefined && this.mapFocused;
    if (this.mindMap) this.focusMap(false);
    this.startBlockPick("attach", "ATTACH", (index) => this.comment(index));
    request.picking("Pick a block in quoll · Esc cancels");
    this.renderer.requestRender();
  }

  private startCopying(): void {
    if (!this.page || this.blockViews.length === 0) return this.flash("No page open to copy from");
    this.startBlockPick("copy", "COPY", (index) => void this.copyBlock(index));
    this.renderer.requestRender();
  }

  private startBlockPick(verb: string, mode: string, choose: (index: number) => void): void {
    this.closeMenu();
    this.helpView.render("", undefined);
    this.stopFollowing();
    this.blockPick = { verb, mode, choose, selected: this.visibleBlocks()[0] ?? 0, hints: new Map(), top: undefined, settleFrames: 3 };
    this.renderHints();
  }

  private settleHints(): void {
    const pick = this.blockPick;
    if (!pick) return;
    if (pick.settleFrames > 0) {
      pick.settleFrames--;
      this.renderer.requestRender();
      if (pick.settleFrames > 0) return;
    } else if (pick.top === this.scroll.scrollTop) {
      return;
    }
    this.assignHints();
  }

  private assignHints(): void {
    const pick = this.blockPick!;
    const visible = this.visibleBlocks();
    if (!visible.includes(pick.selected)) pick.selected = visible[0] ?? Math.max(pick.selected, 0);
    pick.hints = new Map(visible.slice(0, hintLetters.length).map((index, at) => [hintLetters[at]!, index]));
    pick.top = this.scroll.scrollTop;
    this.renderHints();
    this.renderer.requestRender();
  }

  private selectBlock(index: number): void {
    this.blockPick!.selected = index;
    const top = this.blockTop(index);
    const bottom = top + (this.blockViews[index]?.height ?? 1);
    if (top < this.scroll.scrollTop) this.scroll.scrollTo(top);
    else if (bottom > this.scroll.scrollTop + this.scroll.height) this.scroll.scrollTo(Math.max(bottom - this.scroll.height, top - this.scroll.height + 1, 0));
    this.lookedAt();
    this.assignHints();
  }

  private cancelBlockPick(): void {
    const asking = this.asking;
    this.asking = undefined;
    asking?.cancel();
    this.stopBlockPick();
  }

  private stopBlockPick(): void {
    this.blockPick = undefined;
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
    const pick = this.blockPick;
    const letters = new Map([...(pick?.hints ?? [])].map(([letter, index]) => [index, letter]));
    this.gutters.forEach((gutter, index) => {
      const selected = pick?.selected === index;
      gutter.width = pick ? 2 : 0;
      gutter.content = pick ? styled([selected ? bold(fg(theme.quoll)(letters.get(index) ?? "▌")) : fg(theme.muted)(letters.get(index) ?? " ")]) : "";
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

  private async copyBlock(index: number): Promise<void> {
    const page = this.page;
    const block = this.document.blocks[index];
    const clipboard = this.options.clipboard;
    this.stopBlockPick();
    if (!page || !block || !clipboard) return;
    const clip = this.clipOf(page, block);
    if (!clip) return this.flash("Nothing to copy: the page has no source yet");
    let failed: string | undefined;
    try {
      failed = await clipboard(clip);
    } catch (error) {
      failed = `Could not copy: ${(error as Error).message}`;
    }
    this.flash(failed ?? ("file" in clip ? `Copied ${basename(clip.file)}; paste it into a GitHub comment to upload it` : `Copied ${lineRange(block)}`));
    this.renderer.requestRender();
  }

  private clipOf(page: string, block: Block): Clip | undefined {
    const file = this.blockAsset(page, block);
    if (file && isCopyableImage(file)) return { file };
    const source = this.sourceOf(page);
    return source === undefined ? undefined : { text: source.split("\n").slice(block.startLine, block.endLine + 1).join("\n") };
  }

  private blockAsset(page: string, block: Block): string | undefined {
    return block.kind === "image" ? resolveAsset(this.options.root, page, block.target, this.lazyFiles()) : undefined;
  }

  private comment(index: number): void {
    const page = this.page;
    const block = this.document.blocks[index];
    const asking = this.asking;
    this.asking = undefined;
    this.stopBlockPick();
    if (!page || !block || !asking) return asking?.cancel();
    const asset = this.blockAsset(page, block);
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

  private readonly onResize = (): void => {
    this.renderStatus();
  };

  private renderStatus(): void {
    const page = this.page ?? "notebook";
    const tags = this.page ? this.tagsOf(this.page).map((tag) => ` #${tag}`).join("") : "";
    const git = this.gitStatus;
    const ahead = git?.merging
      ? fg(theme.warning)(`  ⚠ merging · ${count(git.conflicts.length, "conflicted page")}${git.elsewhere.length > 0 ? ` · ${git.elsewhere.length} elsewhere` : ""} · P finish · X abort`)
      : git && (git.ahead > 0 || git.behind > 0)
        ? fg(theme.quoll)(`  ${git.ahead > 0 ? `↑${git.ahead}` : ""}${git.behind > 0 ? `${git.ahead > 0 ? " " : ""}↓${git.behind}` : ""} P sync`)
        : "";
    const follow = this.following ? [fg(theme.quoll)("  ◉ following edits")] : [];
    const left: Part[] = [pill(this.mode()), " ", fg(theme.text)(page), fg(theme.muted)(tags), ahead, ...follow, ...this.searchParts()];
    const room = this.renderer.width - partsWidth(left) - 3;
    const right = this.message ? [fg(theme.warning)(this.message.text)] : hintParts(fitHints(this.hints(), room), "  ");
    const gap = Math.max(this.renderer.width - partsWidth(left) - partsWidth(right) - 1, 2);
    this.status.content = styled([...left, " ".repeat(gap), ...right, " "]);
    this.renderTitle();
  }

  private searchParts(): Part[] {
    const search = this.search;
    if (!search) return [];
    const count = search.matches.length;
    const found = search.query === "" ? [] : count === 0 ? [fg(theme.warning)("  no matches")] : [fg(theme.muted)(`  ${search.current + 1}/${count}`)];
    if (search.typing) return ["  ", bold(fg(theme.quoll)("/")), fg(theme.text)(search.query), bg(theme.text)(" "), ...found];
    return ["  ", fg(theme.quoll)(`/${search.query}`), ...found];
  }

  private mode(): string {
    if (this.blockPick) return this.blockPick.mode;
    if (this.mindMap) return "ATLAS";
    if (this.gitStatus?.merging) return "MERGE";
    return this.following ? "FOLLOW" : "READ";
  }

  private hints(): Hint[] {
    if (this.search?.typing)
      return [
        ["Enter", "keep"],
        ["Esc", "cancel"],
      ];
    if (this.blockPick) {
      const verb = this.blockPick.verb;
      return [
        ["a–z", verb],
        ["j/k", "move"],
        ["Enter", `${verb} selected`],
        ["Esc", "cancel"],
      ];
    }
    if (this.mindMap?.filter !== undefined)
      return [
        ["type", "filter"],
        ["↑↓", "pick"],
        ["Enter", "go"],
        ["Esc", "cancel"],
      ];
    if (this.mindMap && !this.mapFocused)
      return [
        ["j/k", "scroll page"],
        ["Tab", "atlas"],
        ["a", "land"],
        ["Esc", "exit"],
      ];
    const door = this.mindMap?.door;
    if (door)
      return [
        ["Enter", `⤳ ${door.to}`],
        ["⌫", "back"],
        ["Tab", "page"],
        ["␣?", "keys"],
        ["v", "view"],
      ];
    if (this.mindMap)
      return [
        ["hjkl", "move"],
        ["⌫", "back"],
        ["Tab", "page"],
        ["␣?", "keys"],
        ["v", "view"],
        ["a", "land"],
        ["Esc", "exit"],
      ];
    const search: Hint[] = this.search
      ? [
          ["n/N", "next/prev"],
          ["Esc", "clear"],
        ]
      : [];
    return [
      ...search,
      ["␣", "menu"],
      ["␣?", "keys"],
      ["p", "pages"],
      ["f", "links"],
      ["/", "search"],
      ["o", "outline"],
      ["a", "atlas"],
      ["e", "edit"],
      ["w", "follow"],
      ["q", "quit"],
    ];
  }

  private renderTitle(): void {
    const title = [basename(this.options.root), ...(this.page ? this.page.split("/") : [])].join(" › ");
    if (title === this.title || !this.setTitle(title)) return;
    this.title = title;
  }

  private setTitle(title: string): boolean {
    try {
      this.renderer.setTerminalTitle(title);
      return true;
    } catch {
      return false;
    }
  }
}

function searchTargets(views: Renderable[]): Searchable[] {
  const found: Searchable[] = [];
  const visit = (view: Renderable) => {
    if (view instanceof CodeRenderable || view instanceof TextTableRenderable) found.push(view);
    else for (const child of view.getChildren()) visit(child as Renderable);
  };
  views.forEach(visit);
  return found;
}

function sameSeen(now: Seen, before: Seen): boolean {
  return now.target === before.target && now.source === before.source && now.live === before.live && now.highlighting === before.highlighting;
}

function chunkText(chunks: TextChunk[]): string {
  return chunks.map((chunk) => chunk.text).join("");
}

function matchesIn(target: Searchable, query: string): SearchMatch[] {
  if (target instanceof CodeRenderable) {
    const text = target.plainText;
    let column = 0;
    let from = 0;
    return findMatches(text, query).map((range, ordinal) => {
      const lines = text.slice(from, range.start).split("\n");
      column += lines.reduce((sum, line) => sum + Bun.stringWidth(line), lines.length - 1);
      from = range.start;
      return { target, ordinal, at: column };
    });
  }
  let ordinal = 0;
  return target.content.flatMap((row, index) => row.flatMap((cell) => findMatches(chunkText(cell ?? []), query).map(() => ({ target, ordinal: ordinal++, at: index }))));
}

function codeRow(target: CodeRenderable, column: number): number {
  const starts = target.lineInfo.lineStartCols;
  let row = 0;
  while (row + 1 < starts.length && starts[row + 1]! <= column) row++;
  return row;
}

function tableRowTop(target: TextTableRenderable, row: number): number {
  const offsets = (target as unknown as { _layout?: { rowOffsets?: number[] } })._layout?.rowOffsets;
  const offset = offsets?.[row];
  return offset === undefined ? 1 + row * 2 : offset + 1;
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

function lineRange(block: Block): string {
  return block.startLine === block.endLine ? `line ${block.startLine + 1}` : `lines ${block.startLine + 1}–${block.endLine + 1}`;
}
