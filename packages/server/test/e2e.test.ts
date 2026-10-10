import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MockProvider,
  SessionStore,
  createPolicy,
  runTurn,
  type AgentEvent,
  type Delta,
  type Tool,
} from "@t3os/core";
import { EventBus, createApp } from "../src/index.js";

const GOLDEN = fileURLToPath(
  new URL("../../core/test/fixtures/golden-transcript.jsonl", import.meta.url),
);

function normalizeEvents(events: AgentEvent[]): unknown[] {
  return events.map((event) => {
    switch (event.type) {
      case "tool_call":
        return { type: event.type, name: event.name, class: event.class };
      case "permission_decision":
        return { type: event.type, decision: event.decision, mode: event.mode };
      case "tool_result":
        return { type: event.type, name: event.name, ok: event.ok };
      default:
        return event;
    }
  });
}

const SCRIPTS: Delta[][] = [
  [
    { type: "tool_call_start", id: "c1", name: "echo" },
    { type: "tool_call_delta", id: "c1", argsJsonDelta: '{"text":"hi"}' },
    { type: "tool_call_end", id: "c1" },
    { type: "done" },
  ],
  [
    { type: "text", text: "Done." },
    { type: "usage", inputTokens: 12, outputTokens: 4 },
    { type: "done" },
  ],
];

const echoTool: Tool = {
  schema: {
    name: "echo",
    description: "Echo a string back.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  class: "read",
  async run(args) {
    return { ok: true, content: `echo: ${String(args.text)}` };
  },
};

interface Harness {
  url: string;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "t3os-e2e-"));
  const store = new SessionStore(dir);
  const bus = new EventBus();
  const runTurnImpl = async (args: {
    sessionId: string;
    prompt: string;
    onEvent: (event: AgentEvent) => void;
  }): Promise<{ reason: string }> => {
    const result = await runTurn({
      provider: new MockProvider(SCRIPTS),
      store,
      sessionId: args.sessionId,
      policy: createPolicy("auto-accept"),
      root: dir,
      tools: [echoTool],
      prompt: args.prompt,
      onEvent: args.onEvent,
    });
    return { reason: result.reason };
  };
  const handler = createApp({ store, bus, runTurn: runTurnImpl });
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("end-to-end turn over HTTP", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.close();
  });

  it("streams the golden event sequence as NDJSON", async () => {
    const created = await fetch(`${h.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "e2e" }),
    });
    const session = (await created.json()) as { id: string };

    const response = await fetch(`${h.url}/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "echo hi" }),
    });
    const text = await response.text();
    const events = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AgentEvent);

    const golden = (await readFile(GOLDEN, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);

    expect(normalizeEvents(events)).toEqual(golden);
  });
});
