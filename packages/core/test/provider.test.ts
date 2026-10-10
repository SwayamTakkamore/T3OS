import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HuggingFaceProvider } from "../src/provider/huggingface.js";
import { MockProvider } from "../src/provider/mock.js";
import { parseSseChunks } from "../src/provider/sse.js";
import type { Delta } from "../src/types.js";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name), "utf8");

const collect = async (iter: AsyncIterable<Delta>): Promise<Delta[]> => {
  const out: Delta[] = [];
  for await (const d of iter) out.push(d);
  return out;
};

describe("parseSseChunks", () => {
  it("splits data events and drops the DONE sentinel", () => {
    const events = parseSseChunks(["data: {\"a\":1}\n\ndata: [DONE]\n\n"]);
    expect(events.map((e) => e.data)).toEqual(['{"a":1}']);
  });

  it("reassembles an event split across chunks", () => {
    const events = parseSseChunks(["data: {\"a\"", ":1}\n\n"]);
    expect(events.map((e) => e.data)).toEqual(['{"a":1}']);
  });
});

describe("HuggingFaceProvider", () => {
  it("maps a text stream to text/usage/done deltas", async () => {
    const fetchImpl = (async () =>
      new Response(fixture("hf-text.sse"), { status: 200 })) as unknown as typeof fetch;
    const provider = new HuggingFaceProvider({ model: "google/gemma-2-9b-it", token: "t", fetchImpl });
    const deltas = await collect(provider.streamChat([{ role: "user", content: "hi" }], []));
    expect(deltas).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
      { type: "usage", inputTokens: 12, outputTokens: 3 },
      { type: "done" }
    ]);
  });

  it("maps a tool-call stream to tool_call deltas", async () => {
    const fetchImpl = (async () =>
      new Response(fixture("hf-toolcall.sse"), { status: 200 })) as unknown as typeof fetch;
    const provider = new HuggingFaceProvider({ model: "m", token: "t", fetchImpl });
    const deltas = await collect(
      provider.streamChat([{ role: "user", content: "read a.txt" }], [
        { name: "read_file", description: "read", parameters: {} }
      ])
    );
    expect(deltas).toEqual([
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", id: "call_1", argsJsonDelta: '{"path":' },
      { type: "tool_call_delta", id: "call_1", argsJsonDelta: '"a.txt"}' },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" }
    ]);
  });

  it("surfaces a non-200 response as a provider error", async () => {
    const fetchImpl = (async () =>
      new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const provider = new HuggingFaceProvider({ model: "m", token: "bad", fetchImpl });
    await expect(collect(provider.streamChat([{ role: "user", content: "x" }], []))).rejects.toThrow(
      /401/
    );
  });
});

describe("MockProvider", () => {
  it("yields one scripted turn per streamChat call", async () => {
    const mock = new MockProvider([
      [{ type: "text", text: "a" }, { type: "done" }],
      [{ type: "text", text: "b" }, { type: "done" }]
    ]);
    expect(await collect(mock.streamChat([], []))).toEqual([{ type: "text", text: "a" }, { type: "done" }]);
    expect(await collect(mock.streamChat([], []))).toEqual([{ type: "text", text: "b" }, { type: "done" }]);
  });

  it("reports tool calling capability", () => {
    expect(new MockProvider([]).capabilities().toolCalling).toBe(true);
  });
});
