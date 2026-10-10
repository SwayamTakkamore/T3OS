import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import { RpcPeer } from "./jsonrpc.js";

export interface McpTransport {
  start(handlers: { onLine: (line: string) => void; onClose: (error?: Error) => void }): void;
  send(line: string): void;
  close(): Promise<void>;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpClientOptions {
  transport: McpTransport;
  name?: string;
  version?: string;
}

export interface McpServerInfo {
  name?: string;
  version?: string;
}

const PROTOCOL_VERSION = "2024-11-05";

export class McpClient {
  readonly #peer: RpcPeer;
  readonly #transport: McpTransport;
  readonly #name: string;
  readonly #version: string;
  #tools: McpToolDef[] = [];
  #serverInfo: McpServerInfo = {};
  #closed = false;

  constructor(options: McpClientOptions) {
    this.#transport = options.transport;
    this.#name = options.name ?? "t3os";
    this.#version = options.version ?? "0.1.0";
    this.#peer = new RpcPeer((line) => this.#transport.send(`${line}\n`));
    this.#transport.start({
      onLine: (line) => this.#peer.handle(line),
      onClose: (error) => this.#peer.rejectAll(error ?? new Error("mcp transport closed")),
    });
  }

  get serverInfo(): McpServerInfo {
    return this.#serverInfo;
  }

  async initialize(): Promise<void> {
    const result = (await this.#peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: this.#name, version: this.#version },
    })) as { serverInfo?: McpServerInfo } | undefined;

    this.#serverInfo = result?.serverInfo ?? {};
    this.#peer.notify("notifications/initialized");
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = (await this.#peer.request("tools/list")) as { tools?: McpToolDef[] } | undefined;
    this.#tools = result?.tools ?? [];
    return this.#tools;
  }

  tools(namespace = "mcp"): Tool[] {
    return this.#tools.map((def) => this.#adapt(def, namespace));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = (await this.#peer.request("tools/call", { name, arguments: args })) as
        | { content?: { type: string; text?: string }[]; isError?: boolean }
        | undefined;

      const content = result?.content ?? [];
      const text = content
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();

      return {
        ok: result?.isError !== true,
        content: text === "" ? "(no output)" : text,
        data: result,
      };
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : String(error),
      };
    }
  }

  #adapt(def: McpToolDef, namespace: string): Tool {
    return {
      schema: {
        name: `${namespace}__${def.name}`,
        description: def.description ?? `MCP tool ${def.name}`,
        parameters: def.inputSchema ?? { type: "object" },
      },
      class: "execute",
      run: (args, _ctx: ToolContext) =>
        this.callTool(def.name, (args ?? {}) as Record<string, unknown>),
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#transport.close();
  }
}
