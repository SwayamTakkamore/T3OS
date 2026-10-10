import { T3osError } from "../errors.js";
import type { Delta, Message, ToolSchema } from "../types.js";
import { sseLines } from "./sse.js";
import type { Provider, ProviderCapabilities, StreamOptions } from "./types.js";

export interface HuggingFaceProviderOptions {
  model: string;
  token: string;
  baseUrl?: string;
  contextLength?: number;
  fetchImpl?: typeof fetch;
}

interface ChatChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class HuggingFaceProvider implements Provider {
  readonly id = "hf";
  readonly #opts: Required<Pick<HuggingFaceProviderOptions, "model" | "token">> &
    HuggingFaceProviderOptions;
  readonly #fetch: typeof fetch;

  constructor(options: HuggingFaceProviderOptions) {
    this.#opts = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  capabilities(): ProviderCapabilities {
    return {
      toolCalling: true,
      streaming: true,
      contextLength: this.#opts.contextLength ?? 8192
    };
  }

  async *streamChat(
    messages: Message[],
    tools: ToolSchema[],
    opts?: StreamOptions
  ): AsyncIterable<Delta> {
    const base = this.#opts.baseUrl ?? "https://api-inference.huggingface.co/v1";
    const body: Record<string, unknown> = {
      model: this.#opts.model,
      messages,
      stream: true
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
    }
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;

    const response = await this.#fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#opts.token}`
      },
      body: JSON.stringify(body),
      signal: opts?.signal ?? null
    });

    if (!response.ok) {
      throw new T3osError("provider", `HuggingFace request failed: ${response.status}`);
    }
    if (!response.body) {
      throw new T3osError("provider", "HuggingFace response had no body");
    }

    const openCallIds = new Map<number, string>();
    for await (const event of sseLines(response.body)) {
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(event.data) as ChatChunk;
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) yield { type: "text", text: delta.content };
      for (const call of delta?.tool_calls ?? []) {
        if (call.id && call.function?.name) {
          openCallIds.set(call.index, call.id);
          yield { type: "tool_call_start", id: call.id, name: call.function.name };
        }
        const args = call.function?.arguments;
        const resolvedId = call.id ?? openCallIds.get(call.index);
        if (args && resolvedId) {
          yield { type: "tool_call_delta", id: resolvedId, argsJsonDelta: args };
        }
      }
      if (choice?.finish_reason === "tool_calls") {
        for (const openId of openCallIds.values()) yield { type: "tool_call_end", id: openId };
        openCallIds.clear();
      }
      if (chunk.usage) {
        yield {
          type: "usage",
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0
        };
      }
    }
    yield { type: "done" };
  }
}
