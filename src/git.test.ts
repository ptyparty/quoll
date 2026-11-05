import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notebookGit } from "./git.ts";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function run(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, env });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `quoll-${name}-`));
  dirs.push(dir);
  return dir;
}

function remote(): { clone: () => { root: string; write: (file: string, text: string) => void } } {
  const bare = temp("remote");
  run(bare, "init", "--bare", "-q", "-b", "main");
  const first = temp("seed");
  run(first, "init", "-q", "-b", "main");
  writeFileSync(join(first, "index.md"), "# Index\n\nfirst\n");
  run(first, "add", ".");
  run(first, "commit", "-q", "-m", "seed");
  run(first, "remote", "add", "origin", bare);
  run(first, "push", "-q", "-u", "origin", "main");
  return {
    clone: () => {
      const root = join(temp("clone"), "notes");
      run(tmpdir(), "clone", "-q", bare, root);
      return {
        root,
        write: (file, text) => {
          writeFileSync(join(root, file), text);
          run(root, "add", file);
          run(root, "commit", "-q", "-m", file);
        },
      };
    },
  };
}

const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));

beforeAll(() => {
  Object.assign(process.env, env);
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("notebook git", () => {
  test("counts both ways, pulls in what the other side pushed, and pushes", async () => {
    const origin = remote();
    const mine = origin.clone();
    const theirs = origin.clone();
    theirs.write("plan.md", "# Plan\n");
    run(theirs.root, "push", "-q");
    mine.write("decisions.md", "# Decisions\n");
    const git = notebookGit(mine.root);
    expect(await git.status()).toEqual({ ahead: 1, behind: 0, merging: false, conflicts: [], elsewhere: [] });
    await git.fetch();
    expect((await git.status())?.behind).toBe(1);
    expect(await git.sync()).toEqual({ pushed: 2 });
    expect(await git.status()).toEqual({ ahead: 0, behind: 0, merging: false, conflicts: [], elsewhere: [] });
  });

  test("stops at a conflict, and finishes the merge once its page is settled", async () => {
    const origin = remote();
    const mine = origin.clone();
    const theirs = origin.clone();
    theirs.write("index.md", "# Index\n\ntheirs\n");
    run(theirs.root, "push", "-q");
    mine.write("index.md", "# Index\n\nmine\n");
    const git = notebookGit(mine.root);
    expect(await git.sync()).toEqual({ conflicts: ["index.md"] });
    expect((await git.status())?.merging).toBe(true);
    expect(readFileSync(join(mine.root, "index.md"), "utf8")).toContain("<<<<<<<");
    expect(await git.sync()).toEqual({ conflicts: ["index.md"] });
    writeFileSync(join(mine.root, "index.md"), "# Index\n\nmine\ntheirs\n");
    expect(await git.sync()).toEqual({ pushed: 2 });
    expect(await git.status()).toEqual({ ahead: 0, behind: 0, merging: false, conflicts: [], elsewhere: [] });
  });

  test("lengthens conflict markers before merging, so a setext heading can't pass for one", async () => {
    const origin = remote();
    const mine = origin.clone();
    const theirs = origin.clone();
    theirs.write("index.md", "Index\n=======\n\ntheirs\n");
    run(theirs.root, "push", "-q");
    mine.write("index.md", "Index\n=======\n\nmine\n");
    const git = notebookGit(mine.root);
    expect(await git.sync()).toEqual({ conflicts: ["index.md"] });
    expect(readFileSync(join(mine.root, ".git", "info", "attributes"), "utf8")).toContain("*.md conflict-marker-size=13");
    const text = readFileSync(join(mine.root, "index.md"), "utf8");
    expect(text).toContain(`${"<".repeat(13)} HEAD`);
    writeFileSync(join(mine.root, "index.md"), "Index\n=======\n\nmine and theirs\n");
    expect(await git.sync()).toEqual({ pushed: 2 });
  });

  test("aborts a merge, leaving the page as it was", async () => {
    const origin = remote();
    const mine = origin.clone();
    const theirs = origin.clone();
    theirs.write("index.md", "# Index\n\ntheirs\n");
    run(theirs.root, "push", "-q");
    mine.write("index.md", "# Index\n\nmine\n");
    const git = notebookGit(mine.root);
    await git.sync();
    expect(await git.abort()).toBeUndefined();
    expect((await git.status())?.merging).toBe(false);
    expect(readFileSync(join(mine.root, "index.md"), "utf8")).toBe("# Index\n\nmine\n");
  });

  test("tells conflicts outside the notebook folder apart from the notebook's own", async () => {
    const origin = remote();
    const mine = origin.clone();
    const theirs = origin.clone();
    for (const side of [mine, theirs]) Bun.spawnSync(["mkdir", "-p", join(side.root, "notes")]);
    theirs.write("index.md", "# Index\n\ntheirs\n");
    theirs.write("notes/page.md", "theirs\n");
    run(theirs.root, "push", "-q");
    mine.write("index.md", "# Index\n\nmine\n");
    mine.write("notes/page.md", "mine\n");
    const git = notebookGit(join(mine.root, "notes"));
    expect(await git.sync()).toEqual({ conflicts: ["page.md"] });
    const status = await git.status();
    expect(status?.conflicts).toEqual(["page.md"]);
    expect(status?.elsewhere).toEqual([join(mine.root, "index.md")]);
    writeFileSync(join(mine.root, "notes", "page.md"), "mine\n");
    expect((await git.status())?.conflicts).toEqual([]);
    expect(await git.sync()).toEqual({ conflicts: [] });
    writeFileSync(join(mine.root, "index.md"), "# Index\n\nboth\n");
    expect(await git.sync()).toEqual({ pushed: 3 });
  });

  test("has nothing to sync outside a repository with an upstream", async () => {
    const git = notebookGit(temp("plain"));
    expect(await git.status()).toBeUndefined();
    expect(await git.sync()).toEqual({ error: "The notebook has no upstream to push to" });
  });
});
