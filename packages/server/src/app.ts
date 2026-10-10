import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentEvent, SessionStore } from "@t3os/core";
import type { EventBus } from "./events.js";

export type TurnRunner = (args: {
  sessionId: string;
  prompt: string;
  onEvent: (event: AgentEvent) => void;
}) => Promise<{ reason: string }>;

export interface AppDeps {
  store: SessionStore;
  bus: EventBus;
  runTurn: TurnRunner;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function createApp(
  deps: AppDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { store, bus, runTurn } = deps;

  return async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter((part) => part.length > 0);
    const method = req.method ?? "GET";

    if (method === "GET" && parts.length === 1 && parts[0] === "health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (parts[0] === "sessions") {
      if (method === "GET" && parts.length === 1) {
        sendJson(res, 200, await store.list());
        return;
      }

      if (method === "POST" && parts.length === 1) {
        const body = await readBody(req);
        if (body === undefined) {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        const title =
          typeof (body as { title?: unknown }).title === "string"
            ? (body as { title: string }).title
            : undefined;
        sendJson(res, 201, await store.create(title));
        return;
      }

      if (method === "GET" && parts.length === 2) {
        const id = parts[1]!;
        try {
          sendJson(res, 200, { id, events: await store.replay(id) });
        } catch {
          sendJson(res, 404, { error: "session not found" });
        }
        return;
      }

      if (method === "POST" && parts.length === 3 && parts[2] === "turns") {
        const id = parts[1]!;
        const body = await readBody(req);
        if (body === undefined) {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        const prompt =
          typeof (body as { prompt?: unknown }).prompt === "string"
            ? (body as { prompt: string }).prompt
            : "";
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        await runTurn({
          sessionId: id,
          prompt,
          onEvent: (event) => {
            bus.publish(id, event);
            res.write(`${JSON.stringify(event)}\n`);
          },
        });
        res.end();
        return;
      }
    }

    sendJson(res, 404, { error: "not found" });
  };
}
