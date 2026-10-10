import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent } from "../types.js";
import { sessionsDir } from "./paths.js";

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
}

interface Header extends SessionMeta {
  kind: "t3os-session";
  version: 1;
}

export class SessionStore {
  readonly #dir: string;

  constructor(dir: string = sessionsDir()) {
    this.#dir = dir;
  }

  #path(id: string): string {
    return join(this.#dir, `${id}.jsonl`);
  }

  #newId(title: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const hash = createHash("sha1").update(`${stamp}:${title}`).digest("hex").slice(0, 6);
    return slug ? `${stamp}-${slug}-${hash}` : `${stamp}-${hash}`;
  }

  async #readAll(id: string): Promise<{ header: Header; events: AgentEvent[] }> {
    const raw = await readFile(this.#path(id), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const header = JSON.parse(lines[0]!) as Header;
    const events = lines.slice(1).map((l) => JSON.parse(l) as AgentEvent);
    return { header, events };
  }

  async #rewrite(header: Header, events: AgentEvent[]): Promise<void> {
    const body = events.map((e) => `${JSON.stringify(e)}\n`).join("");
    await writeFile(this.#path(header.id), `${JSON.stringify(header)}\n${body}`, "utf8");
  }

  async create(title = "untitled"): Promise<SessionMeta> {
    const now = new Date().toISOString();
    const header: Header = {
      kind: "t3os-session",
      version: 1,
      id: this.#newId(title),
      title,
      createdAt: now,
      updatedAt: now,
      eventCount: 0
    };
    await mkdir(this.#dir, { recursive: true });
    await writeFile(this.#path(header.id), `${JSON.stringify(header)}\n`, "utf8");
    return header;
  }

  async list(): Promise<SessionMeta[]> {
    await mkdir(this.#dir, { recursive: true });
    const files = (await readdir(this.#dir)).filter((f) => f.endsWith(".jsonl"));
    const metas = await Promise.all(
      files.map(async (f) => (await this.#readAll(f.replace(/\.jsonl$/, ""))).header)
    );
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

  async resume(id: string): Promise<AgentEvent[]> {
    return this.replay(id);
  }

  async fork(id: string, atOffset: number, title = "fork"): Promise<SessionMeta> {
    const { events } = await this.#readAll(id);
    const branch = await this.create(title);
    for (const event of events.slice(0, atOffset)) {
      await this.append(branch.id, event);
    }
    return branch;
  }
}
