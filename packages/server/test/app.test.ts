import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore, type AgentEvent } from "@t3os/core";
import { EventBus } from "../src/events.js";
import { createApp, type TurnRunner } from "../src/app.js";

interface Harness {
  url: string;
  store: SessionStore;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "t3os-srv-"));
  const store = new SessionStore(dir);
  const bus = new EventBus();
  const runTurn: TurnRunner = async ({ sessionId, prompt, onEvent }) => {
    const events: AgentEvent[] = [
      { type: "user_message", text: prompt },
      { type: "text", text: `echo:${prompt}` },
      { type: "turn_end", reason: "complete" },
    ];
    for (const event of events) {
      await store.append(sessionId, event);
      onEvent(event);
    }
    return { reason: "complete" };
  };
  const handle = createApp({ store, bus, runTurn });
  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("createApp", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    if (active) await active.close();
    active = undefined;
  });

  it("answers the health probe", async () => {
    active = await harness();
    const res = await fetch(`${active.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("creates and lists sessions", async () => {
    active = await harness();
    const created = await fetch(`${active.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "first" }),
    });
    expect(created.status).toBe(201);
    const meta = await created.json();
    expect(meta.title).toBe("first");

    const listed = await fetch(`${active.url}/sessions`);
    const rows = await listed.json();
    expect(rows.map((r: { id: string }) => r.id)).toContain(meta.id);
  });

  it("replays a session event log", async () => {
    active = await harness();
    const meta = await active.store.create("replay");
    await active.store.append(meta.id, { type: "user_message", text: "hi" });
    const res = await fetch(`${active.url}/sessions/${meta.id}`);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].type).toBe("user_message");
  });

  it("streams a turn as NDJSON", async () => {
    active = await harness();
    const meta = await active.store.create("turn");
    const res = await fetch(`${active.url}/sessions/${meta.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const text = await res.text();
    const events = text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as AgentEvent);
    expect(events.map((e) => e.type)).toEqual(["user_message", "text", "turn_end"]);
  });

  it("returns 404 for an unknown route", async () => {
    active = await harness();
    const res = await fetch(`${active.url}/nope`);
    expect(res.status).toBe(404);
  });
});
