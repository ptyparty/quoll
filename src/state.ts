import { homedir } from "node:os";
import { join } from "node:path";

export function stateDir(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "quoll");
}
