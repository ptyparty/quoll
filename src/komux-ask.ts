import { homedir } from "node:os";

export type AskedRoot = { status: "picked"; root: string } | { status: "cancelled" };

export function rootForm(title: string, roots: string[], home = homedir()) {
  return {
    title,
    elements: [
      {
        type: "choice",
        id: "root",
        label: "Which notebook root should quoll use here?",
        options: roots.map((root) => ({ value: root, label: tildePath(root, home) })),
        default: roots[0],
        required: true,
        other: false,
      },
      { type: "note", text: "quoll remembers the answer for this directory; quoll --pick asks again." },
    ],
  };
}

export function askedRoot(output: string, roots: string[]): AskedRoot | undefined {
  try {
    const result: unknown = JSON.parse(output);
    if (!result || typeof result !== "object") return undefined;
    const { status, values } = result as { status?: unknown; values?: { root?: unknown } };
    if (status === "cancelled") return { status: "cancelled" };
    const root = values?.root;
    if (status === "submitted" && typeof root === "string" && roots.includes(root)) return { status: "picked", root };
    return undefined;
  } catch {
    return undefined;
  }
}

export async function askRootWithKomux(title: string, roots: string[]): Promise<AskedRoot | undefined> {
  try {
    const child = Bun.spawn(["komux", "ask", "-", "--wait", "--host", "komux"], {
      stdin: new Blob([JSON.stringify(rootForm(title, roots))]),
      stdout: "pipe",
      stderr: "ignore",
    });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? askedRoot(output, roots) : undefined;
  } catch {
    return undefined;
  }
}

function tildePath(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
