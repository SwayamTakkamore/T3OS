import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import type { SessionStore } from "@t3os/core";
import { createApp, type TurnRunner } from "./app.js";
import { EventBus } from "./events.js";

export interface ServerOptions {
  store: SessionStore;
  runTurn: TurnRunner;
  port?: number;
  host?: string;
}

export interface RunningServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const bus = new EventBus();
  const handle = createApp({ store: options.store, bus, runTurn: options.runTurn });

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter((part) => part.length > 0);
    if (parts.length === 3 && parts[0] === "sessions" && parts[2] === "stream") {
      const sessionId = parts[1]!;
      wss.handleUpgrade(req, socket, head, (ws) => {
        const unsubscribe = bus.subscribe(sessionId, (event) => {
          ws.send(JSON.stringify(event));
        });
        ws.on("close", unsubscribe);
      });
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    url: `http://${host}:${port}`,
    async close() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
