import { resolvePreset, type ModelPreset } from "../presets/index.js";
import type { Delta, Message, ToolSchema } from "../types.js";
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

interface TransformersModule {
  pipeline(task: string, modelId: string): Promise<TextGenerator>;
}

async function transformersGenerate(modelId: string): Promise<GenerateFn> {
  const specifier = "@huggingface/transformers";
  let mod: TransformersModule;
  try {
    mod = (await import(specifier)) as unknown as TransformersModule;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load @huggingface/transformers for local inference: ${msg}. ` +
      `Ensure @huggingface/transformers is installed or configure an active local runtime.`
    );
  }
  const generator = await mod.pipeline("text-generation", modelId);
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
}

export class LocalProvider implements Provider {
  readonly id = "local";
  readonly #modelId: string;
  readonly #preset: ModelPreset;
  readonly #contextLength: number;
  #generate: GenerateFn | undefined;

  constructor(options: LocalProviderOptions) {
    this.#modelId = options.modelId;
    this.#preset = resolvePreset(options.modelId);
    this.#contextLength = options.contextLength ?? this.#preset.contextLength;
    this.#generate = options.generate;
  }

  capabilities(): ProviderCapabilities {
    return { toolCalling: false, streaming: true, contextLength: this.#contextLength };
  }

  async #load(): Promise<GenerateFn> {
    const existing = this.#generate;
    if (existing) return existing;
    const built = await transformersGenerate(this.#modelId);
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
