import { homedir } from "node:os";
import { join } from "node:path";

export function sessionsDir(): string {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "t3os", "sessions");
}
