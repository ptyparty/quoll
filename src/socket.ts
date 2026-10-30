import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { overlaps } from "./notebook.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Request = { show: string; root: string };
export type Reply = { ok: true } | { error: string } | { ignored: true };

function socketDir(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_RUNTIME_DIR || tmpdir(), "quoll");
}

export function listen(root: string, handle: (request: Request) => Reply): () => void {
  const dir = socketDir();
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

export async function send(request: Request): Promise<Reply[]> {
  const dir = socketDir();
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
