import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { T3osError } from "../errors.js";
import type { AgentEvent, PermissionMode } from "../types.js";
import type { EffortLevel } from "../presets/index.js";
import { sessionsDir } from "./paths.js";

/** Settings preserved on a per-session basis so a resumed session restores its
 * model/provider/effort/permission mode. */
export interface SessionSettings {
  model?: string;
  effort?: EffortLevel;
  provider?: "hf" | "local";
  permissionMode?: PermissionMode;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  settings?: SessionSettings;
}

export interface SessionBackup {
  id: string;
  originalId: string;
  backupPath: string;
  createdAt: string;
}

export interface BackupResult {
  id: string;
  backupPath: string;
}

interface Header extends SessionMeta {
  kind: "t3os-session";
  version: 1;
}

const SETTINGS_KEYS = ["model", "effort", "provider", "permissionMode"] as const;

export class SessionStore {
  readonly #dir: string;

  constructor(dir: string = sessionsDir()) {
    this.#dir = dir;
  }

  #path(id: string): string {
    return join(this.#dir, `${id}.jsonl`);
  }

  #backupDir(explicit?: string): string {
    return explicit ?? join(this.#dir, "backups");
  }

  #newId(title: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const hash = createHash("sha1").update(`${stamp}:${title}`).digest("hex").slice(0, 6);
    return slug ? `${stamp}-${slug}-${hash}` : `${stamp}-${hash}`;
  }

  async #readPath(path: string): Promise<{ header: Header; events: AgentEvent[] }> {
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const header = JSON.parse(lines[0]!) as Header;
    const events = lines.slice(1).map((l) => JSON.parse(l) as AgentEvent);
    return { header, events };
  }

  async #readAll(id: string): Promise<{ header: Header; events: AgentEvent[] }> {
    return this.#readPath(this.#path(id));
  }

  async #rewrite(header: Header, events: AgentEvent[]): Promise<void> {
    const body = events.map((e) => `${JSON.stringify(e)}\n`).join("");
    await writeFile(this.#path(header.id), `${JSON.stringify(header)}\n${body}`, "utf8");
  }

  async create(title = "untitled", settings?: SessionSettings): Promise<SessionMeta> {
    const now = new Date().toISOString();
    const header: Header = {
      kind: "t3os-session",
      version: 1,
      id: this.#newId(title),
      title,
      createdAt: now,
      updatedAt: now,
      eventCount: 0,
      ...(settings ? { settings: { ...settings } } : {}),
    };
    await mkdir(this.#dir, { recursive: true });
    await this.#rewrite(header, []);
    return header;
  }

  async list(): Promise<SessionMeta[]> {
    await mkdir(this.#dir, { recursive: true });
    const entries = await readdir(this.#dir, { withFileTypes: true });
    const metas: Array<{ meta: SessionMeta; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(this.#dir, entry.name);
      try {
        const { header } = await this.#readPath(path);
        const info = await stat(path);
        metas.push({ meta: header, mtimeMs: info.mtimeMs });
      } catch {
        // Skip unreadable/corrupt session files rather than failing the listing.
      }
    }
    metas.sort((a, b) => {
      if (a.meta.updatedAt !== b.meta.updatedAt) {
        return a.meta.updatedAt < b.meta.updatedAt ? 1 : -1;
      }
      return b.mtimeMs - a.mtimeMs;
    });
    return metas.map((entry) => entry.meta);
  }

  async getMeta(id: string): Promise<SessionMeta | null> {
    try {
      return (await this.#readAll(id)).header;
    } catch {
      return null;
    }
  }

  async append(id: string, event: AgentEvent): Promise<void> {
    const { header, events } = await this.#readAll(id);
    await appendFile(this.#path(id), `${JSON.stringify(event)}\n`, "utf8");
    header.updatedAt = new Date().toISOString();
    header.eventCount = events.length + 1;
    await this.#rewrite(header, [...events, event]);
  }

  async replay(id: string): Promise<AgentEvent[]> {
    return (await this.#readAll(id)).events;
  }

  /** Deletes a session file. Throws when the session does not exist. */
  async delete(id: string): Promise<void> {
    try {
      await rm(this.#path(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new T3osError("config", `Session not found: ${id}`);
      }
      throw error;
    }
  }

  async resume(id: string): Promise<AgentEvent[]> {
    return this.replay(id);
  }

  /** Persists the settings associated with a session so resuming it restores
   * the model/provider/effort/permission mode that was in effect. */
  async updateSettings(id: string, settings: Partial<SessionSettings>): Promise<void> {
    const { header, events } = await this.#readAll(id);
    const merged: SessionSettings = { ...(header.settings ?? {}) };
    const target = merged as Record<(typeof SETTINGS_KEYS)[number], unknown>;
    for (const key of SETTINGS_KEYS) {
      const value: unknown = settings[key];
      if (value !== undefined) target[key] = value;
    }
    header.settings = merged;
    header.updatedAt = new Date().toISOString();
    await this.#rewrite(header, events);
  }

  async fork(id: string, atOffset: number, title = "fork"): Promise<SessionMeta> {
    const { header, events } = await this.#readAll(id);
    const branch = await this.create(title, header.settings);
    for (const event of events.slice(0, atOffset)) {
      await this.append(branch.id, event);
    }
    return branch;
  }

  /** Creates a timestamped copy of a session (header + events + settings) in
   * the session's `backups` directory (or an explicit directory). */
  async backup(id: string, backupDir?: string): Promise<BackupResult> {
    const { header, events } = await this.#readAll(id);
    const dir = this.#backupDir(backupDir);
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupId = `${id}.backup-${stamp}`;
    const backupPath = join(dir, `${backupId}.jsonl`);
    const body = events.map((e) => `${JSON.stringify(e)}\n`).join("");
    await writeFile(backupPath, `${JSON.stringify(header)}\n${body}`, "utf8");
    return { id: backupId, backupPath };
  }

  /** Lists available backups newest-first. Missing backup directories read as empty. */
  async listBackups(backupDir?: string): Promise<SessionBackup[]> {
    const dir = this.#backupDir(backupDir);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const backups: SessionBackup[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const backupPath = join(dir, name);
      try {
        const { header } = await this.#readPath(backupPath);
        const info = await stat(backupPath);
        backups.push({
          id: name.slice(0, -".jsonl".length),
          originalId: header.id,
          backupPath,
          createdAt: info.mtime.toISOString(),
        });
      } catch {
        // Skip unreadable/corrupt backup files rather than failing the listing.
      }
    }
    backups.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return backups;
  }

  /** Restores a backup into a brand-new session, preserving all events and settings. */
  async restoreBackup(backupPath: string, newTitle?: string): Promise<SessionMeta> {
    const { header, events } = await this.#readPath(backupPath);
    const restored = await this.create(newTitle ?? header.title, header.settings);
    for (const event of events) {
      await this.append(restored.id, event);
    }
    return (await this.getMeta(restored.id)) ?? restored;
  }
}
