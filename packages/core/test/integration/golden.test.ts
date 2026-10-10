import { describe, expect, it } from "vitest";
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
} from "../../src/index.js";

const GOLDEN = fileURLToPath(
  new URL("../fixtures/golden-transcript.jsonl", import.meta.url),
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

describe("golden transcript", () => {
  it("matches the committed event sequence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t3os-golden-"));
    const store = new SessionStore(dir);
    const session = await store.create("golden");
    const provider = new MockProvider(SCRIPTS);

    const result = await runTurn({
      provider,
      store,
      sessionId: session.id,
      policy: createPolicy("auto-accept"),
      root: dir,
      tools: [echoTool],
      prompt: "echo hi",
    });

    const normalized = normalizeEvents(result.events);
    const golden = (await readFile(GOLDEN, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);

    expect(normalized).toEqual(golden);
    expect(result.reason).toBe("complete");
  });
});
