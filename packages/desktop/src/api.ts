import type { AgentEvent } from "@t3os/core";

export interface DesktopClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
}

export type ConnectionState = "connecting" | "open" | "closed";

export class DesktopClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #WebSocket: typeof WebSocket;

  constructor(options: DesktopClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#WebSocket = options.WebSocketImpl ?? WebSocket;
  }

  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(`request failed: ${response.status} ${path}`);
    }
    return (await response.json()) as T;
  }

  async health(): Promise<{ ok: boolean }> {
    return this.#json<{ ok: boolean }>("/health");
  }

  async listSessions(): Promise<SessionMeta[]> {
    return this.#json<SessionMeta[]>("/sessions");
  }

  async createSession(title?: string): Promise<SessionMeta> {
    return this.#json<SessionMeta>("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
  }

  async getSession(id: string): Promise<{ id: string; events: AgentEvent[] }> {
    return this.#json<{ id: string; events: AgentEvent[] }>(`/sessions/${id}`);
  }

  async *startTurn(id: string, prompt: string): AsyncIterable<AgentEvent> {
    const response = await this.#fetch(`${this.#baseUrl}/sessions/${id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`turn failed: ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) yield JSON.parse(line) as AgentEvent;
        newline = buffer.indexOf("\n");
      }
    }
    const trailing = buffer.trim();
    if (trailing.length > 0) yield JSON.parse(trailing) as AgentEvent;
  }

  subscribe(
    id: string,
    onEvent: (event: AgentEvent) => void,
    onState?: (state: ConnectionState) => void,
  ): () => void {
    const url = `${this.#baseUrl.replace(/^http/, "ws")}/sessions/${id}/stream`;
    const socket = new this.#WebSocket(url);
    onState?.("connecting");
    socket.addEventListener("open", () => onState?.("open"));
    socket.addEventListener("message", (event: MessageEvent) => {
      onEvent(JSON.parse(String(event.data)) as AgentEvent);
    });
    socket.addEventListener("close", () => onState?.("closed"));
    return () => socket.close();
  }
}
