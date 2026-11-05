import { BorderChars, BoxRenderable, TextRenderable, bold, fg, type CliRenderer } from "@opentui/core";
import { hintParts, partsWidth, styled, type Hint, type Part } from "../render/styled.ts";
import { theme } from "../render/theme.ts";
import type { KeyGroup } from "./keys.ts";

const columnGap = 4;
const cardPadding = 4;

function card(renderer: CliRenderer, options: ConstructorParameters<typeof BoxRenderable>[1]): BoxRenderable {
  const box = new BoxRenderable(renderer, {
    position: "absolute",
    zIndex: 210,
    visible: false,
    border: ["left"],
    customBorderChars: { ...BorderChars.single, vertical: "▎" },
    borderColor: theme.quoll,
    backgroundColor: theme.raised,
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 1,
    paddingBottom: 1,
    ...options,
  });
  renderer.root.add(box);
  return box;
}

function groupLines(name: string, rows: Hint[], keyWidth: number): Part[][] {
  return [[bold(fg(theme.muted)(name))], ...rows.map(([key, label]): Part[] => [bold(fg(theme.quoll)(key.padEnd(keyWidth))), "  ", fg(theme.text)(label)])];
}

function joinColumns(columns: Part[][][], gap: number): Part[][] {
  const widths = columns.map((column) => Math.max(...column.map(partsWidth), 0));
  const height = Math.max(...columns.map((column) => column.length), 0);
  return Array.from({ length: height }, (_, row) =>
    columns.flatMap((column, index) => {
      const line = column[row] ?? [];
      const last = index === columns.length - 1;
      return last ? line : [...line, " ".repeat(widths[index]! - partsWidth(line) + gap)];
    }),
  );
}

function joinLines(lines: Part[][]): Part[] {
  return lines.flatMap((line, index) => [...(index > 0 ? ["\n"] : []), ...line]);
}

export class MenuView {
  private readonly box: BoxRenderable;
  private readonly heading: TextRenderable;
  private readonly body: TextRenderable;
  private readonly footer: TextRenderable;

  constructor(renderer: CliRenderer) {
    this.box = card(renderer, { right: 2, bottom: 2 });
    this.heading = new TextRenderable(renderer, { wrapMode: "none", marginBottom: 1 });
    this.body = new TextRenderable(renderer, { wrapMode: "none" });
    this.footer = new TextRenderable(renderer, { wrapMode: "none", marginTop: 1, content: styled(hintParts([["Esc", "close"]], "  ")) });
    for (const child of [this.heading, this.body, this.footer]) this.box.add(child);
  }

  destroy(): void {
    this.box.destroyRecursively();
  }

  render(title: string, groups: KeyGroup[] | undefined): void {
    this.box.visible = groups !== undefined;
    if (!groups) return;
    const keyWidth = Math.max(...groups.flatMap((group) => group.commands.map((command) => Bun.stringWidth(command.keys))), 1);
    const lines = joinColumns(
      groups.map((group) => groupLines(group.name, group.commands.map((command): Hint => [command.keys, command.label]), keyWidth)),
      columnGap,
    );
    this.heading.content = styled([bold(fg(theme.text)(title))]);
    this.body.content = styled(joinLines(lines));
    this.box.width = Math.max(...lines.map(partsWidth), partsWidth([title])) + cardPadding;
    this.box.height = lines.length + 6;
  }
}

export class HelpView {
  private readonly box: BoxRenderable;
  private readonly heading: TextRenderable;
  private readonly body: TextRenderable;
  private readonly footer: TextRenderable;
  private lines: Part[][] = [];
  private top = 0;

  constructor(private readonly renderer: CliRenderer) {
    this.box = card(renderer, { left: "8%", top: "8%", width: "84%" });
    this.heading = new TextRenderable(renderer, { wrapMode: "none", marginBottom: 1 });
    this.body = new TextRenderable(renderer, { wrapMode: "none", flexGrow: 1 });
    this.footer = new TextRenderable(renderer, { wrapMode: "none", marginTop: 1 });
    for (const child of [this.heading, this.body, this.footer]) this.box.add(child);
  }

  destroy(): void {
    this.box.destroyRecursively();
  }

  get open(): boolean {
    return this.box.visible;
  }

  scroll(delta: number): void {
    this.top = Math.max(Math.min(this.top + delta, this.lines.length - this.rows()), 0);
    this.paint();
  }

  render(title: string, groups: KeyGroup[] | undefined): void {
    this.box.visible = groups !== undefined;
    this.top = 0;
    if (!groups) return;
    const width = Math.floor(this.renderer.width * 0.84) - cardPadding;
    const keyWidth = Math.max(...groups.flatMap((group) => group.commands.map((command) => Bun.stringWidth(command.keys))), 1);
    const blocks = groups.map((group) => groupLines(group.name, group.commands.map((command): Hint => [command.keys, command.label]), keyWidth));
    const columnWidth = Math.max(...blocks.flat().map(partsWidth), 1);
    const count = Math.max(Math.min(Math.floor((width + columnGap) / (columnWidth + columnGap)), blocks.length), 1);
    const total = blocks.reduce((sum, block) => sum + block.length + 1, 0);
    const target = Math.ceil(total / count);
    const columns: Part[][][] = [[]];
    for (const block of blocks) {
      let column = columns.at(-1)!;
      if (column.length > 0 && column.length + block.length > target && columns.length < count) columns.push((column = []));
      if (column.length > 0) column.push([]);
      column.push(...block);
    }
    this.lines = joinColumns(columns, columnGap);
    this.heading.content = styled([bold(fg(theme.text)(title))]);
    this.paint();
  }

  private rows(): number {
    return Math.max(Math.floor(this.renderer.height * 0.84) - 6, 3);
  }

  private paint(): void {
    const rows = this.rows();
    const shown = this.lines.slice(this.top, this.top + rows);
    this.body.content = styled(joinLines(shown));
    this.box.height = shown.length + 6;
    const more = this.lines.length > rows;
    this.footer.content = styled(hintParts([...(more ? ([["j/k", "scroll"]] as Hint[]) : []), ["Esc", "close"]], "  "));
  }
}
