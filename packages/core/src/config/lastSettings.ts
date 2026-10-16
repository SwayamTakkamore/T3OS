import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedConfig } from "./types.js";

/** Project-level config file used to remember the last chosen settings. */
export function projectConfigPath(projectRoot: string): string {
  return join(projectRoot, ".t3os", "config.json");
}

/**
 * Persists the last used model/provider/effort/permission mode into the
 * project config (`.t3os/config.json`) so the next launch remembers them.
 *
 * Only the four settings keys are written; other keys already present in the
 * file are preserved, and `undefined` values are ignored so callers can pass a
 * partially resolved config.
 */
export async function saveLastSettings(
  projectRoot: string,
  settings: Partial<ResolvedConfig>
): Promise<void> {
  const path = projectConfigPath(projectRoot);
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    current = {};
  }

  if (settings.model !== undefined) current.model = settings.model;
  if (settings.provider !== undefined) current.provider = settings.provider;
  if (settings.effort !== undefined) current.effort = settings.effort;
  if (settings.permissionMode !== undefined) current.permissionMode = settings.permissionMode;

  await mkdir(join(projectRoot, ".t3os"), { recursive: true });
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}
