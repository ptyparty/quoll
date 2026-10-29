import { BoxRenderable, TextRenderable, bg, bold, fg, type CliRenderer, type KeyEvent } from "@opentui/core";
import { styled, type Part } from "../render/styled.ts";
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
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accent,
      titleColor: theme.accent,
      backgroundColor: theme.surface,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.input = new TextRenderable(renderer, {});
    this.list = new TextRenderable(renderer, { marginTop: 1, wrapMode: "none" });
    this.footer = new TextRenderable(renderer, { fg: theme.muted, marginTop: 1, content: "↑↓ select · Enter open · Esc close" });
    for (const child of [this.input, this.list, this.footer]) this.box.add(child);
    renderer.root.add(this.box);
  }

  render<T>(state: PickerState<T> | undefined): void {
    this.box.visible = state !== undefined;
    if (!state) {
      this.firstShown = 0;
      return;
    }
    this.box.title = ` ${state.title} `;
    this.input.content = styled([bold(fg(theme.accent)("› ")), fg(theme.text)(state.query), bg(theme.text)(" ")]);
    const rows = Math.max(Math.floor(this.renderer.height * 0.8) - 7, 3);
    const matches = state.matches;
    if (state.selected < this.firstShown) this.firstShown = state.selected;
    if (state.selected >= this.firstShown + rows) this.firstShown = state.selected - rows + 1;
    this.firstShown = Math.max(Math.min(this.firstShown, matches.length - rows), 0);
    const shown = matches.slice(this.firstShown, this.firstShown + rows);
    this.list.content = shown.length > 0 ? styled(shown.flatMap((item, index) => row(item, this.firstShown + index === state.selected, index > 0))) : styled([fg(theme.muted)("Nothing matches")]);
    this.box.height = Math.max(shown.length, 1) + 7;
  }
}

function row<T>(item: PickerItem<T>, selected: boolean, newline: boolean): Part[] {
  const indent = "  ".repeat(item.indent ?? 0);
  const label = selected ? bold(fg(theme.accent)(item.label)) : fg(theme.text)(item.label);
  return [
    ...(newline ? ["\n"] : []),
    selected ? fg(theme.accent)("› ") : "  ",
    item.mark ? fg(theme.follow)("● ") : "  ",
    indent,
    label,
    ...(item.detail ? [fg(theme.muted)(`  ${item.detail}`)] : []),
  ];
}
