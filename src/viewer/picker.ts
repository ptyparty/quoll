import { BorderChars, BoxRenderable, TextRenderable, bg, bold, fg, type CliRenderer, type KeyEvent } from "@opentui/core";
import { hintParts, partsWidth, styled, type Part } from "../render/styled.ts";
import { theme } from "../render/theme.ts";

export type PickerItem<T> = { label: string; detail?: string; mark?: boolean; indent?: number; value: T };

export class PickerState<T> {
  query = "";
  selected = 0;

  constructor(
    readonly title: string,
    private readonly items: PickerItem<T>[],
  ) {}

  get matches(): PickerItem<T>[] {
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.items.filter((item) => words.every((word) => `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(word)));
  }

  get choice(): T | undefined {
    return this.matches[this.selected]?.value;
  }

  type(text: string): void {
    this.query += text;
    this.selected = 0;
  }

  erase(): void {
    this.query = this.query.slice(0, -1);
    this.selected = 0;
  }

  move(delta: number): void {
    const count = this.matches.length;
    if (count === 0) return;
    this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
  }
}

export type PickerOutcome<T> = { done: true; value: T | undefined } | { done: false };

export function pickerKey<T>(state: PickerState<T>, key: KeyEvent): PickerOutcome<T> {
  if (key.name === "escape" || (key.ctrl && key.name === "c")) return { done: true, value: undefined };
  if (key.name === "return") return { done: true, value: state.choice };
  if (key.name === "up" || (key.ctrl && key.name === "p")) state.move(-1);
  else if (key.name === "down" || (key.ctrl && key.name === "n")) state.move(1);
  else if (key.name === "pageup") state.move(-10);
  else if (key.name === "pagedown") state.move(10);
  else if (key.name === "backspace") state.erase();
  else if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= " ") state.type(key.sequence);
  return { done: false };
}

export class PickerView {
  private readonly box: BoxRenderable;
  private readonly heading: TextRenderable;
  private readonly input: TextRenderable;
  private readonly list: TextRenderable;
  private readonly footer: TextRenderable;
  private firstShown = 0;

  constructor(private readonly renderer: CliRenderer) {
    this.box = new BoxRenderable(renderer, {
      position: "absolute",
      left: "10%",
      top: "10%",
      width: "80%",
      zIndex: 200,
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
    });
    this.heading = new TextRenderable(renderer, { wrapMode: "none", marginBottom: 1 });
    this.input = new TextRenderable(renderer, {});
    this.list = new TextRenderable(renderer, { marginTop: 1, wrapMode: "none" });
    this.footer = new TextRenderable(renderer, {
      marginTop: 1,
      content: styled(
        hintParts(
          [
            ["↑↓", "select"],
            ["Enter", "open"],
            ["Esc", "close"],
          ],
          "  ",
        ),
      ),
    });
    for (const child of [this.heading, this.input, this.list, this.footer]) this.box.add(child);
    renderer.root.add(this.box);
  }

  destroy(): void {
    this.box.destroyRecursively();
  }

  render<T>(state: PickerState<T> | undefined): void {
    this.box.visible = state !== undefined;
    if (!state) {
      this.firstShown = 0;
      return;
    }
    this.heading.content = styled([bold(fg(theme.text)(state.title))]);
    this.input.content = styled([bold(fg(theme.quoll)("› ")), fg(theme.text)(state.query), bg(theme.text)(" ")]);
    const rows = Math.max(Math.floor(this.renderer.height * 0.8) - 9, 3);
    const matches = state.matches;
    if (state.selected < this.firstShown) this.firstShown = state.selected;
    if (state.selected >= this.firstShown + rows) this.firstShown = state.selected - rows + 1;
    this.firstShown = Math.max(Math.min(this.firstShown, matches.length - rows), 0);
    const shown = matches.slice(this.firstShown, this.firstShown + rows);
    this.list.content = shown.length > 0 ? styled(shown.flatMap((item, index) => row(item, this.firstShown + index === state.selected, index > 0, this.list.width))) : styled([fg(theme.muted)("Nothing matches")]);
    this.box.height = Math.max(shown.length, 1) + 9;
  }
}

function row<T>(item: PickerItem<T>, selected: boolean, newline: boolean, width: number): Part[] {
  const indent = "  ".repeat(item.indent ?? 0);
  const paint = (part: Part): Part => (selected ? bg(theme.selection)(part) : part);
  const label = selected ? bold(fg(theme.text)(item.label)) : fg(theme.text)(item.label);
  const parts: Part[] = [selected ? fg(theme.quoll)("› ") : "  ", item.mark ? fg(theme.quoll)("● ") : "  ", indent, label, ...(item.detail ? [fg(theme.muted)(`  ${item.detail}`)] : [])];
  const fill = selected ? " ".repeat(Math.max(width - partsWidth(parts), 0)) : "";
  return [...(newline ? ["\n"] : []), ...[...parts, fill].map(paint)];
}
