import type { Delta, Message, ToolSchema } from "../types.js";
import type { Provider, ProviderCapabilities, StreamOptions } from "./types.js";

export class MockProvider implements Provider {
  readonly id = "mock";
  #scripts: Delta[][];
  #capabilities: ProviderCapabilities;

  constructor(scripts: Delta[][], capabilities?: Partial<ProviderCapabilities>) {
    this.#scripts = [...scripts];
    this.#capabilities = {
      toolCalling: true,
      streaming: true,
      contextLength: 8192,
      ...capabilities
    };
  }

  capabilities(): ProviderCapabilities {
    return this.#capabilities;
  }

  async *streamChat(
    _messages: Message[],
    _tools: ToolSchema[],
    opts?: StreamOptions
  ): AsyncIterable<Delta> {
    const script = this.#scripts.shift() ?? [{ type: "done" } as Delta];
    for (const delta of script) {
      if (opts?.signal?.aborted) throw new Error("aborted");
      yield delta;
    }
  }
}
