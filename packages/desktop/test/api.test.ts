import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { DesktopClient } from "../src/api.js";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
  received: string[];
}

async function harness(): Promise<Harness> {
  const received: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/sessions" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }
    if (req.url === "/sessions" && req.method === "POST") {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "s1",
          title: "t",
          createdAt: "now",
          updatedAt: "now",
          eventCount: 0,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  wss.on("connection", (ws) => {
    received.push("connected");
    ws.send(JSON.stringify({ type: "text", text: "hi" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    received,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("DesktopClient", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.close();
  });

  it("reports health", async () => {
    const client = new DesktopClient({ baseUrl: h.baseUrl });
    await expect(client.health()).resolves.toEqual({ ok: true });
  });

  it("lists sessions", async () => {
    const client = new DesktopClient({ baseUrl: h.baseUrl });
    await expect(client.listSessions()).resolves.toEqual([]);
  });

  it("creates a session", async () => {
    const client = new DesktopClient({ baseUrl: h.baseUrl });
    const session = await client.createSession("t");
    expect(session.id).toBe("s1");
  });

  it("subscribes to the event stream", async () => {
    const client = new DesktopClient({ baseUrl: h.baseUrl });
    const events: string[] = [];
    const states: string[] = [];
    const unsubscribe = client.subscribe(
      "s1",
      (event) => events.push(event.type),
      (state) => states.push(state),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    unsubscribe();
    expect(events).toContain("text");
    expect(states).toContain("open");
  });
});
