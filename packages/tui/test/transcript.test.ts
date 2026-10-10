import { describe, expect, it } from "vitest";
import {
  emptyTranscript,
  reduceTranscript,
  type TranscriptState,
} from "../src/transcript.js";
import type { AgentEvent } from "@t3os/core";

const reduce = (events: AgentEvent[]): TranscriptState =>
  events.reduce<TranscriptState>(reduceTranscript, emptyTranscript());

describe("reduceTranscript", () => {
  it("records the user message and starts streaming", () => {
    const state = reduce([{ type: "user_message", text: "hi" }]);
    expect(state.entries).toEqual([{ kind: "user", text: "hi" }]);
    expect(state.status).toBe("streaming");
  });

  it("coalesces consecutive assistant text", () => {
    const state = reduce([
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ]);
    expect(state.entries).toEqual([
      { kind: "assistant", text: "Hello world" },
    ]);
  });

  it("pairs a tool result with its call", () => {
    const state = reduce([
      {
        type: "tool_call",
        id: "1",
        name: "read_file",
        args: { path: "a" },
        class: "read",
      },
      {
        type: "tool_result",
        id: "1",
        name: "read_file",
        ok: true,
        output: "ok",
      },
    ]);
    expect(state.entries).toEqual([
      {
        kind: "tool",
        id: "1",
        name: "read_file",
        cls: "read",
        args: { path: "a" },
        ok: true,
        output: "ok",
      },
    ]);
  });

  it("accumulates usage and records the turn end", () => {
    const state = reduce([
      { type: "usage", inputTokens: 10, outputTokens: 5 },
      { type: "usage", inputTokens: 1, outputTokens: 2 },
      { type: "turn_end", reason: "complete" },
    ]);
    expect(state.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(state.status).toBe("done");
    expect(state.reason).toBe("complete");
  });

  it("renders a detected loop as an error entry", () => {
    const state = reduce([
      { type: "loop_detected", name: "glob", argsHash: "abc", count: 3 },
    ]);
    expect(state.entries).toEqual([
      { kind: "error", scope: "tool", message: "loop detected: glob (3x)" },
    ]);
  });

  it("ignores events it does not render", () => {
    const state = reduce([
      {
        type: "permission_decision",
        id: "1",
        decision: "allow",
        mode: "ask",
        argsHash: "abc",
      },
    ]);
    expect(state.entries).toEqual([]);
  });
});
