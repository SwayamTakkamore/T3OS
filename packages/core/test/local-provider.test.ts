import { describe, expect, it } from "vitest";
import { LocalProvider } from "../src/provider/local.js";
import type { Delta } from "../src/types.js";

const collect = async (iter: AsyncIterable<Delta>): Promise<Delta[]> => {
  const out: Delta[] = [];
  for await (const d of iter) out.push(d);
  return out;
};

async function* fakeGenerate() {
  yield "loc";
  yield "al";
}

describe("LocalProvider", () => {
  it("maps an injected generator to text deltas then done", async () => {
    const provider = new LocalProvider({ modelId: "google/gemma-2-2b-it", generate: fakeGenerate });
    const deltas = await collect(provider.streamChat([{ role: "user", content: "hi" }], []));
    expect(deltas).toEqual([
      { type: "text", text: "loc" },
      { type: "text", text: "al" },
      { type: "done" }
    ]);
  });

  it("reports no tool calling for a raw local generator", () => {
    const provider = new LocalProvider({ modelId: "google/gemma-2-2b-it", generate: fakeGenerate });
    expect(provider.capabilities().toolCalling).toBe(false);
  });

  it("fails gracefully with helpful message when @huggingface/transformers is missing", async () => {
    const provider = new LocalProvider({
      modelId: "google/gemma-2-2b-it",
      loadTransformers: async () => {
        throw new Error("Cannot find package '@huggingface/transformers'");
      }
    });
    await expect(async () => {
      for await (const _ of provider.streamChat([{ role: "user", content: "hi" }], [])) {
        // stream
      }
    }).rejects.toThrow(/Failed to load @huggingface\/transformers/);
  });
});
