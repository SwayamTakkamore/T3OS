import type { Delta, Message, ToolSchema } from "../types.js";

export interface ProviderCapabilities {
  toolCalling: boolean;
  streaming: boolean;
  contextLength: number;
}

export interface StreamOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

export interface Provider {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  streamChat(
    messages: Message[],
    tools: ToolSchema[],
    opts?: StreamOptions
  ): AsyncIterable<Delta>;
}
