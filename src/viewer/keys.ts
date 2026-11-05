import type { KeyEvent } from "@opentui/core";

export type KeyCommand = { label: string; keys: string; send?: string };
export type KeyGroup = { name: string; commands: KeyCommand[] };
export type AppKeys = { app: string; groups: KeyGroup[] };

export type Binding<R> = { group: string; label: string; on: string[]; menu?: string; keys?: string; when?: () => boolean; run?: R };

const names: Record<string, { shown: string; bytes: string }> = {
  " ": { shown: "␣", bytes: " " },
  space: { shown: "␣", bytes: " " },
  return: { shown: "Enter", bytes: "\r" },
  escape: { shown: "Esc", bytes: "\x1b" },
  tab: { shown: "Tab", bytes: "\t" },
  backspace: { shown: "⌫", bytes: "\x7f" },
  up: { shown: "↑", bytes: "\x1b[A" },
  down: { shown: "↓", bytes: "\x1b[B" },
  right: { shown: "→", bytes: "\x1b[C" },
  left: { shown: "←", bytes: "\x1b[D" },
  pageup: { shown: "PgUp", bytes: "\x1b[5~" },
  pagedown: { shown: "PgDn", bytes: "\x1b[6~" },
  home: { shown: "Home", bytes: "\x1b[H" },
  end: { shown: "End", bytes: "\x1b[F" },
};

export function keyMatches(spec: string, key: KeyEvent): boolean {
  if (spec.length === 1) {
    if (key.ctrl || key.meta) return false;
    const lower = spec.toLowerCase();
    return key.sequence === spec || (lower !== spec.toUpperCase() && key.name === lower && key.shift === (spec !== lower));
  }
  if (spec.startsWith("^")) return key.ctrl && key.name === spec.slice(1);
  return key.name === spec;
}

export function keyName(spec: string): string {
  return names[spec]?.shown ?? spec;
}

export function keyBytes(spec: string): string {
  if (spec.startsWith("^") && spec.length === 2) return String.fromCharCode(spec.charCodeAt(1) - 96);
  return names[spec]?.bytes ?? spec;
}

export function active<R>(bindings: Binding<R>[]): Binding<R>[] {
  return bindings.filter((binding) => binding.when?.() ?? true);
}

export function bindingFor<R>(bindings: Binding<R>[], key: KeyEvent): Binding<R> | undefined {
  return active(bindings).find((binding) => binding.run !== undefined && binding.on.some((spec) => keyMatches(spec, key)));
}

export function menuBinding<R>(bindings: Binding<R>[], key: KeyEvent): Binding<R> | undefined {
  return active(bindings).find((binding) => binding.menu !== undefined && keyMatches(binding.menu, key));
}

export function bindingKeys(binding: Binding<unknown>): string {
  if (binding.keys !== undefined) return binding.keys;
  return [...collapse(binding.on).map(keyName), ...(binding.menu ? [`␣${binding.menu}`] : [])].join(" ");
}

export function command(binding: Binding<unknown>): KeyCommand {
  const first = binding.on[0];
  const send = first !== undefined ? keyBytes(first) : binding.menu !== undefined ? ` ${binding.menu}` : undefined;
  return { label: binding.label, keys: bindingKeys(binding), ...(send !== undefined && binding.run !== undefined ? { send } : {}) };
}

export function keyGroups(bindings: Binding<unknown>[]): KeyGroup[] {
  const groups: KeyGroup[] = [];
  for (const binding of active(bindings)) {
    const group = groups.find((candidate) => candidate.name === binding.group) ?? groups[groups.push({ name: binding.group, commands: [] }) - 1]!;
    group.commands.push(command(binding));
  }
  return groups;
}

function collapse(specs: string[]): string[] {
  const shown: string[] = [];
  for (const spec of specs) {
    const name = keyName(spec);
    if (!shown.includes(name)) shown.push(name);
  }
  return shown;
}
