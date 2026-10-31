import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { overlaps } from "./notebook.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Request = { show: string; root: string };
export type Reply = { ok: true } | { error: string } | { ignored: true };

type Env = Record<string, string | undefined>;

function socketDir(env: Env): string {
  return join(env.QMUX_TAB_DIR || env.XDG_RUNTIME_DIR || tmpdir(), "quoll");
}

export function listen(root: string, handle: (request: Request) => Reply, env: Env = process.env): () => void {
  const dir = socketDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${process.pid}.sock`);
  const rootFile = join(dir, `${process.pid}.root`);
  rmSync(path, { force: true });
  writeFileSync(rootFile, root);
  const buffers = new Map<object, string>();
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, data) {
        const text = (buffers.get(socket) ?? "") + data.toString();
        const newline = text.indexOf("\n");
        if (newline === -1) {
          buffers.set(socket, text);
          return;
        }
        buffers.delete(socket);
        let reply: Reply;
        try {
          reply = handle(JSON.parse(text.slice(0, newline)) as Request);
        } catch (error) {
          reply = { error: (error as Error).message };
        }
        socket.end(`${JSON.stringify(reply)}\n`);
      },
      close(socket) {
        buffers.delete(socket);
      },
    },
  });
  return () => {
    server.stop(true);
    rmSync(path, { force: true });
    rmSync(rootFile, { force: true });
  };
}

export async function send(request: Request, env: Env = process.env): Promise<Reply[]> {
  const dir = socketDir(env);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^\d+\.sock$/.test(name));
  } catch {
    return [];
  }
  const viewers = names
    .map((name) => join(dir, name))
    .filter((path) => {
      const root = viewerRoot(path);
      return root !== undefined && overlaps(root, request.root);
    });
  const replies = await Promise.all(viewers.map((path) => ask(path, request)));
  return replies.filter((reply): reply is Reply => reply !== undefined);
}

export function tabViewerRoot(env: Env = process.env): string | undefined {
  if (!env.QMUX_TAB_DIR) return undefined;
  const dir = socketDir(env);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^\d+\.root$/.test(name));
  } catch {
    return undefined;
  }
  return names
    .filter((name) => isRunning(Number.parseInt(name, 10)))
    .map((name) => join(dir, name))
    .map((path) => ({ path, modified: modifiedTime(path) }))
    .sort((a, b) => b.modified - a.modified)
    .map(({ path }) => viewerRoot(path))
    .find((root) => root !== undefined);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function modifiedTime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function viewerRoot(socketPath: string): string | undefined {
  try {
    return readFileSync(socketPath.replace(/\.sock$/, ".root"), "utf8");
  } catch {
    return undefined;
  }
}

const replyTimeoutMs = 2000;

async function ask(path: string, request: Request): Promise<Reply | undefined> {
  const { promise, resolve } = Promise.withResolvers<Reply | undefined>();
  let text = "";
  let connection;
  try {
    connection = await Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify(request)}\n`);
        },
        data(_socket, data) {
          text += data.toString();
        },
        close() {
          try {
            resolve(JSON.parse(text) as Reply);
          } catch {
            resolve(undefined);
          }
        },
        error() {
          resolve(undefined);
        },
      },
    });
  } catch {
    rmSync(path, { force: true });
    rmSync(path.replace(/\.sock$/, ".root"), { force: true });
    return undefined;
  }
  const timer = setTimeout(() => {
    resolve(undefined);
    connection.end();
  }, replyTimeoutMs);
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
  }
}
