import { join, sep } from "node:path";
import { homedir } from "node:os";
import { resolveLocalModelId, resolvePreset, type ModelPreset } from "../presets/index.js";
import type { Delta, Message, ToolSchema } from "../types.js";
import { checkLocalModelInstalled, ensureFlatCacheLink } from "./localModel.js";
import type { Provider, ProviderCapabilities, StreamOptions } from "./types.js";

export type GenerateFn = (
  prompt: string,
  opts: { maxTokens: number; temperature: number; stopTokens: string[] }
) => AsyncIterable<string>;

export function renderPrompt(messages: Message[], preset: ModelPreset): string {
  // A prompt must never open with a bare model turn: Gemma 3 degenerates into
  // a repetition loop when it starts generating with zero user context, so an
  // empty history gets a placeholder user turn instead.
  const safe = messages.length > 0 ? messages : [{ role: "user" as const, content: "" }];
  if (preset.chatTemplate === "gemma") {
    const parts: string[] = [];
    for (const message of safe) {
      const role = message.role === "assistant" ? "model" : message.role;
      parts.push(`<start_of_turn>${role}\n${message.content}<end_of_turn>\n`);
    }
    parts.push("<start_of_turn>model\n");
    return parts.join("");
  }
  return safe.map((m) => `${m.role}: ${m.content}`).join("\n") + "\nassistant:";
}

interface StreamerLike {
  put(value: unknown): void;
  end(): void;
}

type TextGenerator = (
  prompt: string,
  opts: {
    max_new_tokens: number;
    temperature: number;
    do_sample: boolean;
    streamer: StreamerLike;
  }
) => Promise<unknown>;

export interface TransformersPipelineOptions {
  /** Directory `@huggingface/transformers` uses to cache (and read) model files. */
  cache_dir?: string;
  /**
   * Weight variant to load. T3OS downloads and verifies the Q4 quantized
   * build only; without this, Transformers.js defaults to fp32 and tries to
   * resolve `onnx/decoder_model_merged.onnx` — the unquantized 16 GB graph.
   */
  dtype?: string;
  /**
   * Skip the network entirely. Only set once the model files are verified
   * reachable in the local cache, so an installed model loads straight from
   * disk instead of re-downloading, while a missing model can still fetch.
   */
  local_files_only?: boolean;
}

export interface TransformersModule {
  pipeline(
    task: string,
    modelId: string,
    options?: TransformersPipelineOptions
  ): Promise<TextGenerator>;
  TextStreamer?: unknown;
}

export type TransformersLoader = () => Promise<TransformersModule>;

/** Errors that indicate a gated/private Hugging Face repo the caller lacks access to. */
const GATED_MODEL_PATTERN = /unauthorized|401|403|forbidden|gated|access denied/i;

/**
 * Errors that indicate the repo lacks ONNX weights. Transformers.js is an
 * ONNX runtime and resolves weights from the repo's `onnx/` subfolder, which
 * standard safetensors-only checkpoints do not provide.
 */
const MISSING_ONNX_PATTERN =
  /could not locate file.*\.onnx|entry not found.*\.onnx|404.*\.onnx|could not locate file:/i;

/**
 * Formats a model-loading failure. Gated repositories (e.g. Gemma) surface as
 * `Unauthorized`/401/403 responses; for those we add guidance for accepting the
 * license and configuring an access token. Missing ONNX weights (a raw
 * safetensors-only repo handed to Transformers.js) get guidance pointing at the
 * ONNX-converted repository instead.
 */
function formatModelLoadError(modelId: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const base = `Failed to load model ${modelId} for local inference: ${message}`;
  if (GATED_MODEL_PATTERN.test(message)) {
    return new Error(
      `${base}\n` +
        `${modelId} is a gated model on the Hugging Face Hub. Accept the license terms at ` +
        `https://huggingface.co/${modelId} and authenticate with an access token, then run ` +
        "`t3os auth login` (or `t3os auth set <token>`) to continue."
    );
  }
  if (MISSING_ONNX_PATTERN.test(message)) {
    const onnxRepo = resolveLocalModelId(modelId);
    const suggestion =
      onnxRepo !== modelId
        ? `Use the ONNX-converted repository "${onnxRepo}" instead, or verify that ` +
          `https://huggingface.co/${modelId} provides ONNX weights under its onnx/ folder.`
        : `Verify that https://huggingface.co/${modelId} provides ONNX weights under its ` +
          `onnx/ folder — Transformers.js cannot load safetensors-only checkpoints.`;
    return new Error(
      `${base}\n` +
        `Transformers.js runs models via ONNX and requires ONNX model files (e.g. ` +
        `onnx/embed_tokens_q4.onnx), which ${modelId} does not provide. ${suggestion}`
    );
  }
  return new Error(base);
}

interface CacheResolution {
  /** Directory handed to `@huggingface/transformers` as `cache_dir`, when known. */
  cacheDir?: string | undefined;
  /**
   * True when the model's files are verified reachable at the flat
   * `${cacheRoot}/${resolvedId}` path Transformers.js reads — the signal to
   * pass `local_files_only: true` so nothing is re-downloaded.
   */
  localFilesOnly: boolean;
}

/**
 * Resolves the cache directory handed to `@huggingface/transformers`. An
 * explicit `cacheDir` always wins; otherwise a model already present in the
 * local Hugging Face hub cache is used so loading works without a round trip.
 * Both the raw model ID and its ONNX-converted equivalent are checked, since
 * the pipeline loads the resolved ONNX repo's files.
 *
 * Before returning, the flat `${hubDir}/${resolvedId}` path that
 * `FileCache.resolve`s against `cache_dir` is linked to the installed
 * snapshot (`ensureFlatCacheLink`), and `localFilesOnly` is only reported
 * once that flat path holds a complete install — a legacy cache stored under
 * a different repo id still falls back to downloading rather than failing
 * offline.
 */
async function resolveCacheDir(
  modelId: string,
  explicitCacheDir?: string
): Promise<CacheResolution> {
  const resolvedId = resolveLocalModelId(modelId);
  const cacheRoot = explicitCacheDir ?? join(homedir(), ".cache", "huggingface", "hub");

  let installedPath: string | undefined;
  // The pipeline loads `resolvedId`, so prefer a cache it can actually read.
  for (const candidate of [resolvedId, modelId]) {
    const status = await checkLocalModelInstalled(candidate, explicitCacheDir);
    if (status.isInstalled) {
      installedPath = status.path;
      break;
    }
  }

  if (explicitCacheDir) {
    const localFilesOnly = installedPath
      ? await ensureFlatCacheLink(explicitCacheDir, resolvedId)
      : false;
    return { cacheDir: explicitCacheDir, localFilesOnly };
  }

  if (!installedPath) return { localFilesOnly: false };

  // `FileCache` reads `${cache_dir}/org/repo/file`, so the hub root (both the
  // `models--…` and the flat `org/repo` layouts live under it) is the right
  // `cache_dir`; caches elsewhere keep the previous default-cache behaviour.
  const cacheDir = installedPath.startsWith(cacheRoot + sep) ? cacheRoot : undefined;
  const localFilesOnly = await ensureFlatCacheLink(cacheRoot, resolvedId);
  return { cacheDir, localFilesOnly };
}

/**
 * Default loader. The specifier is a variable so that Node resolves
 * `@huggingface/transformers` at runtime using ESM module resolution relative
 * to this package (from `dist/provider/local.js` up to
 * `packages/core/node_modules`), rather than bundling it at build time.
 */
async function defaultTransformersLoader(): Promise<TransformersModule> {
  const specifier = "@huggingface/transformers";
  return (await import(specifier)) as unknown as TransformersModule;
}

/**
 * Weight variant T3OS targets for local inference. The model downloader only
 * fetches the Q4 files (`decoder_model_merged_q4.onnx`, `embed_tokens_q4.onnx`
 * plus their `.onnx_data` shards), so the pipeline must be told to resolve that
 * same variant — Transformers.js otherwise defaults to fp32.
 */
export const LOCAL_MODEL_DTYPE = "q4";

async function transformersGenerate(
  modelId: string,
  loadTransformers: TransformersLoader,
  options: { token?: string | undefined; cacheDir?: string | undefined } = {}
): Promise<GenerateFn> {
  if (options.token) {
    // `@huggingface/transformers` reads this env var when fetching gated models.
    process.env.HF_TOKEN = options.token;
  }
  let mod: TransformersModule;
  try {
    mod = await loadTransformers();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load @huggingface/transformers for local inference: ${msg}. ` +
      `Ensure @huggingface/transformers is installed or configure an active local runtime.`
    );
  }
  const { cacheDir, localFilesOnly } = await resolveCacheDir(modelId, options.cacheDir);
  // Transformers.js resolves weights from the repo's `onnx/` subfolder, so
  // map to the ONNX-converted repository when the canonical repo lacks one.
  const resolvedId = resolveLocalModelId(modelId);
  let generator: TextGenerator;
  try {
    // `dtype` must match the files the downloader fetched: T3OS installs the
    // Q4 quantized build, and the default (fp32) would look for the unquantized
    // `decoder_model_merged.onnx` instead. `local_files_only` (only set once
    // the local cache is verified complete) stops Transformers.js from
    // re-downloading files that are already on disk.
    generator = await mod.pipeline("text-generation", resolvedId, {
      ...(cacheDir ? { cache_dir: cacheDir } : {}),
      ...(localFilesOnly ? { local_files_only: true } : {}),
      dtype: LOCAL_MODEL_DTYPE,
    });
  } catch (err) {
    throw formatModelLoadError(modelId, err);
  }
  return async function* generate(prompt, opts) {
    const queue: string[] = [];
    let generatorError: unknown = null;

    let streamer: StreamerLike;
    const useTextStreamer = Boolean(mod.TextStreamer && (generator as any).tokenizer);
    if (useTextStreamer) {
      const TextStreamerClass = mod.TextStreamer as any;
      const tokenizer = (generator as any).tokenizer;
      let origEnd: (() => void) | undefined;
      const textStreamer: any = new TextStreamerClass(tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (chunk: string) => {
          if (typeof chunk === "string" && chunk.length > 0) {
            queue.push(chunk);
          }
        }
      });
      origEnd = textStreamer.end.bind(textStreamer);
      streamer = {
        put(value: unknown) {
          // TextStreamer handles token decoding internally via callback
          textStreamer.put(value);
        },
        end() {
          if (origEnd) origEnd();
          queue.push("\u0000");
        }
      };
    } else {
      streamer = {
        put(value: unknown) {
          if (typeof value === "string" && value.length > 0) {
            queue.push(value);
          }
          // Ignore non-string values (including bigint arrays) from raw generators
        },
        end() {
          queue.push("\u0000");
        }
      };
    }

    const outcome = generator(prompt, {
      max_new_tokens: opts.maxTokens,
      temperature: opts.temperature,
      do_sample: opts.temperature > 0,
      streamer
    })
      .then((output: any) => {
        if (queue.length === 0 && output) {
          const text = Array.isArray(output) && output[0]?.generated_text
            ? output[0].generated_text
            : typeof output === "string"
              ? output
              : "";
          if (text) {
            const answer = text.startsWith(prompt) ? text.slice(prompt.length) : text;
            if (answer) queue.push(answer);
          }
        }
        if (!queue.includes("\u0000")) {
          queue.push("\u0000");
        }
      })
      .catch((err) => {
        generatorError = err;
        if (!queue.includes("\u0000")) {
          queue.push("\u0000");
        }
      });

    for (;;) {
      if (queue.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      const next = queue.shift()!;
      if (generatorError !== null && queue.length === 0 && next === "\u0000") {
        throw generatorError;
      }
      if (next === "\u0000") return;
      if (typeof next === "string") {
        // Stop tokens (e.g. `<end_of_turn>`) must terminate generation:
        // anything from the token onward is model scaffolding, and letting it
        // through — or continuing past it — feeds repetition loops back to the
        // renderer. Trim at the earliest stop token and end the stream.
        let toYield = next;
        let stopFound = false;
        if (Array.isArray(opts.stopTokens)) {
          for (const stop of opts.stopTokens) {
            const idx = toYield.indexOf(stop);
            if (idx !== -1) {
              toYield = toYield.slice(0, idx);
              stopFound = true;
            }
          }
        }
        if (toYield.length > 0) yield toYield;
        if (stopFound) return;
      }
      // Skip non-string values (defensive)
    }
  };
}

export interface LocalProviderOptions {
  modelId: string;
  generate?: GenerateFn;
  contextLength?: number;
  /** Overrides how `@huggingface/transformers` is loaded; mainly for testing. */
  loadTransformers?: TransformersLoader;
  /**
   * Hugging Face access token. Gated models (e.g. Gemma) require an
   * authenticated request even for local inference; when provided it is
   * mirrored onto `process.env.HF_TOKEN`, which `@huggingface/transformers`
   * reads when fetching files from the Hugging Face Hub.
   */
  token?: string | undefined;
  /** Cache directory for `@huggingface/transformers` model files. */
  cacheDir?: string | undefined;
}

export class LocalProvider implements Provider {
  readonly id = "local";
  readonly #modelId: string;
  readonly #preset: ModelPreset;
  readonly #contextLength: number;
  readonly #loadTransformers: TransformersLoader;
  readonly #token: string | undefined;
  readonly #cacheDir: string | undefined;
  #generate: GenerateFn | undefined;

  constructor(options: LocalProviderOptions) {
    this.#modelId = options.modelId;
    this.#preset = resolvePreset(options.modelId);
    this.#contextLength = options.contextLength ?? this.#preset.contextLength;
    this.#generate = options.generate;
    this.#loadTransformers = options.loadTransformers ?? defaultTransformersLoader;
    this.#token = options.token;
    this.#cacheDir = options.cacheDir;
    if (this.#token) {
      process.env.HF_TOKEN = this.#token;
    }
  }

  capabilities(): ProviderCapabilities {
    return { toolCalling: false, streaming: true, contextLength: this.#contextLength };
  }

  async #load(): Promise<GenerateFn> {
    const existing = this.#generate;
    if (existing) return existing;
    const built = await transformersGenerate(this.#modelId, this.#loadTransformers, {
      token: this.#token,
      cacheDir: this.#cacheDir,
    });
    this.#generate = built;
    return built;
  }

  async *streamChat(
    messages: Message[],
    _tools: ToolSchema[],
    opts?: StreamOptions
  ): AsyncIterable<Delta> {
    const generate = await this.#load();
    const prompt = renderPrompt(messages, this.#preset);
    const iterator = generate(prompt, {
      maxTokens: opts?.maxTokens ?? this.#preset.maxTokens,
      temperature: opts?.temperature ?? this.#preset.temperature,
      stopTokens: this.#preset.stopTokens
    });
    for await (const text of iterator) {
      if (opts?.signal?.aborted) throw new Error("aborted");
      if (text.length > 0) yield { type: "text", text };
    }
    yield { type: "done" };
  }
}
