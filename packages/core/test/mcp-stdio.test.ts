import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp/client.js";
import { StdioTransport } from "../src/mcp/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "mcp-echo-server.mjs");

describe("StdioTransport", () => {
  it(
    "spawns a server, lists its tools and calls one",
    async () => {
      const client = new McpClient({
        transport: new StdioTransport({ command: process.execPath, args: [fixture] }),
      });

      try {
        await client.initialize();
        expect(client.serverInfo.name).toBe("echo-fixture");

        const defs = await client.listTools();
        expect(defs).toHaveLength(1);
        expect(defs[0]!.name).toBe("echo");

        const tools = client.tools();
        expect(tools).toHaveLength(1);
        expect(tools[0]!.schema.name).toBe("mcp__echo");

        const result = await tools[0]!.run({ text: "world" }, { root: here });
        expect(result.ok).toBe(true);
        expect(result.content).toBe("echo:world");
      } finally {
        await client.close();
      }
    },
    15000,
  );
});
