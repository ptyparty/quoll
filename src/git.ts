import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { contains } from "./notebook.ts";

export type GitStatus = { ahead: number; behind: number; merging: boolean; conflicts: string[]; elsewhere: string[] };

export type SyncResult = { pushed: number } | { conflicts: string[] } | { error: string };

export type NotebookGit = {
  status(): Promise<GitStatus | undefined>;
  fetch(): Promise<void>;
  sync(): Promise<SyncResult>;
  abort(): Promise<string | undefined>;
};

const opening = /^<{7}/m;
const markerSize = 13;

export function notebookGit(root: string): NotebookGit {
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" } });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out: out.trim(), err: err.trim(), code };
  };
  const lines = (text: string) => text.split("\n").filter(Boolean);
  const failure = (result: { err: string; out: string }, fallback: string) => ({ error: lines(result.err).at(-1) ?? lines(result.out).at(-1) ?? fallback });
  const top = async () => (await git("rev-parse", "--show-toplevel")).out;
  const unmerged = async () => lines((await git("diff", "--name-only", "--diff-filter=U")).out);
  const status = async (): Promise<GitStatus | undefined> => {
    const counts = await git("rev-list", "--left-right", "--count", "HEAD...@{upstream}");
    if (counts.code !== 0) return undefined;
    const [ahead, behind] = counts.out.split(/\s+/).map(Number);
    const merging = (await git("rev-parse", "-q", "--verify", "MERGE_HEAD")).code === 0;
    const conflicts = merging ? lines((await git("diff", "--name-only", "--relative", "--diff-filter=U")).out).filter((file) => unsettled(join(root, file))) : [];
    const base = merging ? await top() : "";
    const elsewhere = merging ? (await unmerged()).map((file) => join(base, file)).filter((file) => !contains(root, file) && unsettled(file)) : [];
    return { ahead: ahead ?? 0, behind: behind ?? 0, merging, conflicts, elsewhere };
  };
  const finish = async (): Promise<SyncResult | undefined> => {
    const base = await top();
    const open = (await unmerged()).filter((file) => unsettled(join(base, file)));
    if (open.length > 0) return { conflicts: lines((await git("diff", "--name-only", "--relative", "--diff-filter=U")).out).filter((file) => unsettled(join(root, file))) };
    const files = await unmerged();
    if (files.length > 0) {
      const added = await git("-C", base, "add", "--", ...files);
      if (added.code !== 0) return failure(added, "git add failed");
    }
    const committed = await git("commit", "--no-edit");
    return committed.code === 0 ? undefined : failure(committed, "git commit failed");
  };
  const longMarkers = async () => {
    const found = (await git("rev-parse", "--git-path", "info/attributes")).out;
    if (!found) return;
    const file = isAbsolute(found) ? found : join(root, found);
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {}
    if (/^\*\.md\s.*conflict-marker-size/m.test(text)) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}*.md conflict-marker-size=${markerSize}\n`);
  };
  return {
    status,
    async fetch() {
      await git("fetch", "--quiet");
    },
    async sync() {
      const before = await status();
      if (!before) return { error: "The notebook has no upstream to push to" };
      if (before.merging) {
        const finished = await finish();
        if (finished) return finished;
      } else {
        const fetched = await git("fetch", "--quiet");
        if (fetched.code !== 0) return failure(fetched, "git fetch failed");
        const now = await status();
        if (now && now.behind > 0) {
          await longMarkers();
          const merged = await git("merge", "--no-edit", "@{upstream}");
          if (merged.code !== 0) {
            const conflicts = (await status())?.conflicts ?? [];
            return conflicts.length > 0 || (await unmerged()).length > 0 ? { conflicts } : failure(merged, "git merge failed");
          }
        }
      }
      const ready = await status();
      if (!ready || ready.ahead === 0) return { pushed: 0 };
      const pushed = await git("push");
      return pushed.code === 0 ? { pushed: ready.ahead } : failure(pushed, "git push failed");
    },
    async abort() {
      const aborted = await git("merge", "--abort");
      return aborted.code === 0 ? undefined : (failure(aborted, "git merge --abort failed").error);
    },
  };
}

function unsettled(file: string): boolean {
  try {
    return opening.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}
