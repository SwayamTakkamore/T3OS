import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTurn } from "../src/agent/loop.js";
import { createPolicy } from "../src/permissions/policy.js";
import { MockProvider } from "../src/provider/mock.js";
import { SessionStore } from "../src/sessions/store.js";
import type { Tool } from "../src/tools/types.js";
import type { Delta } from "../src/types.js";

describe("runTurn", () => {
  it("runs a text-only turn and records it in the log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t3os-agent-"));
    const sessions = new SessionStore(dir);
    const session = await sessions.create("agent");
    const provider = new MockProvider([
      [
        { type: "text", text: "hello" },
        { type: "usage", inputTokens: 3, outputTokens: 2 },
        { type: "done" },
      ],
    ]);

    const result = await runTurn({
      provider,
      store: sessions,
      sessionId: session.id,
      policy: createPolicy("ask"),
      root: dir,
      prompt: "hi",
    });

    expect(result.reason).toBe("complete");
    expect(result.text).toBe("hello");
    expect(result.steps).toBe(1);
    expect(result.inputTokens).toBe(3);
    expect(result.outputTokens).toBe(2);

    const replayed = await sessions.replay(session.id);
    expect(replayed.map((event) => event.type)).toEqual([
      "user_message",
      "text",
      "usage",
      "turn_end",
    ]);
  });

  it("executes a permitted read tool and feeds the result back to the provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t3os-agent-"));
    const sessions = new SessionStore(dir);
    const session = await sessions.create("agent");

    const seen: string[] = [];
    const echo: Tool = {
      schema: { name: "echo", description: "echo", parameters: { type: "object" } },
      class: "read",
      async run(args) {
        const a = args as { value?: unknown };
        seen.push(String(a.value));
        return { ok: true, content: `echo:${String(a.value)}` };
      },
    };

    const provider = new MockProvider([
      [
        { type: "tool_call_start", id: "c1", name: "echo" },
        { type: "tool_call_delta", id: "c1", argsJsonDelta: '{"value":"x"}' },
        { type: "tool_call_end", id: "c1" },
        { type: "done" },
      ],
      [
        { type: "text", text: "final" },
        { type: "done" },
      ],
    ]);

    const result = await runTurn({
      provider,
      store: sessions,
      sessionId: session.id,
      policy: createPolicy("auto-accept"),
      root: dir,
      tools: [echo],
      prompt: "go",
    });

    expect(seen).toEqual(["x"]);
    expect(result.reason).toBe("complete");
    expect(result.text).toBe("final");
    expect(result.steps).toBe(2);

    const types = (await sessions.replay(session.id)).map((event) => event.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("permission_decision");
    expect(types).toContain("tool_result");
  });

  it("asks before running a write tool and honours a denial", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t3os-agent-"));
    const sessions = new SessionStore(dir);
    const session = await sessions.create("agent");

    let ran = false;
    const writer: Tool = {
      schema: { name: "writer", description: "write", parameters: { type: "object" } },
      class: "write",
      async run() {
        ran = true;
        return { ok: true, content: "wrote" };
      },
    };

    const provider = new MockProvider([
      [
        { type: "tool_call_start", id: "c1", name: "writer" },
        { type: "tool_call_delta", id: "c1", argsJsonDelta: "{}" },
        { type: "tool_call_end", id: "c1" },
        { type: "done" },
      ],
      [
        { type: "text", text: "ok" },
        { type: "done" },
      ],
    ]);

    let asked = 0;
    const result = await runTurn({
      provider,
      store: sessions,
      sessionId: session.id,
      policy: createPolicy("ask"),
      root: dir,
      tools: [writer],
      prompt: "write",
      onPermission: async () => {
        asked += 1;
        return "deny";
      },
    });

    expect(asked).toBe(1);
    expect(ran).toBe(false);
    expect(result.reason).toBe("complete");

    const replayed = await sessions.replay(session.id);
    const decision = replayed.find((event) => event.type === "permission_decision");
    expect(decision && decision.type === "permission_decision" ? decision.decision : undefined).toBe(
      "deny",
    );

    const toolResult = replayed.find((event) => event.type === "tool_result");
    expect(toolResult && toolResult.type === "tool_result" ? toolResult.ok : true).toBe(false);
  });

  it("remembers a session-wide approval for the same call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t3os-agent-"));
    const sessions = new SessionStore(dir);
    const session = await sessions.create("agent");

    let runs = 0;
    const writer: Tool = {
      schema: { name: "writer", description: "write", parameters: { type: "object" } },
      class: "write",
      async run() {
        runs += 1;
        return { ok: true, content: "wrote" };
      },
    };

    const call: Delta[] = [
      { type: "tool_call_start", id: "c1", name: "writer" },
      { type: "tool_call_delta", id: "c1", argsJsonDelta: "{}" },
      { type: "tool_call_end", id: "c1" },
      { type: "done" },
    ];
    const answer: Delta[] = [
      { type: "text", text: "done" },
      { type: "done" },
    ];

    const provider = new MockProvider([call, call, answer]);

    let asked = 0;
    await runTurn({
      provider,
      store: sessions,
      sessionId: session.id,
      policy: createPolicy("ask"),
      root: dir,
      tools: [writer],
      prompt: "write twice",
      onPermission: async () => {
        asked += 1;
        return "session";
      },
    });

    expect(asked).toBe(1);
    expect(runs).toBe(2);
  });

  it("stops the turn when a tool call repeats past the limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t3os-agent-"));
    const sessions = new SessionStore(dir);
    const session = await sessions.create("agent");

    const echo: Tool = {
      schema: { name: "echo", description: "echo", parameters: { type: "object" } },
      class: "read",
      async run() {
        return { ok: true, content: "again" };
      },
    };

    const call: Delta[] = [
      { type: "tool_call_start", id: "c1", name: "echo" },
      { type: "tool_call_delta", id: "c1", argsJsonDelta: "{}" },
      { type: "tool_call_end", id: "c1" },
      { type: "done" },
    ];

    const provider = new MockProvider([call, call, call, call, call]);

    const result = await runTurn({
      provider,
      store: sessions,
      sessionId: session.id,
      policy: createPolicy("auto-accept"),
      root: dir,
      tools: [echo],
    });

    expect(result.reason).toBe("loop");
    const replayed = await sessions.replay(session.id);
    expect(replayed.some((event) => event.type === "loop_detected")).toBe(true);
  });
});
