import { describe, expect, it } from "vitest";
import { McpClient, type McpTransport } from "../src/mcp/client.js";

interface Handlers {
  onLine: (line: string) => void;
  onClose: (error?: Error) => void;
}

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: { arguments?: { text?: string } };
}

class MemoryTransport implements McpTransport {
  handlers?: Handlers;
  onSend?: (message: JsonRpcMessage, reply: (message: unknown) => void) => void;

  start(handlers: Handlers): void {
    this.handlers = handlers;
  }

  send(line: string): void {
    const message = JSON.parse(line) as JsonRpcMessage;
    this.onSend?.(message, (reply) => this.handlers?.onLine(`${JSON.stringify(reply)}\n`));
  }

  async close(): Promise<void> {
    this.handlers?.onClose();
  }
}

function server(transport: MemoryTransport): void {
  transport.onSend = (message, reply) => {
    if (typeof message.id !== "number") return;
    if (message.method === "initialize") {
      reply({
        jsonrpc: "2.0",
        id: message.id,
        result: { serverInfo: { name: "fake", version: "1.0" }, capabilities: { tools: {} } },
      });
    } else if (message.method === "tools/list") {
      reply({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo text",
              inputSchema: { type: "object", properties: { text: { type: "string" } } },
            },
          ],
        },
      });
    } else if (message.method === "tools/call") {
      reply({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `echo:${message.params?.arguments?.text ?? ""}` }] },
      });
    }
  };
}

describe("McpClient", () => {
  it("initializes, lists tools and calls one", async () => {
    const transport = new MemoryTransport();
    server(transport);
    const client = new McpClient({ transport });

    await client.initialize();
    expect(client.serverInfo.name).toBe("fake");

    const defs = await client.listTools();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe("echo");

    const tools = client.tools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.schema.name).toBe("mcp__echo");
    expect(tools[0]!.class).toBe("execute");

    const result = await tools[0]!.run({ text: "hi" }, { root: "." });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("echo:hi");
  });

  it("surfaces a JSON-RPC error as a failed tool result", async () => {
    const transport = new MemoryTransport();
    transport.onSend = (message, reply) => {
      if (typeof message.id !== "number") return;
      if (message.method === "initialize") {
        reply({ jsonrpc: "2.0", id: message.id, result: { serverInfo: {}, capabilities: {} } });
      } else if (message.method === "tools/list") {
        reply({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "boom" }] } });
      } else {
        reply({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "nope" },
        });
      }
    };

    const client = new McpClient({ transport });
    await client.initialize();
    await client.listTools();

    const result = await client.tools()[0]!.run({}, { root: "." });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("nope");
  });

  it("rejects in-flight requests when the transport closes", async () => {
    const transport = new MemoryTransport();
    const client = new McpClient({ transport });

    const pending = client.initialize();
    await transport.close();
    await expect(pending).rejects.toThrow("mcp transport closed");
  });
});
