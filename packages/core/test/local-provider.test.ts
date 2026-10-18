import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalModelId, resolvePreset } from "../src/presets/index.js";
import { GenerateFn, LocalProvider, renderPrompt } from "../src/provider/local.js";
import type { Delta, ToolSchema } from "../src/types.js";

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

  it("reports tool calling support (via fenced JSON tool blocks)", () => {
    const provider = new LocalProvider({ modelId: "google/gemma-2-2b-it", generate: fakeGenerate });
    expect(provider.capabilities().toolCalling).toBe(true);
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
    expect(received).toEqual({ cache_dir: "/tmp/t3os-hf-cache-test", dtype: "q4" });
  });

  it("passes dtype q4 so Transformers.js loads the quantized weights, not fp32", async () => {
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
    // Without `dtype`, @huggingface/transformers defaults to fp32 and resolves
    // onnx/decoder_model_merged.onnx — the unquantized 16 GB graph.
    expect(received).toMatchObject({ dtype: "q4" });
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
      // A usable cache must contain the quantized Q4 weights T3OS loads,
      // not just config — and never 0-byte placeholders.
      await writeFile(join(snapshotDir, "decoder_model_merged_q4.onnx"), Buffer.alloc(1024 * 1024, 1));
      await writeFile(join(snapshotDir, "decoder_model_merged_q4.onnx_data"), Buffer.alloc(1024 * 1024, 1));

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
      expect(received).toEqual({ cache_dir: hubDir, dtype: "q4" });
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
      await mkdir(join(snapshotDir, "onnx"), { recursive: true });
      await writeFile(join(snapshotDir, "config.json"), "{}", "utf8");
      // Non-empty Q4 ONNX weights are what makes the cache count as installed.
      await writeFile(join(snapshotDir, "onnx", "embed_tokens_q4.onnx"), Buffer.alloc(1024 * 1024, 1));
      await writeFile(join(snapshotDir, "onnx", "decoder_model_merged_q4.onnx"), Buffer.alloc(1024 * 1024, 1));
      await writeFile(join(snapshotDir, "onnx", "decoder_model_merged_q4.onnx_data"), Buffer.alloc(1024 * 1024, 1));

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
      // `local_files_only` keeps Transformers.js on the local filesystem cache
      // instead of re-downloading files that are already installed.
      expect(received).toEqual({ cache_dir: hubDir, dtype: "q4", local_files_only: true });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("passes cache_dir and local_files_only for an install at the flat org/repo layout", async () => {
    const previousHome = process.env.HOME;
    const home = await mkdtemp(join(tmpdir(), "t3os-hf-home-"));
    try {
      process.env.HOME = home;
      const hubDir = join(home, ".cache", "huggingface", "hub");
      // Files where Transformers.js's FileCache looks them up directly:
      // `${cache_dir}/onnx-community/gemma-3-4b-it-ONNX/<file>`.
      const flatDir = join(hubDir, "onnx-community", "gemma-3-4b-it-ONNX");
      await mkdir(join(flatDir, "onnx"), { recursive: true });
      await writeFile(join(flatDir, "config.json"), "{}", "utf8");
      await writeFile(join(flatDir, "onnx", "embed_tokens_q4.onnx"), Buffer.alloc(1024 * 1024, 1));
      await writeFile(join(flatDir, "onnx", "decoder_model_merged_q4.onnx"), Buffer.alloc(1024 * 1024, 1));
      await writeFile(join(flatDir, "onnx", "decoder_model_merged_q4.onnx_data"), Buffer.alloc(1024 * 1024, 1));

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
      expect(received).toEqual({ cache_dir: hubDir, dtype: "q4", local_files_only: true });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("creates the flat org/repo link before handing cache_dir to the pipeline", async () => {
    const previousHome = process.env.HOME;
    const home = await mkdtemp(join(tmpdir(), "t3os-hf-home-"));
    try {
      process.env.HOME = home;
      const hubDir = join(home, ".cache", "huggingface", "hub");
      const snapshotDir = join(hubDir, "models--onnx-community--gemma-3-4b-it-ONNX", "snapshots", "main");
      await mkdir(join(snapshotDir, "onnx"), { recursive: true });
      await writeFile(join(snapshotDir, "config.json"), "{}", "utf8");
      await writeFile(join(snapshotDir, "onnx", "embed_tokens_q4.onnx"), Buffer.alloc(1024 * 1024, 1));
      await writeFile(join(snapshotDir, "onnx", "decoder_model_merged_q4.onnx"), Buffer.alloc(1024 * 1024, 1));
      await writeFile(join(snapshotDir, "onnx", "decoder_model_merged_q4.onnx_data"), Buffer.alloc(1024 * 1024, 1));
      const flatPath = join(hubDir, "onnx-community", "gemma-3-4b-it-ONNX");

      let linkExistedDuringLoad = false;
      const provider = new LocalProvider({
        modelId: "google/gemma-3-4b-it",
        loadTransformers: async () => ({
          pipeline: async () => {
            try {
              const st = await lstat(flatPath);
              linkExistedDuringLoad = st.isSymbolicLink();
            } catch {
              linkExistedDuringLoad = false;
            }
            return endStreamImmediately();
          }
        })
      });

      await collect(provider.streamChat([{ role: "user", content: "hi" }], []));
      expect(linkExistedDuringLoad).toBe(true);
      expect(await realpath(flatPath)).toBe(await realpath(snapshotDir));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("omits local_files_only when no local install exists so the model can download", async () => {
    const previousHome = process.env.HOME;
    const home = await mkdtemp(join(tmpdir(), "t3os-hf-home-"));
    try {
      process.env.HOME = home;
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
      expect(received).toEqual({ dtype: "q4" });
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

  it("passes bigint[][] into streamer.put does not yield BigInts and does not throw serialization error", async () => {
    const provider = new LocalProvider({
      modelId: "google/gemma-3-4b-it",
      loadTransformers: async () => ({
        pipeline: async (_task: string, _modelId: string, opts?: unknown) => {
          return async (
            _prompt: string,
            options: { streamer: { put(value: unknown): void; end(): void } }
          ) => {
            // Simulate transformers passing bigint arrays to streamer
            options.streamer.put([[123n]] as any);
            options.streamer.end();
            return [];
          };
        }
      })
    });

    const deltas = await collect(provider.streamChat([{ role: "user", content: "hi" }], []));
    // Should not contain any BigInt values and should complete successfully
    const hasBigInt = deltas.some((d) => 
      JSON.stringify(d).includes("BigInt") || 
      (d.type === "text" && typeof d.text !== "string")
    );
    expect(hasBigInt).toBe(false);
    expect(deltas).toContainEqual({ type: "done" });
  });

  it("handles TextStreamer integration smoothly", async () => {
    const provider = new LocalProvider({
      modelId: "google/gemma-3-4b-it",
      loadTransformers: async () => ({
        pipeline: async (_task: string, _modelId: string, opts?: unknown) => {
          const generator = async (
            _prompt: string,
            options: { streamer: { put(value: unknown): void; end(): void } }
          ) => {
            options.streamer.put("hello");
            options.streamer.put(" world");
            options.streamer.end();
            return [{ generated_text: "hello world" }];
          };
          (generator as any).tokenizer = { decode: () => "test" };
          return generator;
        },
        TextStreamer: class MockTextStreamer {
          tokenizer: any;
          options: any;
          constructor(tokenizer: any, options: any) {
            this.tokenizer = tokenizer;
            this.options = options;
          }
          put(value: unknown) {
            // Simulate decoding
            if (this.options.callback_function && typeof value !== "object") {
              this.options.callback_function(String(value));
            }
          }
          end() {
            // no-op
          }
        }
      })
    });

    const deltas = await collect(provider.streamChat([{ role: "user", content: "hi" }], []));
    const textDeltas = deltas.filter((d) => d.type === "text");
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(deltas).toContainEqual({ type: "done" });
  });

  it("trims text at the preset stop token and stops the stream there", async () => {
    const provider = new LocalProvider({
      modelId: "google/gemma-3-4b-it",
      loadTransformers: async () => ({
        pipeline: async () =>
          async (
            _prompt: string,
            options: { streamer: { put(value: unknown): void; end(): void } }
          ) => {
            options.streamer.put("Hello");
            options.streamer.put(" world<end_of_turn>must not leak");
            options.streamer.put(" trailing chunk");
            options.streamer.end();
            return [];
          }
      })
    });

    const deltas = await collect(provider.streamChat([{ role: "user", content: "hi" }], []));
    expect(deltas).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
      { type: "done" }
    ]);
  });

  it("passes tools into the generation prompt", async () => {
    let seenPrompt = "";
    const generate: GenerateFn = async function* (prompt) {
      seenPrompt = prompt;
      yield "ok";
    };
    const provider = new LocalProvider({ modelId: "google/gemma-3-4b-it", generate });
    await collect(
      provider.streamChat([{ role: "user", content: "hi" }], [
        { name: "read_file", description: "Read a file", parameters: { type: "object" } }
      ])
    );
    expect(seenPrompt).toContain("read_file");
    expect(seenPrompt).toContain("Read a file");
    expect(seenPrompt).toContain("{ \"name\": \"<tool_name>\", \"arguments\": { ... } }");
  });

  it("detects a fenced JSON tool call and yields tool call deltas", async () => {
    async function* toolCallGenerator() {
      yield "Let me write that file.\n";
      yield '```json\n{"name":"write_file","arguments":{"path":"a.ts","content":"x"}}\n```';
    }
    const provider = new LocalProvider({
      modelId: "google/gemma-3-4b-it",
      generate: toolCallGenerator
    });
    const tools: ToolSchema[] = [
      { name: "write_file", description: "Write a file", parameters: { type: "object" } }
    ];
    const deltas = await collect(provider.streamChat([{ role: "user", content: "write a.ts" }], tools));

    const start = deltas.find((d) => d.type === "tool_call_start");
    expect(start).toMatchObject({ type: "tool_call_start", name: "write_file" });
    const id = (start as Extract<Delta, { type: "tool_call_start" }>).id;
    expect(deltas).toEqual([
      { type: "text", text: "Let me write that file.\n" },
      { type: "tool_call_start", id, name: "write_file" },
      { type: "tool_call_delta", id, argsJsonDelta: '{"path":"a.ts","content":"x"}' },
      { type: "tool_call_end", id },
      { type: "done" }
    ]);
  });

  it("handles a tool call split across streamed chunks", async () => {
    async function* chunkedToolCall() {
      yield "Calling ";
      yield "```js";
      yield 'on\n{"name":"re';
      yield 'ad_file","arguments":{"path":"b.ts"}}\n';
      yield "```";
    }
    const provider = new LocalProvider({
      modelId: "google/gemma-3-4b-it",
      generate: chunkedToolCall
    });
    const tools: ToolSchema[] = [
      { name: "read_file", description: "Read a file", parameters: { type: "object" } }
    ];
    const deltas = await collect(provider.streamChat([{ role: "user", content: "read b.ts" }], tools));

    const start = deltas.find((d) => d.type === "tool_call_start") as Extract<
      Delta,
      { type: "tool_call_start" }
    >;
    expect(start.name).toBe("read_file");
    const argDelta = deltas.find((d) => d.type === "tool_call_delta") as Extract<
      Delta,
      { type: "tool_call_delta" }
    >;
    expect(JSON.parse(argDelta.argsJsonDelta)).toEqual({ path: "b.ts" });
    expect(deltas.at(-1)).toEqual({ type: "done" });
    // The text preceding the fence is preserved, the fence itself is not.
    const text = deltas
      .filter((d): d is Extract<Delta, { type: "text" }> => d.type === "text")
      .map((d) => d.text)
      .join("");
    expect(text).toBe("Calling ");
  });

  it("emits a matching tool call when the fence is unterminated at stream end", async () => {
    async function* unterminatedToolCall() {
      yield '```json\n{"name":"read_file","arguments":{"path":"c.ts"}}';
    }
    const provider = new LocalProvider({
      modelId: "google/gemma-3-4b-it",
      generate: unterminatedToolCall
    });
    const tools: ToolSchema[] = [
      { name: "read_file", description: "Read a file", parameters: { type: "object" } }
    ];
    const deltas = await collect(provider.streamChat([{ role: "user", content: "read c.ts" }], tools));
    expect(deltas.filter((d) => d.type === "text")).toEqual([]);
    const start = deltas.find((d) => d.type === "tool_call_start") as Extract<
      Delta,
      { type: "tool_call_start" }
    >;
    expect(start.name).toBe("read_file");
    expect(deltas.at(-1)).toEqual({ type: "done" });
  });

  it("passes a fenced JSON block through as text when the tool is unknown", async () => {
    async function* unknownToolCall() {
      yield '```json\n{"name":"no_such_tool","arguments":{}}\n```';
    }
    const provider = new LocalProvider({
      modelId: "google/gemma-3-4b-it",
      generate: unknownToolCall
    });
    const tools: ToolSchema[] = [
      { name: "read_file", description: "Read a file", parameters: { type: "object" } }
    ];
    const deltas = await collect(provider.streamChat([{ role: "user", content: "hi" }], tools));
    expect(deltas.some((d) => d.type === "tool_call_start")).toBe(false);
    const text = deltas
      .filter((d): d is Extract<Delta, { type: "text" }> => d.type === "text")
      .map((d) => d.text)
      .join("");
    expect(text).toContain('"name":"no_such_tool"');
  });
});

describe("renderPrompt with tools", () => {
  const tools: ToolSchema[] = [
    {
      name: "write_file",
      description: "Write a file to disk",
      parameters: { type: "object", properties: { path: { type: "string" } } }
    },
    {
      name: "execute",
      description: "Run a shell command",
      parameters: { type: "object", properties: { command: { type: "string" } } }
    }
  ];

  it("includes tool names, descriptions, and parameter schemas in the prompt", () => {
    const preset = resolvePreset("google/gemma-3-4b-it");
    const prompt = renderPrompt([{ role: "user", content: "create a file" }], preset, tools);
    expect(prompt).toContain("write_file");
    expect(prompt).toContain("Write a file to disk");
    expect(prompt).toContain("execute");
    expect(prompt).toContain("Run a shell command");
    expect(prompt).toContain('{"type":"object","properties":{"path":{"type":"string"}}}');
    expect(prompt).toContain('{ "name": "<tool_name>", "arguments": { ... } }');
    expect(prompt).toContain("Never tell the user to manually save or edit files");
    // Instructions land inside a user turn, ahead of the open model turn.
    expect(prompt.indexOf("write_file")).toBeLessThan(prompt.indexOf("<start_of_turn>model"));
  });

  it("formats tool messages as user turns and prior tool calls inside the model turn", () => {
    const preset = resolvePreset("google/gemma-3-4b-it");
    const prompt = renderPrompt(
      [
        { role: "user", content: "write a.ts" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "write_file", args: { path: "a.ts" } }]
        },
        { role: "tool", name: "write_file", toolCallId: "c1", content: "wrote a.ts" }
      ],
      preset,
      tools
    );
    expect(prompt).toContain("<start_of_turn>user\n[Tool Result for write_file]: wrote a.ts<end_of_turn>");
    // The assistant's previous invocation is re-rendered in the model turn.
    const modelIdx = prompt.indexOf("<start_of_turn>model\n```json");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(prompt).toContain('{"name":"write_file","arguments":{"path":"a.ts"}}');
    expect(prompt.indexOf('[Tool Result for write_file]')).toBeGreaterThan(modelIdx);
  });

  it("formats tool results as user turns in the generic template", () => {
    const preset = resolvePreset("some/other-model");
    const prompt = renderPrompt(
      [
        { role: "user", content: "read b.ts" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "execute", args: { command: "cat b.ts" } }]
        },
        { role: "tool", name: "execute", toolCallId: "c1", content: "contents of b.ts" }
      ],
      preset,
      tools
    );
    expect(prompt).toContain("user: [Tool Result for execute]: contents of b.ts");
    expect(prompt).toContain('{"name":"execute","arguments":{"command":"cat b.ts"}}');
    expect(prompt.endsWith("\nassistant:")).toBe(true);
  });

  it("includes conversational vs action mode guidance in tool instructions", () => {
    const preset = resolvePreset("google/gemma-3-4b-it");
    const prompt = renderPrompt([{ role: "user", content: "h" }], preset, tools);
    expect(prompt).toContain("Guidelines on when to use tools vs conversational replies:");
    expect(prompt).toContain("Conversational responses");
    expect(prompt).toContain("Action requests");
    expect(prompt).toContain("Do NOT invoke any tools");
  });

  it("maintains strictly alternating turns without back-to-back user turns in Gemma chat template", () => {
    const preset = resolvePreset("google/gemma-3-4b-it");
    const prompt = renderPrompt([{ role: "user", content: "hi" }], preset, tools);
    // There must be no consecutive user turns: <end_of_turn>\n<start_of_turn>user
    expect(prompt).not.toContain("<end_of_turn>\n<start_of_turn>user");
    // Ensure the single user turn ends and is followed by the model turn
    expect(prompt).toMatch(/<start_of_turn>user\n[\s\S]*\n\n---\n\nhi<end_of_turn>\n<start_of_turn>model\n$/);
  });

  it("leaves the prompt unchanged when no tools are provided", () => {
    const preset = resolvePreset("google/gemma-3-4b-it");
    const withUndefined = renderPrompt([{ role: "user", content: "hi" }], preset);
    const withEmpty = renderPrompt([{ role: "user", content: "hi" }], preset, []);
    expect(withUndefined).toBe(withEmpty);
    expect(withUndefined).not.toContain("<tool_name>");
    expect(withUndefined).toBe("<start_of_turn>user\nhi<end_of_turn>\n<start_of_turn>model\n");
  });
});

describe("renderPrompt fallback", () => {
  it("never starts the gemma prompt with an empty model turn when there are no messages", () => {
    const preset = resolvePreset("google/gemma-3-4b-it");
    const prompt = renderPrompt([], preset);
    expect(prompt).not.toBe("<start_of_turn>model\n");
    const userTurn = prompt.indexOf("<start_of_turn>user");
    const modelTurn = prompt.indexOf("<start_of_turn>model");
    expect(userTurn).toBeGreaterThanOrEqual(0);
    expect(userTurn).toBeLessThan(modelTurn);
  });

  it("renders a user turn for an empty history with the generic template", () => {
    const preset = resolvePreset("some/other-model");
    const prompt = renderPrompt([], preset);
    expect(prompt.startsWith("user:")).toBe(true);
    expect(prompt.endsWith("assistant:")).toBe(true);
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
