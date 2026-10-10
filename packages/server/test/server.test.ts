import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { SessionStore, type AgentEvent } from "@t3os/core";
import { startServer, type RunningServer } from "../src/server.js";
import type { TurnRunner } from "../src/app.js";

describe("startServer", () => {
  let active: RunningServer | undefined;
  afterEach(async () => {
    if (active) await active.close();
    active = undefined;
  });

  it("fans a turn out over the WebSocket stream", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t3os-ws-"));
    const store = new SessionStore(dir);
    const meta = await store.create("ws");

    const runTurn: TurnRunner = async ({ prompt, onEvent }) => {
      onEvent({ type: "user_message", text: prompt });
      onEvent({ type: "turn_end", reason: "complete" });
      return { reason: "complete" };
    };

    active = await startServer({ store, runTurn });

    const socket = new WebSocket(`${active.url.replace("http", "ws")}/sessions/${meta.id}/stream`);
    const received: AgentEvent[] = [];
    const done = new Promise<void>((resolve) => {
      socket.on("message", (raw) => {
        const event = JSON.parse(raw.toString()) as AgentEvent;
        received.push(event);
        if (event.type === "turn_end") resolve();
      });
    });
    await new Promise<void>((resolve) => socket.on("open", () => resolve()));

    await fetch(`${active.url}/sessions/${meta.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "stream me" }),
    });

    await done;
    socket.close();
    expect(received.map((e) => e.type)).toEqual(["user_message", "turn_end"]);
  });
});
