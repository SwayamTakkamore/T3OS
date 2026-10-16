import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalModelId } from "../src/presets/index.js";
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

/** A generator that terminates the stream immediately, for load-only tests. */const endStreamImmediately = () =>
  async (
    _prompt: string,
    opts: { streamer: { put(value: string): void; end(): void } }
  ): Promise<void> => {
    opts.streamer.end();
  };


/** Streams a single turn, returning the error instead of throwing. */
const streamError = async (provider: LocalProvider): Promise<unknown> => {
  try {
    await collect(provider.streamChat([{ role: "user", content: "hi" }], []));
    return undefined;
  } catch (err) {
    return err;
  }
};

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

  it("sets process.env.HF_TOKEN from the token option before loading the pipeline", async () => {
    const previous = process.env.HF_TOKEN;
    delete process.env.HF_TOKEN;
    let seen: string | undefined;
    try {
      const provider = new LocalProvider({
        modelId: "google/gemma-3-4b-it",
        token: "hf_local_provider_test",
        loadTransformers: async () => ({
          pipeline: async () => {
            seen = process.env.HF_TOKEN;
            return endStreamImmediately();
          }
        })
      });
      await collect(provider.streamChat([{ role: "user", content: "hi" }], []));
      expect(seen).toBe("hf_local_provider_test");
    } finally {
      if (previous === undefined) delete process.env.HF_TOKEN;
      else process.env.HF_TOKEN = previous;
    }
  });

  it.each([
    ["Unauthorized access to file: https://huggingface.co/google/gemma-3-4b-it/resolve/main/config.json"],
    ["401 Unauthorized"],
    ["403 Forbidden"],
    ["Cannot access gated repo for url https://huggingface.co/google/gemma-3-4b-it/resolve/main/model.safetensors"]
  ])("wraps gated-model failures with actionable guidance: %s", async (message) => {
    const provider = new LocalProvider({
      modelId: "google/gemma-3-4b-it",
      loadTransformers: async () => ({
        pipeline: async () => {
          throw new Error(message);
        }
      })
    });

    const err = (await streamError(provider)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("https://huggingface.co/google/gemma-3-4b-it");
    expect(err.message).toMatch(/gated/i);
    expect(err.message).toContain("t3os auth login");
  });

  it("passes cache_dir to the transformers pipeline when cacheDir is configured", async () => {
    let received: unknown;
    const provider = new LocalProvider({
      modelId: "google/gemma-3-4b-it",
      cacheDir: "/tmp/t3os-hf-cache-test",
      loadTransformers: async () => ({
        pipeline: async (_task: string, _modelId: string, opts?: unknown) => {
          received = opts;
          return endStreamImmediately();
        }
      })
    });

    await collect(provider.streamChat([{ role: "user", content: "hi" }], []));
    expect(received).toEqual({ cache_dir: "/tmp/t3os-hf-cache-test" });
  });

  it("detects an installed model in the Hugging Face hub cache and passes its cache_dir", async () => {
    const previousHome = process.env.HOME;
    const home = await mkdtemp(join(tmpdir(), "t3os-hf-home-"));
    try {
      process.env.HOME = home;
      const hubDir = join(home, ".cache", "huggingface", "hub");
      const snapshotDir = join(hubDir, "models--google--gemma-3-4b-it", "snapshots", "main");
      await mkdir(snapshotDir, { recursive: true });
      await writeFile(join(snapshotDir, "config.json"), "{}", "utf8");

      let received: unknown;
      const provider = new LocalProvider({
        modelId: "google/gemma-3-4b-it",
        loadTransformers: async () => ({
          pipeline: async (_task: string, _modelId: string, opts?: unknown) => {
            received = opts;
            return endStreamImmediately();
          }
        })
      });

      await collect(provider.streamChat([{ role: "user", content: "hi" }], []));
      expect(received).toEqual({ cache_dir: hubDir });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("maps Gemma model ids to their ONNX-converted repos before invoking the pipeline", async () => {
    let receivedModelId: string | undefined;
    const provider = new LocalProvider({
      modelId: "google/gemma-3-4b-it",
      loadTransformers: async () => ({
        pipeline: async (_task: string, modelId: string) => {
          receivedModelId = modelId;
          return endStreamImmediately();
        }
      })
    });

    await collect(provider.streamChat([{ role: "user", content: "hi" }], []));
    expect(receivedModelId).toBe("onnx-community/gemma-3-4b-it-ONNX");
  });

  it("resolves aliases before mapping to the ONNX repo", async () => {
    let receivedModelId: string | undefined;
    const provider = new LocalProvider({
      modelId: "gemma-3-4b",
      loadTransformers: async () => ({
        pipeline: async (_task: string, modelId: string) => {
          receivedModelId = modelId;
          return endStreamImmediately();
        }
      })
    });

    await collect(provider.streamChat([{ role: "user", content: "hi" }], []));
    expect(receivedModelId).toBe("onnx-community/gemma-3-4b-it-ONNX");
  });

  it("passes unmapped model ids through to the pipeline unchanged", async () => {
    let receivedModelId: string | undefined;
    const provider = new LocalProvider({
      modelId: "org/custom-model",
      loadTransformers: async () => ({
        pipeline: async (_task: string, modelId: string) => {
          receivedModelId = modelId;
          return endStreamImmediately();
        }
      })
    });

    await collect(provider.streamChat([{ role: "user", content: "hi" }], []));
    expect(receivedModelId).toBe("org/custom-model");
  });

  it("wraps missing ONNX weight failures with actionable guidance", async () => {
    const provider = new LocalProvider({
      modelId: "google/gemma-3-4b-it",
      loadTransformers: async () => ({
        pipeline: async () => {
          throw new Error(
            'Could not locate file: "https://huggingface.co/google/gemma-3-4b-it/resolve/main/onnx/embed_tokens.onnx"'
          );
        }
      })
    });

    const err = (await streamError(provider)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/ONNX/i);
    expect(err.message).toMatch(/transformers\.js/i);
    expect(err.message).toContain("onnx-community/gemma-3-4b-it-ONNX");
  });

  it("detects an installed ONNX repo in the hub cache and passes its cache_dir", async () => {
    const previousHome = process.env.HOME;
    const home = await mkdtemp(join(tmpdir(), "t3os-hf-home-"));
    try {
      process.env.HOME = home;
      const hubDir = join(home, ".cache", "huggingface", "hub");
      const snapshotDir = join(hubDir, "models--onnx-community--gemma-3-4b-it-ONNX", "snapshots", "main");
      await mkdir(snapshotDir, { recursive: true });
      await writeFile(join(snapshotDir, "config.json"), "{}", "utf8");

      let received: unknown;
      const provider = new LocalProvider({
        modelId: "google/gemma-3-4b-it",
        loadTransformers: async () => ({
          pipeline: async (_task: string, _modelId: string, opts?: unknown) => {
            received = opts;
            return endStreamImmediately();
          }
        })
      });

      await collect(provider.streamChat([{ role: "user", content: "hi" }], []));
      expect(received).toEqual({ cache_dir: hubDir });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("leaves non-auth pipeline failures intact apart from the model context", async () => {
    const provider = new LocalProvider({
      modelId: "google/gemma-3-4b-it",
      loadTransformers: async () => ({
        pipeline: async () => {
          throw new Error("ONNX runtime: could not allocate buffer");
        }
      })
    });

    const err = (await streamError(provider)) as Error;
    expect(err.message).toContain("ONNX runtime: could not allocate buffer");
    expect(err.message).not.toMatch(/gated/i);
  });
});

describe("resolveLocalModelId", () => {
  it.each([
    ["google/gemma-3-4b-it", "onnx-community/gemma-3-4b-it-ONNX"],
    ["google/gemma-3-1b-it", "onnx-community/gemma-3-1b-it-ONNX"],
    ["google/gemma-3-270m-it", "onnx-community/gemma-3-270m-it-ONNX"],
    ["google/gemma-4-E2B-it", "onnx-community/gemma-4-E2B-it-ONNX"],
    ["google/gemma-4-E4B-it", "onnx-community/gemma-4-E4B-it-ONNX"],
    ["google/gemma-4-26B-A4B-it", "justinchuby/gemma-4-26b-a4b-it-onnx"],
    ["google/gemma-2-9b-it", "onnx-community/gemma-2-9b-it-ONNX-DirectML-GenAI-INT4"],
    ["google/gemma-2-2b-it", "onnx-community/gemma-2-2b-jpn-it"],
  ])("maps %s to %s", (input, expected) => {
    expect(resolveLocalModelId(input)).toBe(expected);
  });

  it("normalises aliases before mapping to the ONNX repo", () => {
    expect(resolveLocalModelId("gemma-3-4b")).toBe("onnx-community/gemma-3-4b-it-ONNX");
    expect(resolveLocalModelId("gemma-2-9b")).toBe("onnx-community/gemma-2-9b-it-ONNX-DirectML-GenAI-INT4");
  });

  it("passes unmapped ids through unchanged", () => {
    expect(resolveLocalModelId("org/custom-model")).toBe("org/custom-model");
    expect(resolveLocalModelId("google/gemma-3-27b-it")).toBe("google/gemma-3-27b-it");
  });
});
