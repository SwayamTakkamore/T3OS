import { describe, expect, it } from "vitest";
import { eventsToMessages } from "../src/agent/project.js";
import type { AgentEvent } from "../src/types.js";

describe("eventsToMessages", () => {
  it("projects a user prompt, a tool call, its result and the answer", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "hi" },
      { type: "tool_call", id: "c1", name: "read_file", args: { path: "a.txt" }, class: "read" },
      { type: "tool_result", id: "c1", name: "read_file", ok: true, output: "body" },
      { type: "text", text: "done" },
    ];

    expect(eventsToMessages(events)).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }],
      },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "body" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("coalesces consecutive text deltas into one assistant message", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "hi" },
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
    ];

    expect(eventsToMessages(events)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("appends several tool calls to the same assistant message", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "hi" },
      { type: "tool_call", id: "c1", name: "a", args: {}, class: "read" },
      { type: "tool_call", id: "c2", name: "b", args: {}, class: "read" },
    ];

    expect(eventsToMessages(events)).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "a", args: {} },
          { id: "c2", name: "b", args: {} },
        ],
      },
    ]);
  });

  it("ignores events that do not map to messages", () => {
    const events: AgentEvent[] = [
      { type: "user_message", text: "hi" },
      { type: "usage", inputTokens: 1, outputTokens: 2 },
      { type: "turn_end", reason: "complete" },
    ];

    expect(eventsToMessages(events)).toEqual([{ role: "user", content: "hi" }]);
  });
});
