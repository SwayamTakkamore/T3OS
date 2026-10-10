import { describe, expect, it } from "vitest";
import { toErrorEvent, T3osError } from "../src/errors.js";
import type { AgentEvent, Delta } from "../src/types.js";

describe("domain types", () => {
  it("narrows a text delta", () => {
    const d: Delta = { type: "text", text: "hi" };
    expect(d.type === "text" && d.text).toBe("hi");
  });

  it("narrows a tool_result event", () => {
    const e: AgentEvent = {
      type: "tool_result", id: "1", name: "read_file", ok: true, output: "x"
    };
    expect(e.type === "tool_result" && e.ok).toBe(true);
  });

  it("converts an error into an event with a scope", () => {
    const e = toErrorEvent(new T3osError("provider", "rate limited"), "provider");
    expect(e).toEqual({ type: "error", scope: "provider", message: "rate limited" });
  });

  it("scopes a non-T3osError underneath the given scope", () => {
    const e = toErrorEvent(new Error("boom"), "tool");
    expect(e).toEqual({ type: "error", scope: "tool", message: "boom" });
  });
});
