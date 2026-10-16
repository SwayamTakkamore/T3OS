import { basename, dirname } from "node:path";
import { resolvePreset, type ModelPreset } from "../presets/index.js";
import type { Delta, Message, ToolSchema } from "../types.js";
import { checkLocalModelInstalled } from "./localModel.js";
import type { Provider, ProviderCapabilities, StreamOptions } from "./types.js";

export type GenerateFn = (
  prompt: string,
  opts: { maxTokens: number; temperature: number; stopTokens: string[] }
) => AsyncIterable<string>;

export function renderPrompt(messages: Message[], preset: ModelPreset): string {
  if (preset.chatTemplate === "gemma") {
    const parts: string[] = [];
    for (const message of messages) {
      const role = message.role === "assistant" ? "model" : message.role;
      parts.push(`<start_of_turn>${role}\n${message.content}<end_of_turn>\n`);
    }
    parts.push("<start_of_turn>model\n");
    return parts.join("");
  }
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n") + "\nassistant:";
}

interface StreamerLike {
  put(value: string): void;
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
}

export interface TransformersModule {
  pipeline(
    task: string,
    modelId: string,
    options?: TransformersPipelineOptions
  ): Promise<TextGenerator>;
}

export type TransformersLoader = () => Promise<TransformersModule>;

/** Errors that indicate a gated/private Hugging Face repo the caller lacks access to. */
const GATED_MODEL_PATTERN = /unauthorized|401|403|forbidden|gated|access denied/i;

/**
 * Formats a model-loading failure. Gated repositories (e.g. Gemma) surface as
 * `Unauthorized`/401/403 responses; for those we add guidance for accepting the
 * license and configuring an access token.
 */
function formatModelLoadError(modelId: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const base = `Failed to load model ${modelId} for local inference: ${message}`;
  if (!GATED_MODEL_PATTERN.test(message)) return new Error(base);
  return new Error(
    `${base}\n` +
      `${modelId} is a gated model on the Hugging Face Hub. Accept the license terms at ` +
      `https://huggingface.co/${modelId} and authenticate with an access token, then run ` +
      "`t3os auth login` (or `t3os auth set <token>`) to continue."
  );
}

/**
 * Resolves the cache directory handed to `@huggingface/transformers`. An
 * explicit `cacheDir` always wins; otherwise a model already present in the
 * local Hugging Face hub cache is used so loading works without a round trip.
 */
async function resolveCacheDir(
  modelId: string,
  explicitCacheDir?: string
): Promise<string | undefined> {
  if (explicitCacheDir) return explicitCacheDir;
  const status = await checkLocalModelInstalled(modelId);
  if (!status.isInstalled) return undefined;
  return basename(status.path).startsWith("models--") ? dirname(status.path) : undefined;
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
  const cacheDir = await resolveCacheDir(modelId, options.cacheDir);
  let generator: TextGenerator;
  try {
    generator = await mod.pipeline(
      "text-generation",
      modelId,
      cacheDir ? { cache_dir: cacheDir } : undefined
    );
  } catch (err) {
    throw formatModelLoadError(modelId, err);
  }
  return async function* generate(prompt, opts) {
    const queue: string[] = [];
    const streamer: StreamerLike = {
      put(value: string) {
        queue.push(value);
      },
      end() {
        queue.push("\u0000");
      }
    };
    const outcome = generator(prompt, {
      max_new_tokens: opts.maxTokens,
      temperature: opts.temperature,
      do_sample: opts.temperature > 0,
      streamer
    });
    void outcome;
    for (;;) {
      if (queue.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      const next = queue.shift()!;
      if (next === "\u0000") return;
      yield next;
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
